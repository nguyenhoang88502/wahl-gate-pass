// tests/gas-stub.mjs
// Stub tối thiểu cho runtime Google Apps Script (SpreadsheetApp, DriveApp, LockService,
// Utilities, PropertiesService, ContentService, Logger) để chạy thử logic trong apps-script/*.gs
// bằng Node thuần (node:vm), không cần deploy lên Google.
//
// Giới hạn đã biết: đây là mô phỏng, không phải Apps Script thật. Một số hành vi (ví dụ khóa
// ghi đồng thời thực sự giữa nhiều tiến trình) không thể kiểm thử trung thực trong Node
// đơn luồng — LockService ở đây chỉ là no-op vì JS trong 1 process là single-threaded.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPS_SCRIPT_DIR = path.resolve(__dirname, '..', 'apps-script');

const GAS_FILES = ['Util.gs', 'Auth.gs', 'Users.gs', 'Requests.gs', 'Departments.gs', 'Security.gs', 'Setup.gs', 'Code.gs'];

const SHEET_TZ = 'Asia/Ho_Chi_Minh';

function tzParts(d, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d);
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  return m;
}

/** Date tương ứng giờ địa phương (y,mo,d,h,mi) ở múi giờ tz (2 vòng hiệu chỉnh offset). */
function localToDate(y, mo, d, h, mi, tz, DateCtor) {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(new Date(guess), tz);
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += target - shown;
  }
  return new (DateCtor || Date)(guess);
}

/**
 * Mô phỏng việc Google Sheets tự "đoán kiểu" khi ghi chuỗi (giống nhập tay):
 *  "'abc" -> 'abc' (text, bỏ dấu '), '00123' -> 123, '2026-10-02' -> Date, '08:30' -> Date (1899-12-30),
 *  'true'/'false' -> boolean. Nhờ vậy test bắt được lỗi đọc/ghi sai kiểu như trên Sheet thật.
 */
function coerceLikeSheets(v, realm) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return localToDate(+m[1], +m[2], +m[3], 0, 0, SHEET_TZ, realm && realm.Date);
  m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return localToDate(1899, 12, 30, +m[1], +m[2], SHEET_TZ, realm && realm.Date);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

function toSignedByteArray(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out.push(b > 127 ? b - 256 : b);
  }
  return out;
}

function fromSignedByteArray(arr) {
  const buf = Buffer.alloc(arr.length);
  for (let i = 0; i < arr.length; i++) {
    buf[i] = arr[i] < 0 ? arr[i] + 256 : arr[i];
  }
  return buf;
}

/** Sheet trong bộ nhớ: data[0] là header, data[1..] là dữ liệu. 1-based giống GAS. */
function makeSheetStub(name, store, realm) {
  return {
    getName: () => name,
    getLastRow: () => store.data.length,
    getLastColumn: () => (store.data[0] ? store.data[0].length : 0),
    getRange(r1, c1, numRows, numCols) {
      numRows = numRows === undefined ? 1 : numRows;
      numCols = numCols === undefined ? 1 : numCols;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const rowIdx = r1 - 1 + i;
            const row = store.data[rowIdx] || [];
            const slice = [];
            for (let j = 0; j < numCols; j++) {
              const v = row[c1 - 1 + j];
              slice.push(v === undefined ? '' : v);
            }
            out.push(slice);
          }
          return out;
        },
        getValue() {
          const row = store.data[r1 - 1] || [];
          const v = row[c1 - 1];
          return v === undefined ? '' : v;
        },
        setValue(val) {
          while (store.data.length <= r1 - 1) store.data.push([]);
          store.data[r1 - 1][c1 - 1] = coerceLikeSheets(val, realm);
        },
        setValues(values) {
          for (let i = 0; i < values.length; i++) {
            const rowIdx = r1 - 1 + i;
            while (store.data.length <= rowIdx) store.data.push([]);
            for (let j = 0; j < values[i].length; j++) {
              store.data[rowIdx][c1 - 1 + j] = coerceLikeSheets(values[i][j], realm);
            }
          }
        },
        clearContent() {
          for (let i = 0; i < numRows; i++) {
            const row = store.data[r1 - 1 + i];
            if (!row) continue;
            for (let j = 0; j < numCols; j++) row[c1 - 1 + j] = '';
          }
          // Sheet thật: getLastRow() = dòng cuối còn dữ liệu -> bỏ các dòng trống ở đuôi.
          while (store.data.length > 1 && store.data[store.data.length - 1].every((c) => c === '' || c === undefined)) {
            store.data.pop();
          }
        }
      };
    },
    appendRow(rowArr) {
      store.data.push(rowArr.map((v) => coerceLikeSheets(v, realm)));
    },
    deleteRow(rowIndex1Based) {
      store.data.splice(rowIndex1Based - 1, 1);
    }
  };
}

