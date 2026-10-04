// assets/js/page-security.js — Dashboard bảo vệ (KHÔNG cần tài khoản, chỉ xem).
// Hiển thị ai đã được duyệt ra cổng hôm nay + ai đã duyệt từng bước. Tự làm mới mỗi 15 giây,
// tạm dừng khi tab bị ẩn để đỡ tốn tài nguyên.
import { callApi, renderMockBanner, clearStaleSessionData } from './api.js';
import { $, show, hide, toggle, escapeHtml, errMessage, todayYmd, formatDate, formatTime, approvalSteps } from './ui.js';

const REFRESH_MS = 15000;

let allRequests = [];
let names = {};
let filter = 'all';
let lastJson = '';
let timer = null;
let loading = false;
let lastOkAt = 0;

function group(status) {
  if (status === 'APPROVED' || status === 'OUT' || status === 'COMPLETED') return 'ok';
  if (status === 'REJECTED') return 'no';
  return 'wait';
}

const VERDICT = {
  APPROVED: ['ok', 'ĐƯỢC RA'],
  OUT: ['ok', 'ĐÃ RA CỔNG'],
  COMPLETED: ['done', 'ĐÃ VÀO LẠI'],
  REJECTED: ['no', 'KHÔNG ĐƯỢC RA'],
  PENDING_SUP: ['wait', 'CHƯA DUYỆT'],
  PENDING_MGR: ['wait', 'CHƯA DUYỆT'],
  PENDING_HR: ['wait', 'CHỜ HR DUYỆT']
};

function matches(r, q) {
  if (!q) return true;
  return [r.fullName, r.emplId, r.dept, r.requestId].some((v) => String(v || '').toLowerCase().indexOf(q) >= 0);
}

function approvalChip(step) {
  const cls = { done: 'appr--done', current: 'appr--wait', rejected: 'appr--no', skipped: '', waiting: '' }[step.state] || '';
  const icon = { done: '✓', current: '⏳', rejected: '✕', skipped: '–', waiting: '·' }[step.state] || '·';
  let detail = '';
  if (step.state === 'done') detail = step.meta;
  else if (step.state === 'current') detail = step.who ? 'chờ ' + step.who : 'đang chờ';
  else if (step.state === 'rejected') detail = 'từ chối' + (step.who ? ' · ' + step.who : '');
  else if (step.state === 'skipped') detail = 'dừng';
  else detail = step.who || 'chờ bước trước';
  return '<span class="appr ' + cls + '"><span class="appr__icon">' + icon + '</span><span>' +
    escapeHtml(step.title) + ' <small>' + escapeHtml(detail) + '</small></span></span>';
}

function cardHtml(r) {
  const v = VERDICT[r.status] || ['wait', r.status];
  const steps = approvalSteps(r, names).filter((s) => !(s.state === 'skipped' && s.meta.indexOf('Không có') === 0));
  const times = [];
  times.push('<span>Ra: <b>' + escapeHtml(r.comeOutPlanned || '—') + '</b></span>');
  times.push('<span>Vào: <b>' + escapeHtml(r.comeInPlanned || '—') + '</b></span>');
  if (r.guardOutAt) times.push('<span>Đã ra lúc <b>' + escapeHtml(formatTime(r.guardOutAt)) + '</b></span>');
  if (r.guardInAt) times.push('<span>Đã vào lúc <b>' + escapeHtml(formatTime(r.guardInAt)) + '</b></span>');
  const meta = [r.emplId, r.dept, r.requestId].filter(Boolean)
    .map((v) => '<span class="nowrap">' + escapeHtml(v) + '</span>').join(' · ');
  return '<article class="pass pass--' + v[0] + '" data-id="' + escapeHtml(r.requestId) + '">' +
    '<div><div class="pass__name">' + escapeHtml(r.fullName || '(chưa ghi tên)') + '</div>' +
    '<div class="pass__meta">' + meta + '</div></div>' +
    '<div class="pass__verdict">' + escapeHtml(v[1]) + '</div>' +
    '<div class="pass__times">' + times.join('') + '</div>' +
    '<div class="pass__approvals">' + steps.map(approvalChip).join('') + '</div>' +
    '</article>';
}

function render() {
  const q = $('search-box').value.trim().toLowerCase();
  const counts = { ok: 0, wait: 0, no: 0 };
  allRequests.forEach((r) => { counts[group(r.status)]++; });
  $('n-ok').textContent = counts.ok;
  $('n-wait').textContent = counts.wait;
  $('n-no').textContent = counts.no;
  $('n-all').textContent = allRequests.length;

  const list = allRequests.filter((r) => (filter === 'all' || group(r.status) === filter) && matches(r, q));
  $('request-list').innerHTML = list.map(cardHtml).join('');
  toggle($('empty-state'), list.length === 0);
  if (list.length === 0) {
    $('empty-text').textContent = allRequests.length
      ? 'Không có giấy phép phù hợp bộ lọc'
      : 'Chưa có giấy phép nào cho ngày này';
  }
}

function updateLiveStatus() {
  const el = $('live-status');
  if (!lastOkAt) return;
  const secs = Math.round((Date.now() - lastOkAt) / 1000);
  const stale = secs > REFRESH_MS / 1000 * 3;
  el.classList.toggle('is-stale', stale);
  el.textContent = 'Cập nhật ' + formatTime(new Date(lastOkAt).toISOString()) + (stale ? ' (mất kết nối?)' : '');
}

async function load() {
  if (loading) return;
  loading = true;
  // Máy để mở qua đêm -> tự chuyển sang ngày mới (trừ khi bảo vệ tự chọn ngày khác).
  if (!$('f-day').dataset.manual && $('f-day').value !== todayYmd()) {
    $('f-day').value = todayYmd();
    lastJson = '';
    setTitle();
  }
  const day = $('f-day').value || todayYmd();
  try {
    const data = await callApi('listToday', { date: day });
    hide($('load-error'));
    lastOkAt = Date.now();
    const json = JSON.stringify([data.requests, data.names]);
    if (json !== lastJson) {
      lastJson = json;
      allRequests = data.requests || [];
      names = data.names || {};
      render();
    }
  } catch (err) {
    const box = $('load-error');
    box.textContent = 'Không tải được dữ liệu: ' + errMessage(err);
    show(box);
    if (!allRequests.length) $('request-list').innerHTML = '';
  } finally {
    loading = false;
    updateLiveStatus();
  }
}

function setTitle() {
  const day = $('f-day').value || todayYmd();
  $('page-title').textContent = day === todayYmd() ? 'Giấy phép hôm nay · ' + formatDate(day) : 'Giấy phép ngày ' + formatDate(day);
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => { load(); }, REFRESH_MS);
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function initSecurityPage() {
  clearStaleSessionData();
  renderMockBanner();

  $('f-day').value = todayYmd();
  setTitle();

  document.querySelectorAll('.stat').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      document.querySelectorAll('.stat').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
  $('search-box').addEventListener('input', render);
  $('f-day').addEventListener('change', () => {
    lastJson = '';
    setTitle();
    $('request-list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    load();
  });
  $('btn-refresh').addEventListener('click', () => { lastJson = ''; load(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTimer();
    } else {
      load();
      startTimer();
    }
  });
  $('f-day').addEventListener('input', () => {
    if ($('f-day').value && $('f-day').value !== todayYmd()) $('f-day').dataset.manual = '1';
    else delete $('f-day').dataset.manual;
  });
  setInterval(updateLiveStatus, 5000);

  load();
  startTimer();
}
