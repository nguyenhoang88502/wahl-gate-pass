#!/usr/bin/env node
// Gọi DeepSeek API để sinh khung code từ SPEC.md + context files.
// Dùng: node tools/deepseek_worker.mjs --task "<mô tả>" --out <path> --context docs/SPEC.md,<file1>,<file2>
// Node 18+, không dependency ngoài.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { context: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--task-file') args.taskFile = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--context') args.context = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-tokens') args.maxTokens = Number(argv[++i]);
  }
  return args;
}

function loadEnvLocal() {
  const envPath = resolve(__dirname, '.env.local');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  const keyFile = process.env.DEEPSEEK_KEY_FILE;
  if (keyFile && existsSync(keyFile)) {
    const raw = readFileSync(keyFile, 'utf8').trim();
    if (raw) return raw;
  }
  throw new Error(
    'Khong tim thay DeepSeek API key. Dat DEEPSEEK_API_KEY hoac DEEPSEEK_KEY_FILE trong tools/.env.local'
  );
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) return fenceMatch[1];
  return trimmed;
}

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  if (args.taskFile) {
    const p = resolve(process.cwd(), args.taskFile);
    if (!existsSync(p)) {
      console.error(`Khong tim thay task file: ${args.taskFile}`);
      process.exit(1);
    }
    args.task = readFileSync(p, 'utf8');
  }
  if (!args.task || !args.out) {
    console.error('Thieu --task/--task-file hoac --out. Xem huong dan trong docs/SPEC.md Pha 1.');
    process.exit(1);
  }

  const apiKey = getApiKey();
  const model = process.env.DEEPSEEK_MODEL && process.env.DEEPSEEK_MODEL.trim() ? process.env.DEEPSEEK_MODEL.trim() : 'deepseek-chat';

  const contextParts = [];
  for (const rel of args.context) {
    const p = resolve(process.cwd(), rel);
    if (!existsSync(p)) {
      console.error(`Canh bao: khong tim thay context file ${rel}, bo qua.`);
      continue;
    }
    const content = readFileSync(p, 'utf8');
    contextParts.push(`----- FILE: ${rel} -----\n${content}`);
  }

  const systemPrompt =
    'Ban la lap trinh vien sinh khung code (boilerplate) cho mot du an Google Apps Script + HTML/CSS/JS thuan. ' +
    'Chi tra ve NOI DUNG FILE duoc yeu cau, khong giai thich, khong markdown code fence, khong them loi dan. ' +
    'Bam sat SPEC.md ve ten action, ten field, ten cot Sheet, ma trang thai. ' +
    'Khong bao gio dua du lieu that (ten nhan vien, chu ky, mat khau) vao code mau. ' +
    'Danh dau cac cho chua chac chan bang comment "// TODO(review)".';

  const userPrompt = `${contextParts.join('\n\n')}\n\n----- YEU CAU -----\n${args.task}\n\nChi tra ve noi dung file dich, khong giai thich, khong markdown fence.`;

  const body = {
    model,
    stream: false,
    temperature: 0.2,
    max_tokens: args.maxTokens || 8000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  let resp;
  try {
    resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Loi goi DeepSeek API (mang/ket noi).');
    process.exit(1);
  }

  if (!resp.ok) {
    let msg = `DeepSeek API tra loi ${resp.status}`;
    console.error(msg);
    process.exit(1);
  }

  const json = await resp.json();
  const choice = json.choices && json.choices[0];
  if (!choice) {
    console.error('DeepSeek API khong tra ve noi dung.');
    process.exit(1);
  }

  if (choice.finish_reason === 'length') {
    console.error(
      `Loi: noi dung bi cat (finish_reason=length) cho file ${args.out}. KHONG ghi file. ` +
        'Hay chia nho task hoac giam pham vi file dich (toi da ~350 dong).'
    );
    process.exit(1);
  }

  const content = stripCodeFence(choice.message.content || '');
  if (!content.trim()) {
    console.error('Noi dung tra ve rong, khong ghi file.');
    process.exit(1);
  }

  const outPath = resolve(process.cwd(), args.out);
  writeFileSync(outPath, content, 'utf8');
  console.log(`Da ghi file: ${args.out} (${content.length} ky tu)`);
}

main().catch((err) => {
  console.error('Loi khong xac dinh khi chay deepseek_worker.');
  process.exit(1);
});