function makeSpreadsheetStub(sheetStores, realm) {
  const spreadsheet = {
    getSpreadsheetTimeZone: () => SHEET_TZ,
    getSheetByName(name) {
      if (!sheetStores.has(name)) return null;
      return makeSheetStub(name, sheetStores.get(name), realm);
    },
    insertSheet(name) {
      sheetStores.set(name, { data: [] });
      return makeSheetStub(name, sheetStores.get(name), realm);
    }
  };
  return {
    getActiveSpreadsheet: () => spreadsheet
  };
}

function makeDriveStub(driveFiles, driveFolders) {
  let fileSeq = 1;
  let folderSeq = 1;

  function folderObj(id) {
    return {
      getId: () => id,
      isTrashed: () => false,
      createFile(blob) {
        const id2 = 'file_' + fileSeq++;
        driveFiles.set(id2, {
          bytes: blob.getBytes(),
          mime: blob.getContentType(),
          name: blob.getName ? blob.getName() : ''
        });
        return {
          getId: () => id2
        };
      }
    };
  }

  return {
    getFolderById(id) {
      if (!driveFolders.has(id)) {
        throw new Error('Folder not found: ' + id);
      }
      return folderObj(id);
    },
    getFoldersByName(name) {
      const matches = [...driveFolders.entries()].filter(([, n]) => n === name);
      let idx = 0;
      return {
        hasNext: () => idx < matches.length,
        next: () => folderObj(matches[idx++][0])
      };
    },
    createFolder(name) {
      const id = 'folder_' + folderSeq++;
      driveFolders.set(id, name);
      return folderObj(id);
    },
    getFileById(id) {
      const f = driveFiles.get(id);
      if (!f) throw new Error('File not found: ' + id);
      return {
        getBlob() {
          return {
            getBytes: () => f.bytes,
            getContentType: () => f.mime
          };
        }
      };
    }
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Hỗ trợ 'yyyy-MM-dd' và 'HH:mm' — 2 pattern dùng trong apps-script/*.gs. */
function formatDateStub(date, tz, fmt) {
  const d = date instanceof Date ? date : new Date(date);
  if (fmt === 'HH:mm') {
    const p = tzParts(d, tz || 'UTC');
    return `${p.hour}:${p.minute}`;
  }
  if (fmt === 'yyyy-MM-dd') {
    // Xấp xỉ: dùng Intl với timezone được yêu cầu (mặc định Asia/Ho_Chi_Minh trong code thật).
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  }
  return d.toISOString();
}

export function createGasEnv(scriptProps = {}) {
  const sheetStores = new Map();
  const driveFiles = new Map();
  const driveFolders = new Map();
  const properties = { ...scriptProps };
  const logs = [];
  const cacheStore = new Map();
  // Date phải được tạo bằng constructor CỦA sandbox, nếu không `x instanceof Date` trong .gs sẽ sai.
  const realm = { Date };

  const sandbox = {
    console,
    CacheService: {
      getScriptCache() {
        return {
          get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
          put: (k, v) => { cacheStore.set(k, String(v)); },
          remove: (k) => { cacheStore.delete(k); }
        };
      }
    },
    SpreadsheetApp: makeSpreadsheetStub(sheetStores, realm),
    DriveApp: makeDriveStub(driveFiles, driveFolders),
    LockService: {
      getScriptLock() {
        return {
          waitLock() {},
          releaseLock() {}
        };
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty: (key) => (Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null),
          setProperty: (key, val) => {
            properties[key] = val;
          }
        };
      }
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (algo, str) => {
        const buf = crypto.createHash('sha256').update(String(str), 'utf8').digest();
        return toSignedByteArray(buf);
      },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      base64Encode: (bytes) => {
        if (Array.isArray(bytes)) return fromSignedByteArray(bytes).toString('base64');
        return Buffer.from(String(bytes), 'utf8').toString('base64');
      },
      base64Decode: (str) => toSignedByteArray(Buffer.from(String(str), 'base64')),
      newBlob: (bytes, mime, name) => ({
        getBytes: () => (Array.isArray(bytes) ? bytes : toSignedByteArray(Buffer.from(String(bytes)))),
        getContentType: () => mime,
        getName: () => name
      }),
      formatDate: formatDateStub
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput(str) {
        const out = {
          _content: str,
          setMimeType() {
            return out;
          },
          getContent() {
            return out._content;
          }
        };
        return out;
      }
    },
    Logger: {
      log: (...args) => logs.push(args.join(' '))
    }
  };

  const ctx = createContext(sandbox);
  realm.Date = runInContext('Date', ctx);

  for (const file of GAS_FILES) {
    const full = path.join(APPS_SCRIPT_DIR, file);
    const src = readFileSync(full, 'utf8');
    runInContext(src, ctx, { filename: file });
  }

  return {
    ctx,
    logs,
    sheetStores,
    driveFiles,
    driveFolders,
    properties,
    cacheStore,
    /** Gọi doPost(e) giống Web App thật, trả về {ok, data, error} đã parse JSON. */
    callApi(action, token, payload) {
      const e = { postData: { contents: JSON.stringify({ action, token: token || null, payload: payload || {} }) } };
      const out = ctx.doPost(e);
      return JSON.parse(out.getContent());
    },
    /** Chạy hàm bất kỳ đã định nghĩa trong context (vd. setup(), sha256Hash(...)). */
    run(fnName, ...args) {
      return ctx[fnName](...args);
    },
    getSheetData(name) {
      const store = sheetStores.get(name);
      return store ? store.data : null;
    }
  };
}

/** Helper: tạo env đã setup() xong với ADMIN_INITIAL_PASSWORD cho sẵn. */
export function createReadyGasEnv(adminInitialPassword = 'AdminTmp123') {
  const env = createGasEnv({ ADMIN_INITIAL_PASSWORD: adminInitialPassword });
  env.run('setup');
  return env;
}

/** Helper: thêm 1 user trực tiếp vào sheet Users (bỏ qua flow register/activate) để test nhanh. */
export function seedUser(env, { username, fullName = username, emplId, dept = '', role, email = '', password, status = 'ACTIVE' }) {
  const salt = env.run('newUuid');
  const hash = env.run('sha256Hash', password, salt, 1000);
  const sheet = env.ctx.getSheet('Users');
  env.ctx.appendRowObject(sheet, {
    Username: username,
    FullName: fullName,
    EmplId: emplId || username.toUpperCase(),
    Dept: dept,
    Role: role,
    Email: email,
    PasswordHash: hash,
    Salt: salt,
    MustChangePw: false,
    Status: status,
    FailedCount: 0,
    LockedUntil: '',
    SigFileId: '',
    CreatedAt: new Date().toISOString(),
    ApprovedBy: 'SYSTEM',
    ApprovedAt: new Date().toISOString()
  });
}

/**
 * Helper: gán chữ ký giả cho 1 user đã có (cần SigFileId khác rỗng để được phép duyệt).
 * Đăng ký luôn 1 "file" giả trong driveFiles để fileIdToDataUrl() đọc lại được (không trả null).
 */
export function seedUserSignature(env, username, fileId) {
  const id = fileId || 'sig_' + username + '_' + Math.random().toString(36).slice(2);
  env.driveFiles.set(id, {
    bytes: [137, 80, 78, 71], // vài byte PNG giả, đủ để base64Encode hoạt động
    mime: 'image/png',
    name: id + '.png'
  });
  const sheet = env.ctx.getSheet('Users');
  const rowIndex = env.ctx.findRowIndexByColumn(sheet, 'Username', username);
  if (rowIndex < 0) throw new Error('seedUserSignature: user not found: ' + username);
  env.ctx.updateRowByIndex(sheet, rowIndex, { SigFileId: id });
  return id;
}

/** Helper: thêm 1 dòng Departments. */
export function seedDepartment(env, { dept, supervisorUsernames = '', managerUsername = '' }) {
  const sheet = env.ctx.getSheet('Departments');
  env.ctx.appendRowObject(sheet, { Dept: dept, SupervisorUsernames: supervisorUsernames, ManagerUsername: managerUsername });
}

/** Helper: đăng nhập và trả về token (throw nếu lỗi). */
export function loginAs(env, username, password) {
  const res = env.callApi('login', null, { username, password });
  if (!res.ok) throw new Error('loginAs failed for ' + username + ': ' + JSON.stringify(res.error));
  return res.data.token;
}

/** Ảnh PNG 1x1 base64 hợp lệ tối thiểu, dùng làm "chữ ký" giả trong test. */
export const FAKE_SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
