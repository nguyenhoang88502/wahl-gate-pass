// assets/js/page-hr.js — Trang quản lý: đăng nhập, duyệt giấy phép, quản trị bộ phận / người dùng /
// cấu hình / nhật ký, tài khoản cá nhân. Mọi sự kiện được gắn MỘT lần khi tải trang (không gắn lại
// mỗi lần đăng nhập). Đăng xuất / hết phiên / không hoạt động 30 phút -> xoá sạch dữ liệu phiên.
import {
  MOCK_MODE, callApi, cachedCall, invalidateCache, getToken, setToken,
  clearAllSessionData, clearStaleSessionData, renderMockBanner
} from './api.js';
import { SignaturePad } from './signature-pad.js';
import { renderGatePassPdf } from './pdf.js';
import {
  $, show, hide, toggle, escapeHtml, errMessage, toast, dialog, confirmDialog, withBusy,
  todayYmd, formatDate, formatDateTime, statusBadgeHtml, reasonLabel, roleLabel,
  USER_STATUS_LABELS, ROLE_LABELS, approvalSteps, renderStepsHtml
} from './ui.js';

const STAFF_ROLES = ['hr', 'admin', 'manager', 'supervisor'];
const PENDING = ['PENDING_SUP', 'PENDING_MGR', 'PENDING_HR'];
const DEPT_OTHER = '__other__';
const IDLE_LOGOUT_MS = 30 * 60 * 1000;
const DEPT_CACHE_MS = 10 * 60 * 1000;

const state = {
  user: null,
  requests: [],
  names: {},
  chip: 'mine',
  chipAuto: true,
  selected: new Set(),
  modalRequest: null,
  users: [],
  usersLoaded: false,
  depts: [],
  deptNames: [],
  editingUser: null,
  editingDept: null,
  sigUpload: null,
  tab: 'requests'
};

let accSigPad = null;
let idleTimer = null;

// Chống "phản hồi cũ đè dữ liệu mới" khi cùng 1 danh sách được tải lại chồng nhau.
const loadSeq = {};
function beginLoad(key) { loadSeq[key] = (loadSeq[key] || 0) + 1; return loadSeq[key]; }
function isLatest(key, n) { return loadSeq[key] === n; }

// =====================================================================
// Tiện ích chung
// =====================================================================

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function initials(name, fallback) {
  const parts = String(name || fallback || '?').trim().split(/\s+/);
  const a = parts[parts.length - 1] || '?';
  return (a[0] || '?').toUpperCase();
}

function isStrongPw(pw) { return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw); }

function userByName(username) {
  const t = String(username || '').toLowerCase();
  return state.users.find((u) => u.username.toLowerCase() === t) || null;
}

/** Lỗi API: hết phiên -> về màn đăng nhập; còn lại -> toast. */
function handleError(err) {
  if (err && err.code === 'SESSION_EXPIRED') {
    resetSession();
    showAuth();
    toast('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại', 'warning');
    return;
  }
  toast(errMessage(err), 'error');
}

function openModal(id) { show($(id)); }
function closeModal(id) { hide($(id)); }

function tableHtml(head, rows, emptyText) {
  if (!rows.length) {
    return '<div class="table-wrap"><div class="empty-state"><div class="empty-state__icon">📭</div>' + escapeHtml(emptyText) + '</div></div>';
  }
  return '<div class="table-wrap"><table class="data-table"><thead><tr>' +
    head.map((h) => '<th' + (h.cls ? ' class="' + h.cls + '"' : '') + '>' + h.html + '</th>').join('') +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}

/** Gắn data-label (tên cột) cho từng ô để CSS hiển thị bảng dạng thẻ trên điện thoại. */
function labelCells(container) {
  const table = container.querySelector('table');
  if (!table) return;
  const labels = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach((tr) => {
    Array.from(tr.children).forEach((td, i) => { td.setAttribute('data-label', labels[i] || ''); });
  });
}

function setTable(id, html) {
  const el = $(id);
  el.innerHTML = html;
  labelCells(el);
}

function skeleton(n) {
  return Array.from({ length: n || 3 }, () => '<div class="skeleton"></div>').join('');
}

// ---------- Danh sách tên bộ phận (dùng cho mọi ô chọn bộ phận) ----------

function fillDeptSelect(select, current, opts) {
  const o = opts || {};
  select.innerHTML = '';
  select.appendChild(new Option(o.placeholder || '— Chọn bộ phận —', ''));
  const names = state.deptNames.slice();
  if (current && current !== DEPT_OTHER && names.map((n) => n.toLowerCase()).indexOf(current.toLowerCase()) < 0) names.push(current);
  names.forEach((n) => select.appendChild(new Option(n, n)));
  if (o.allowOther) select.appendChild(new Option('+ Bộ phận mới…', DEPT_OTHER));
  select.value = current || '';
}

async function loadDeptNames(force) {
  if (force) invalidateCache('getDepartments');
  try {
    await cachedCall('getDepartments', {}, DEPT_CACHE_MS, (data) => {
      state.deptNames = ((data && data.departments) || []).map((d) => d.dept);
      fillDeptSelect($('reg-dept'), $('reg-dept').value);
      fillDeptSelect($('flt-dept'), $('flt-dept').value, { placeholder: 'Tất cả' });
    });
  } catch (err) {
    // Không chặn trang nếu lỗi — vẫn dùng được các chức năng khác.
  }
}

// =====================================================================
// Đăng nhập / phiên
// =====================================================================

function showAuth() {
  hide($('dashboard-section'));
  hide($('force-change-section'));
  hide($('user-info'));
  hide($('btn-logout'));
  show($('auth-section'));
  setAuthTab('login');
  $('login-username').focus();
}

function setAuthTab(which) {
  const login = which === 'login';
  $('auth-tab-login').classList.toggle('active', login);
  $('auth-tab-register').classList.toggle('active', !login);
  toggle($('login-form'), login);
  toggle($('register-form'), !login);
  document.querySelector('.auth-head h1').textContent = login ? 'Đăng nhập' : 'Đăng ký tài khoản';
}

/** Xoá toàn bộ dữ liệu phiên trong bộ nhớ + trình duyệt. */
function resetSession() {
  clearAllSessionData();
  state.user = null;
  state.requests = [];
  state.names = {};
  state.users = [];
  state.usersLoaded = false;
  state.depts = [];
  state.selected.clear();
  state.chip = 'mine';
  state.chipAuto = true;
  state.modalRequest = null;
  ['requests-table', 'depts-table', 'all-users-list', 'pending-users-list', 'audit-log-list', 'account-info'].forEach((id) => { $(id).innerHTML = ''; });
  document.querySelectorAll('.modal-overlay').forEach((m) => hide(m));
  document.querySelectorAll('form').forEach((f) => f.reset());
  if (accSigPad) accSigPad.clear();
  $('acc-sig-current').removeAttribute('src');
  hide($('acc-sig-current'));
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function enter(user) {
  state.user = user;
  if (user.mustChangePw) {
    hide($('auth-section'));
    hide($('dashboard-section'));
    show($('force-change-section'));
    $('fc-old').focus();
    return;
  }
  showDashboard();
}

function renderUserChip() {
  const u = state.user;
  const chip = $('user-info');
  chip.innerHTML = '<span class="user-chip__avatar">' + escapeHtml(initials(u.fullName, u.username)) + '</span>' +
    '<span class="user-chip__name">' + escapeHtml(u.fullName || u.username) + '</span>' +
    '<span class="user-chip__role">' + escapeHtml(roleLabel(u.role)) + '</span>';
  show(chip);
  show($('btn-logout'));
}

function showDashboard() {
  const u = state.user;
  hide($('auth-section'));
  hide($('force-change-section'));
  show($('dashboard-section'));
  renderUserChip();

  const isAdmin = u.role === 'admin';
  const isStaff = STAFF_ROLES.indexOf(u.role) >= 0;
  document.querySelectorAll('.admin-only').forEach((el) => toggle(el, isAdmin));
  toggle(document.querySelector('.nav-tab[data-tab="requests"]'), isStaff);
  // Giám sát / trưởng BP chỉ thấy bộ phận của mình -> ẩn bộ lọc bộ phận.
  toggle($('flt-dept-wrap'), u.role === 'hr' || u.role === 'admin');

  $('flt-date-from').value = addDays(todayYmd(), -14);
  $('flt-date-to').value = addDays(todayYmd(), 30);
  updateSigWarning();
  bumpIdle();

  if (isStaff) {
    activateTab('requests');
    loadRequests();
  } else {
    activateTab('account');
    toast(u.role === 'security'
      ? 'Bảo vệ dùng trang "Bảo vệ cổng" (security.html) — không cần đăng nhập'
      : 'Tài khoản chưa được gán vai trò — liên hệ quản trị viên', 'info', 6000);
  }
  if (isAdmin) loadUsers(); // để có số tài khoản chờ kích hoạt
}

function updateSigWarning() {
  const u = state.user;
  toggle($('no-sig-warning'), !!u && STAFF_ROLES.indexOf(u.role) >= 0 && !u.hasSignature);
}

async function onLogin(evt) {
  evt.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const errEl = $('login-error');
  hide(errEl);
  if (!username || !password) {
    errEl.textContent = 'Vui lòng nhập tên đăng nhập và mật khẩu';
    show(errEl);
    return;
  }
  await withBusy($('btn-login'), async () => {
    try {
      const data = await callApi('login', { username, password });
      setToken(data.token);
      $('login-password').value = '';
      enter(data.user);
    } catch (err) {
      errEl.textContent = errMessage(err);
      show(errEl);
    }
  });
}

async function onRegister(evt) {
  evt.preventDefault();
  const v = (id) => $(id).value.trim();
  const errEl = $('register-error');
  const okEl = $('register-success');
  hide(errEl);
  hide(okEl);
  // Nhắc (đỏ) các trường còn trống; chỉ tên đăng nhập + mật khẩu là cần thiết thật sự.
  ['reg-fullname', 'reg-emplid', 'reg-dept', 'reg-email', 'reg-username', 'reg-password', 'reg-confirm'].forEach((id) => {
    document.querySelector('[data-key="' + id + '"]').classList.toggle('is-missing', !$(id).value.trim());
  });
  const fail = (msg) => { errEl.textContent = msg; show(errEl); };
  if (!v('reg-username')) return fail('Cần có tên đăng nhập');
  if (!isStrongPw($('reg-password').value)) return fail('Mật khẩu tối thiểu 8 ký tự, có cả chữ và số');
  if ($('reg-password').value !== $('reg-confirm').value) return fail('Mật khẩu nhập lại không khớp');
  if (v('reg-email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('reg-email'))) return fail('Email không hợp lệ');

  await withBusy($('btn-register'), async () => {
    try {
      const data = await callApi('register', {
        fullName: v('reg-fullname'), emplId: v('reg-emplid'), dept: $('reg-dept').value, email: v('reg-email'),
        username: v('reg-username'), password: $('reg-password').value, confirmPassword: $('reg-confirm').value,
        honeypot: $('reg-honeypot').value
      });
      $('register-form').reset();
      document.querySelectorAll('#register-form .is-missing').forEach((el) => el.classList.remove('is-missing'));
      okEl.textContent = (data && data.message) || 'Đã gửi đăng ký — chờ quản trị viên kích hoạt';
      show(okEl);
    } catch (err) {
      fail(errMessage(err));
    }
  });
}

async function onForceChange(evt) {
  evt.preventDefault();
  const errEl = $('force-change-error');
  hide(errEl);
  const oldPassword = $('fc-old').value;
  const newPassword = $('fc-new').value;
  const fail = (m) => { errEl.textContent = m; show(errEl); };
  if (!isStrongPw(newPassword)) return fail('Mật khẩu mới tối thiểu 8 ký tự, có cả chữ và số');
  if (newPassword !== $('fc-confirm').value) return fail('Mật khẩu nhập lại không khớp');
  if (newPassword === oldPassword) return fail('Mật khẩu mới phải khác mật khẩu tạm');
  await withBusy($('btn-force-change'), async () => {
    try {
      await callApi('changePassword', { oldPassword, newPassword });
      $('force-change-form').reset();
      state.user.mustChangePw = false;
      toast('Đã đổi mật khẩu', 'success');
      showDashboard();
    } catch (err) {
      if (err.code === 'SESSION_EXPIRED') return handleError(err);
      fail(errMessage(err));
    }
  });
}

async function logout(message) {
  const hadToken = !!getToken();
  if (hadToken) {
    try { await callApi('logout', {}); } catch (err) { /* vẫn đăng xuất cục bộ */ }
  }
  resetSession();
  showAuth();
  if (message) toast(message, 'info');
}

function bumpIdle() {
  if (!state.user) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => logout('Đã tự đăng xuất sau 30 phút không hoạt động'), IDLE_LOGOUT_MS);
}

async function checkExistingSession() {
  if (!getToken()) return false;
  try {
    const data = await callApi('me', {});
    enter(data.user);
    return true;
  } catch (err) {
    resetSession();
    return false;
  }
}

// =====================================================================
// Tabs
// =====================================================================

function activateTab(name) {
  state.tab = name;
  document.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['requests', 'depts', 'users', 'config', 'audit', 'account'].forEach((t) => toggle($('tab-' + t), t === name));
  if (name === 'depts') loadDepts();
  if (name === 'users' && !state.usersLoaded) loadUsers();
  if (name === 'config') loadConfig();
  if (name === 'audit') loadAudit();
  if (name === 'account') loadAccount();
}

// =====================================================================
// Duyệt giấy phép
// =====================================================================

function canAct(r) {
  const u = state.user;
  if (!u) return false;
  const me = u.username.toLowerCase();
  if (u.role === 'admin') return PENDING.indexOf(r.status) >= 0;
  if (r.status === 'PENDING_SUP') return u.role === 'supervisor' && String(r.supId).toLowerCase() === me;
  if (r.status === 'PENDING_MGR') return u.role === 'manager' && String(r.mgrId).toLowerCase() === me;
  if (r.status === 'PENDING_HR') return u.role === 'hr';
  return false;
}

function chipMatch(chip, r) {
  if (chip === 'mine') return canAct(r);
  if (chip === 'pending') return PENDING.indexOf(r.status) >= 0;
  if (chip === 'approved') return ['APPROVED', 'OUT', 'COMPLETED'].indexOf(r.status) >= 0;
  if (chip === 'rejected') return r.status === 'REJECTED';
  return true;
}

async function loadRequests() {
  const payload = {};
  if ($('flt-date-from').value) payload.dateFrom = $('flt-date-from').value;
  if ($('flt-date-to').value) payload.dateTo = $('flt-date-to').value;
  if ($('flt-dept').value) payload.dept = $('flt-dept').value;
  if (!state.requests.length) $('requests-table').innerHTML = skeleton(4);
  const n = beginLoad('requests');
  try {
    const data = await callApi('listRequests', payload);
    if (!isLatest('requests', n)) return;
    state.requests = data.requests || [];
    state.names = data.names || {};
    // Bỏ các mục đã chọn không còn duyệt được.
    Array.from(state.selected).forEach((id) => {
      const r = state.requests.find((x) => x.requestId === id);
      if (!r || !canAct(r)) state.selected.delete(id);
    });
    if (state.chipAuto) {
      state.chipAuto = false;
      if (!state.requests.some(canAct)) setChip('all', true);
    }
    renderRequests();
  } catch (err) {
    $('requests-table').innerHTML = '';
    handleError(err);
  }
}

function setChip(chip, silent) {
  state.chip = chip;
  document.querySelectorAll('#req-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.chip === chip));
  if (!silent) renderRequests();
}

function miniProgress(r) {
  const steps = approvalSteps(r, state.names).filter((s) => !(s.state === 'skipped' && s.meta.indexOf('Không có') === 0));
  const short = { sup: 'GS', mgr: 'TBP', hr: 'HR' };
  const icon = { done: '✓', current: '…', rejected: '✕', skipped: '–', waiting: '·' };
  const cls = { done: 'appr--done', current: 'appr--wait', rejected: 'appr--no' };
  return steps.map((s) => '<span class="appr ' + (cls[s.state] || '') + '" title="' + escapeHtml(s.title + ': ' + s.meta) + '">' +
    short[s.key] + ' ' + icon[s.state] + '</span>').join(' ');
}

function renderRequests() {
  const q = $('flt-search').value.trim().toLowerCase();
  const counts = { mine: 0, pending: 0, approved: 0, rejected: 0, all: state.requests.length };
  state.requests.forEach((r) => ['mine', 'pending', 'approved', 'rejected'].forEach((c) => { if (chipMatch(c, r)) counts[c]++; }));
  Object.keys(counts).forEach((c) => { $('chip-n-' + c).textContent = counts[c]; });
  const pill = $('pill-requests');
  pill.textContent = counts.mine || '';
  pill.dataset.n = counts.mine;

  const list = state.requests.filter((r) => chipMatch(state.chip, r) &&
    (!q || [r.fullName, r.emplId, r.requestId, r.dept].some((v) => String(v || '').toLowerCase().indexOf(q) >= 0)));
  const actionable = list.filter(canAct);
  const allSel = actionable.length > 0 && actionable.every((r) => state.selected.has(r.requestId));

  const head = [
    { html: actionable.length ? '<input type="checkbox" id="chk-all" aria-label="Chọn tất cả"' + (allSel ? ' checked' : '') + '>' : '', cls: 'col-check' },
    { html: 'Nhân viên' }, { html: 'Bộ phận' }, { html: 'Ngày / giờ' }, { html: 'Lý do' },
    { html: 'Trạng thái' }, { html: 'Tiến trình' }, { html: '', cls: 'cell-actions' }
  ];
  const rows = list.map((r) => {
    const act = canAct(r);
    return '<tr data-id="' + escapeHtml(r.requestId) + '" class="' + (act ? 'is-actionable' : '') + '" style="cursor:pointer">' +
      '<td class="col-check">' + (act ? '<input type="checkbox" class="chk-row" data-id="' + escapeHtml(r.requestId) + '"' + (state.selected.has(r.requestId) ? ' checked' : '') + '>' : '') + '</td>' +
      '<td><span class="cell-strong">' + escapeHtml(r.fullName || '(chưa ghi tên)') + '</span><span class="cell-sub mono">' + escapeHtml([r.emplId, r.requestId].filter(Boolean).join(' · ')) + '</span></td>' +
      '<td>' + escapeHtml(r.dept || '—') + '</td>' +
      '<td class="nowrap">' + escapeHtml(formatDate(r.date)) + '<span class="cell-sub">' + escapeHtml([r.comeOutPlanned, r.comeInPlanned].filter(Boolean).join(' → ') || '—') + '</span></td>' +
      '<td>' + escapeHtml(reasonLabel(r.reason) || '—') + (r.reasonDetail ? '<span class="cell-sub">' + escapeHtml(r.reasonDetail) + '</span>' : '') + '</td>' +
      '<td>' + statusBadgeHtml(r.status) + '</td>' +
      '<td class="nowrap">' + miniProgress(r) + '</td>' +
      '<td class="cell-actions">' + (act
        ? '<button type="button" class="btn btn-success btn-sm" data-quick-approve="' + escapeHtml(r.requestId) + '">Duyệt</button>'
        : '<button type="button" class="btn btn-secondary btn-sm">Xem</button>') + '</td>' +
      '</tr>';
  });
  const emptyText = state.chip === 'mine' ? 'Không có giấy phép nào đang chờ bạn duyệt 🎉' : 'Không có giấy phép phù hợp';
  setTable('requests-table', tableHtml(head, rows, emptyText));
  updateBulkBar();
}

function updateBulkBar() {
  const n = state.selected.size;
  toggle($('bulk-bar'), n > 0);
  $('bulk-count').textContent = 'Đã chọn ' + n + ' giấy phép';
}

function onRequestsTableClick(e) {
  const quick = e.target.closest('[data-quick-approve]');
  if (quick) {
    e.stopPropagation();
    const r = state.requests.find((x) => x.requestId === quick.dataset.quickApprove);
    if (r) approveRequest(r, quick);
    return;
  }
  if (e.target.id === 'chk-all') {
    const q = $('flt-search').value.trim().toLowerCase();
    state.requests.filter((r) => chipMatch(state.chip, r) && canAct(r) &&
      (!q || [r.fullName, r.emplId, r.requestId, r.dept].some((v) => String(v || '').toLowerCase().indexOf(q) >= 0)))
      .forEach((r) => { if (e.target.checked) state.selected.add(r.requestId); else state.selected.delete(r.requestId); });
    renderRequests();
    return;
  }
  if (e.target.classList.contains('chk-row')) {
    if (e.target.checked) state.selected.add(e.target.dataset.id); else state.selected.delete(e.target.dataset.id);
    updateBulkBar();
    return;
  }
  const tr = e.target.closest('tr[data-id]');
  if (tr) {
    const r = state.requests.find((x) => x.requestId === tr.dataset.id);
    if (r) openRequestModal(r);
  }
}

function replaceRequest(updated) {
  const i = state.requests.findIndex((x) => x.requestId === updated.requestId);
  if (i >= 0) state.requests[i] = updated;
  state.selected.delete(updated.requestId);
}

function openRequestModal(r) {
  state.modalRequest = r;
  $('approve-modal-id').textContent = r.requestId;
  $('approve-modal-title').textContent = r.fullName || '(chưa ghi tên)';
  const kv = [
    ['Trạng thái', null, statusBadgeHtml(r.status)],
    ['Mã nhân viên', r.emplId], ['Bộ phận', r.dept], ['Ngày', formatDate(r.date)],
    ['Giờ ra dự kiến', r.comeOutPlanned], ['Giờ vào dự kiến', r.comeInPlanned],
    ['Lý do', reasonLabel(r.reason)], ['Chi tiết', r.reason === 'OTHER' ? r.reasonDetail : null],
    ['Gửi lúc', formatDateTime(r.createdAt)]
  ].filter((x) => x[1] !== null || x[2]);
  $('approve-modal-content').innerHTML = kv.map(([k, v, html]) =>
    '<dt>' + escapeHtml(k) + '</dt><dd class="' + (v || html ? '' : 'empty') + '">' + (html || escapeHtml(v || 'chưa ghi')) + '</dd>').join('');
  $('approve-modal-steps').innerHTML = renderStepsHtml(r, state.names);
  const act = canAct(r);
  toggle($('btn-modal-approve'), act);
  toggle($('btn-modal-reject'), act);
  $('btn-modal-approve').textContent = r.status === 'PENDING_HR' ? 'Duyệt (hoàn tất)' : 'Duyệt';
  openModal('approve-modal');
}

async function approveRequest(r, btn) {
  if (!state.user.hasSignature) {
    toast('Bạn cần lưu chữ ký số trước khi duyệt (tab Tài khoản)', 'warning');
    return;
  }
  await withBusy(btn, async () => {
    try {
      const data = await callApi('approve', { requestId: r.requestId, version: r.version });
      replaceRequest(data.request);
      toast('Đã duyệt ' + (r.fullName || r.requestId), 'success');
      if (state.modalRequest && state.modalRequest.requestId === r.requestId) closeModal('approve-modal');
      renderRequests();
    } catch (err) {
      handleError(err);
      if (err.code === 'CONFLICT_VERSION' || err.code === 'INVALID_TRANSITION') loadRequests();
    }
  });
}

async function rejectRequest(r, btn) {
  const reason = await dialog({
    title: 'Từ chối giấy phép',
    message: 'Từ chối giấy phép của ' + (r.fullName || r.requestId) + '?',
    input: { label: 'Lý do từ chối (nhân viên sẽ thấy)', multiline: true, required: true },
    confirmText: 'Từ chối',
    danger: true
  });
  if (!reason) return;
  await withBusy(btn, async () => {
    try {
      const data = await callApi('reject', { requestId: r.requestId, version: r.version, reason });
      replaceRequest(data.request);
      toast('Đã từ chối giấy phép', 'success');
      closeModal('approve-modal');
      renderRequests();
    } catch (err) {
      handleError(err);
      if (err.code === 'CONFLICT_VERSION' || err.code === 'INVALID_TRANSITION') loadRequests();
    }
  });
}

async function downloadPdf(r, btn) {
  await withBusy(btn, async () => {
    try {
      const data = await callApi('getRequestPdfData', { requestId: r.requestId });
      await renderGatePassPdf(data.request, data.signatures, { approverNames: data.names || state.names });
      toast('Đã tải PDF', 'success');
    } catch (err) {
      handleError(err);
    }
  });
}

async function bulkApprove() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  if (!state.user.hasSignature) {
    toast('Bạn cần lưu chữ ký số trước khi duyệt (tab Tài khoản)', 'warning');
    return;
  }
  const ok = await confirmDialog('Duyệt ' + ids.length + ' giấy phép đã chọn?', { title: 'Duyệt hàng loạt', confirmText: 'Duyệt tất cả' });
  if (!ok) return;
  await withBusy($('btn-bulk-approve'), async () => {
    let okCount = 0;
    const errors = [];
    for (const id of ids) {
      const r = state.requests.find((x) => x.requestId === id);
      if (!r) continue;
      try {
        const data = await callApi('approve', { requestId: r.requestId, version: r.version });
        replaceRequest(data.request);
        okCount++;
      } catch (err) {
        if (err.code === 'SESSION_EXPIRED') return handleError(err);
        errors.push(id + ': ' + errMessage(err));
      }
    }
    state.selected.clear();
    if (okCount) toast('Đã duyệt ' + okCount + ' giấy phép', 'success');
    if (errors.length) toast('Không duyệt được ' + errors.length + ' mục: ' + errors.join('; '), 'error', 8000);
    await loadRequests();
  });
}

// =====================================================================
// Người dùng (admin)
// =====================================================================

async function loadUsers() {
  if (!state.usersLoaded) $('all-users-list').innerHTML = skeleton(4);
  const n = beginLoad('users');
  try {
    const data = await callApi('listUsers', {});
    if (!isLatest('users', n)) return;
    state.users = data.users || [];
    state.usersLoaded = true;
    renderUsers();
  } catch (err) {
    handleError(err);
  }
}

function roleOptions(selected, includeNone) {
  const roles = ['supervisor', 'manager', 'hr', 'security', 'admin'];
  return (includeNone ? '<option value="">— Chưa có —</option>' : '') +
    roles.map((r) => '<option value="' + r + '"' + (r === selected ? ' selected' : '') + '>' + escapeHtml(ROLE_LABELS[r]) + '</option>').join('');
}

function deptOptions(selected) {
  const names = state.deptNames.slice();
  if (selected && names.indexOf(selected) < 0) names.push(selected);
  return '<option value="">— Bộ phận —</option>' +
    names.map((n) => '<option value="' + escapeHtml(n) + '"' + (n === selected ? ' selected' : '') + '>' + escapeHtml(n) + '</option>').join('');
}

function renderUsers() {
  const pending = state.users.filter((u) => u.status === 'PENDING');
  const pill = $('pill-users');
  pill.textContent = pending.length || '';
  pill.dataset.n = pending.length;

  toggle($('pending-card'), pending.length > 0);
  $('pending-users-list').innerHTML = pending.map((u) =>
    '<div class="pending-row" data-username="' + escapeHtml(u.username) + '">' +
    '<div class="pending-row__info"><strong>' + escapeHtml(u.fullName || u.username) + '</strong>' +
    '<div class="small muted">' + escapeHtml([u.username, u.emplId, u.email, formatDateTime(u.createdAt)].filter(Boolean).join(' · ')) + '</div></div>' +
    '<div class="pending-row__actions">' +
    '<select class="pending-role" aria-label="Vai trò">' + roleOptions('supervisor') + '</select>' +
    '<select class="pending-dept" aria-label="Bộ phận">' + deptOptions(u.dept) + '</select>' +
    '<button type="button" class="btn btn-success btn-sm" data-act="activate">Kích hoạt</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-act="reject">Từ chối</button>' +
    '</div></div>').join('');

  const q = $('users-search').value.trim().toLowerCase();
  const rf = $('users-role-filter').value;
  const sf = $('users-status-filter').value;
  const list = state.users.filter((u) =>
    (!rf || (rf === '__none' ? !u.role : u.role === rf)) &&
    (!sf || u.status === sf) &&
    (!q || [u.username, u.fullName, u.emplId, u.dept, u.email].some((v) => String(v || '').toLowerCase().indexOf(q) >= 0)));

  const head = [{ html: 'Người dùng' }, { html: 'Mã NV' }, { html: 'Bộ phận' }, { html: 'Vai trò' },
    { html: 'Trạng thái' }, { html: 'Chữ ký' }, { html: '', cls: 'cell-actions' }];
  const rows = list.map((u) =>
    '<tr data-username="' + escapeHtml(u.username) + '" style="cursor:pointer">' +
    '<td><div class="user-cell"><span class="avatar">' + escapeHtml(initials(u.fullName, u.username)) + '</span><div>' +
    '<span class="cell-strong">' + escapeHtml(u.fullName || '(chưa có tên)') + '</span>' +
    '<span class="cell-sub">' + escapeHtml(u.username) + (u.email ? ' · ' + escapeHtml(u.email) : '') + '</span></div></div></td>' +
    '<td class="mono">' + escapeHtml(u.emplId || '—') + '</td>' +
    '<td>' + escapeHtml(u.dept || '—') + '</td>' +
    '<td>' + (u.role ? escapeHtml(roleLabel(u.role)) : '<span class="tag tag--warn">Chưa có</span>') + '</td>' +
    '<td><span class="badge badge--' + escapeHtml(String(u.status).toLowerCase()) + '">' + escapeHtml(USER_STATUS_LABELS[u.status] || u.status) + '</span></td>' +
    '<td>' + (u.hasSignature ? '<span class="tag">✓ Có</span>' : (['supervisor', 'manager', 'hr', 'admin'].indexOf(u.role) >= 0 ? '<span class="tag tag--warn">Chưa có</span>' : '<span class="tag tag--muted">—</span>')) + '</td>' +
    '<td class="cell-actions"><button type="button" class="btn btn-secondary btn-sm">Sửa</button></td></tr>');
  setTable('all-users-list', tableHtml(head, rows, 'Không có người dùng phù hợp'));
}

async function onPendingAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.pending-row');
  const username = row.dataset.username;
  if (btn.dataset.act === 'activate') {
    const role = row.querySelector('.pending-role').value;
    const dept = row.querySelector('.pending-dept').value;
    await withBusy(btn, async () => {
      try {
        await callApi('activateUser', { username, role, dept });
        toast('Đã kích hoạt ' + username + ' — ' + roleLabel(role), 'success');
        afterDirectoryChange();
      } catch (err) { handleError(err); }
    });
  } else {
    const ok = await confirmDialog('Từ chối tài khoản đăng ký "' + username + '"?', { title: 'Từ chối đăng ký', confirmText: 'Từ chối', danger: true });
    if (!ok) return;
    await withBusy(btn, async () => {
      try {
        await callApi('rejectUser', { username });
        toast('Đã từ chối ' + username, 'success');
        loadUsers();
      } catch (err) { handleError(err); }
    });
  }
}

/** Sau khi thay đổi người dùng/bộ phận: làm mới mọi danh sách liên quan. */
function afterDirectoryChange() {
  loadUsers();
  loadDeptNames(true);
  if (state.tab === 'depts') loadDepts();
}

function ufFields() {
  return ['uf-fullname', 'uf-emplid', 'uf-email', 'uf-role', 'uf-dept'];
}

function ufDeptValue() {
  return $('uf-dept').value === DEPT_OTHER ? $('uf-dept-other').value.trim() : $('uf-dept').value;
}

let userFormTouched = false;

function refreshUserForm(evt) {
  if (evt && evt.type) userFormTouched = true;
  toggle($('uf-dept-other'), $('uf-dept').value === DEPT_OTHER);
  // Nhắc đỏ khi đang sửa người có sẵn, hoặc sau khi admin bắt đầu nhập (form mới trống thì chưa đỏ).
  const remind = userFormTouched || !!state.editingUser;
  ufFields().forEach((id) => {
    const empty = id === 'uf-dept' ? !ufDeptValue() : !$(id).value.trim();
    document.querySelector('[data-key="' + id + '"]').classList.toggle('is-missing', remind && empty);
  });
  document.querySelector('[data-key="uf-username"]').classList.toggle('is-missing', remind && !$('uf-username').value.trim());
  const role = $('uf-role').value;
  const dept = ufDeptValue();
  let hint = '';
  if (dept && role === 'supervisor') hint = '→ Sẽ tự được gán làm Giám sát của bộ phận "' + dept + '".';
  else if (dept && role === 'manager') hint = '→ Sẽ tự được gán làm Trưởng bộ phận "' + dept + '" (nếu bộ phận chưa có trưởng BP).';
  else if (role === 'hr') hint = '→ HR duyệt bước cuối cho mọi bộ phận.';
  else if (role === 'security') hint = '→ Bảo vệ không cần đăng nhập; trang Bảo vệ cổng xem được công khai.';
  $('uf-link-hint').textContent = hint;
}

function openUserModal(user, preset) {
  state.editingUser = user;
  state.sigUpload = null;
  userFormTouched = false;
  const p = preset || {};
  $('user-modal-title').textContent = user ? 'Sửa: ' + (user.fullName || user.username) : 'Thêm người dùng';
  $('uf-username').value = user ? user.username : '';
  $('uf-username').disabled = !!user;
  $('uf-fullname').value = user ? user.fullName : '';
  $('uf-emplid').value = user ? user.emplId : '';
  $('uf-email').value = user ? user.email : '';
  $('uf-role').value = user ? (user.role || '') : (p.role || '');
  fillDeptSelect($('uf-dept'), user ? user.dept : (p.dept || ''), { allowOther: true });
  $('uf-dept-other').value = '';
  $('uf-temp-password').value = '';
  toggle($('uf-temp-password-row'), !user);
  toggle($('uf-manage'), !!user);
  if (user) {
    $('uf-sig-state').textContent = user.hasSignature ? 'Đã có chữ ký. Chọn ảnh mới để thay.' : 'Chưa có chữ ký.';
    hide($('uf-sig-preview'));
    hide($('btn-sig-upload-save'));
    $('sig-upload-input').value = '';
    const locked = user.status === 'LOCKED';
    $('btn-user-lock').textContent = locked ? 'Mở khoá tài khoản' : 'Khoá tài khoản';
    $('btn-user-lock').className = 'btn btn-sm ' + (locked ? 'btn-secondary' : 'btn-danger-soft');
    toggle($('btn-user-lock'), user.username !== state.user.username && user.status !== 'PENDING');
  }
  refreshUserForm();
  openModal('user-form-modal');
  (user ? $('uf-fullname') : $('uf-username')).focus();
}

async function onSaveUser(evt) {
  evt.preventDefault();
  userFormTouched = true;
  refreshUserForm();
  const username = $('uf-username').value.trim();
  if (!username) {
    $('uf-username').focus();
    return;
  }
  const tempPassword = $('uf-temp-password').value;
  if (!state.editingUser && tempPassword && !isStrongPw(tempPassword)) {
    toast('Mật khẩu tạm tối thiểu 8 ký tự, có cả chữ và số', 'warning');
    return;
  }
  const payload = {
    username,
    fullName: $('uf-fullname').value.trim(),
    emplId: $('uf-emplid').value.trim(),
    email: $('uf-email').value.trim(),
    role: $('uf-role').value,
    dept: ufDeptValue()
  };
  await withBusy($('btn-save-user'), async () => {
    try {
      if (state.editingUser) {
        await callApi('updateUser', payload);
        toast('Đã lưu ' + username, 'success');
      } else {
        payload.tempPassword = tempPassword;
        const data = await callApi('createUser', payload);
        closeModal('user-form-modal');
        if (data && data.tempPassword) await showTempPassword(username, data.tempPassword);
        else toast('Đã tạo ' + username + ' — dùng mật khẩu tạm bạn đã đặt', 'success');
      }
      closeModal('user-form-modal');
      afterDirectoryChange();
    } catch (err) { handleError(err); }
  });
}

async function showTempPassword(username, pw) {
  await dialog({
    title: 'Mật khẩu tạm cho ' + username,
    html: '<p>Gửi mật khẩu này cho người dùng. Họ sẽ phải đổi mật khẩu ở lần đăng nhập đầu tiên. ' +
      '<strong>Mật khẩu chỉ hiện một lần.</strong></p><div class="secret-box"><span id="temp-pw">' + escapeHtml(pw) + '</span>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="btn-copy-temp">Sao chép</button></div>',
    confirmText: 'Đã ghi lại',
    cancelText: null
  });
}

async function onResetPassword() {
  const u = state.editingUser;
  if (!u) return;
  const ok = await confirmDialog('Đặt lại mật khẩu cho "' + u.username + '"? Mật khẩu hiện tại sẽ không dùng được nữa.', { title: 'Đặt lại mật khẩu', confirmText: 'Đặt lại' });
  if (!ok) return;
  await withBusy($('btn-user-reset'), async () => {
    try {
      const data = await callApi('resetPassword', { username: u.username });
      if (data && data.tempPassword) await showTempPassword(u.username, data.tempPassword);
    } catch (err) { handleError(err); }
  });
}

async function onToggleLock() {
  const u = state.editingUser;
  if (!u) return;
  const locking = u.status !== 'LOCKED';
  const ok = await confirmDialog(locking
    ? 'Khoá "' + u.username + '"? Người này sẽ bị đăng xuất và không duyệt được nữa.'
    : 'Mở khoá "' + u.username + '"?', { title: locking ? 'Khoá tài khoản' : 'Mở khoá', confirmText: locking ? 'Khoá' : 'Mở khoá', danger: locking });
  if (!ok) return;
  await withBusy($('btn-user-lock'), async () => {
    try {
      await callApi('updateUser', { username: u.username, status: locking ? 'LOCKED' : 'ACTIVE' });
      toast(locking ? 'Đã khoá ' + u.username : 'Đã mở khoá ' + u.username, 'success');
      closeModal('user-form-modal');
      afterDirectoryChange();
    } catch (err) { handleError(err); }
  });
}

function onSigFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (['image/png', 'image/jpeg'].indexOf(file.type) < 0) { toast('Chỉ nhận ảnh PNG hoặc JPEG', 'warning'); return; }
  if (file.size > 1024 * 1024) { toast('Ảnh chữ ký phải ≤ 1MB', 'warning'); return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    state.sigUpload = ev.target.result;
    $('uf-sig-preview').src = state.sigUpload;
    show($('uf-sig-preview'));
    show($('btn-sig-upload-save'));
    $('uf-sig-state').textContent = 'Xem trước — bấm "Lưu chữ ký" để áp dụng.';
  };
  reader.readAsDataURL(file);
}

async function onSigUploadSave() {
  const u = state.editingUser;
  if (!u || !state.sigUpload) return;
  await withBusy($('btn-sig-upload-save'), async () => {
    try {
      await callApi('uploadUserSignature', { username: u.username, imageBase64: state.sigUpload });
      u.hasSignature = true;
      $('uf-sig-state').textContent = '✓ Đã lưu chữ ký';
      hide($('btn-sig-upload-save'));
      toast('Đã lưu chữ ký cho ' + u.username, 'success');
      if (state.user.username === u.username) { state.user.hasSignature = true; updateSigWarning(); }
      loadUsers();
    } catch (err) { handleError(err); }
  });
}

// =====================================================================
// Bộ phận (admin)
// =====================================================================

async function loadDepts() {
  if (!state.depts.length) $('depts-table').innerHTML = skeleton(3);
  const n = beginLoad('depts');
  try {
    const [deptData] = await Promise.all([
      callApi('listDepartmentsAdmin', {}),
      state.usersLoaded ? Promise.resolve() : loadUsers()
    ]);
    if (!isLatest('depts', n)) return;
    state.depts = deptData.departments || [];
    renderDepts();
  } catch (err) {
    handleError(err);
  }
}

function personTag(username, role) {
  const u = userByName(username);
  if (!u) return '<span class="tag tag--warn" title="Không tìm thấy tài khoản">' + escapeHtml(username) + ' ⚠</span>';
  let warn = '';
  if (u.status !== 'ACTIVE') warn = USER_STATUS_LABELS[u.status] || u.status;
  else if (u.role !== role && u.role !== 'admin') warn = 'vai trò hiện là ' + roleLabel(u.role || '—');
  else if (!u.hasSignature) warn = 'chưa có chữ ký';
  return '<span class="tag' + (warn ? ' tag--warn' : '') + '" title="' + escapeHtml(u.username + (warn ? ' — ' + warn : '')) + '">' +
    escapeHtml(u.fullName || u.username) + (warn ? ' ⚠' : '') + '</span>';
}

function renderDepts() {
  const head = [{ html: 'Bộ phận' }, { html: 'Giám sát' }, { html: 'Trưởng bộ phận' }, { html: 'Nhân sự' }, { html: '', cls: 'cell-actions' }];
  const rows = state.depts.map((d) =>
    '<tr data-dept="' + escapeHtml(d.dept) + '">' +
    '<td class="cell-strong">' + escapeHtml(d.dept) + '</td>' +
    '<td>' + (d.supervisorUsernames.length ? d.supervisorUsernames.map((s) => personTag(s, 'supervisor')).join('') : '<span class="tag tag--muted">Không có</span>') + '</td>' +
    '<td>' + (d.managerUsername ? personTag(d.managerUsername, 'manager') : '<span class="tag tag--warn">Chưa có</span>') + '</td>' +
    '<td>' + d.memberCount + '</td>' +
    '<td class="cell-actions"><button type="button" class="btn btn-secondary btn-sm" data-act="edit">Sửa</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-act="delete">Xoá</button></td></tr>');
  setTable('depts-table', tableHtml(head, rows, 'Chưa có bộ phận nào — bấm "+ Thêm bộ phận" để bắt đầu'));
}

function openDeptModal(dept) {
  state.editingDept = dept;
  $('dept-modal-title').textContent = dept ? 'Sửa bộ phận: ' + dept.dept : 'Thêm bộ phận';
  $('df-name').value = dept ? dept.dept : '';
  const chosen = new Set((dept ? dept.supervisorUsernames : []).map((s) => s.toLowerCase()));
  const sups = state.users.filter((u) => (u.role === 'supervisor' && u.status === 'ACTIVE') || chosen.has(u.username.toLowerCase()));
  // Người đang được gán nhưng chưa có trong danh sách tải về vẫn phải hiện (và giữ dấu chọn),
  // nếu không lưu lại sẽ vô tình gỡ họ khỏi bộ phận.
  (dept ? dept.supervisorUsernames : []).forEach((s) => {
    if (!sups.some((u) => u.username.toLowerCase() === s.toLowerCase())) {
      sups.push({ username: s, fullName: s, dept: '', status: 'ACTIVE' });
    }
  });
  $('df-sups').innerHTML = sups.length
    ? sups.map((u) => '<label><input type="checkbox" value="' + escapeHtml(u.username) + '"' + (chosen.has(u.username.toLowerCase()) ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(u.fullName || u.username) + ' <span class="muted">· ' + escapeHtml(u.username) +
      (u.dept ? ' · ' + escapeHtml(u.dept) : '') + (u.status !== 'ACTIVE' ? ' · ' + escapeHtml(USER_STATUS_LABELS[u.status] || u.status) : '') + '</span></span></label>').join('')
    : '<div class="check-list__empty">Chưa có tài khoản vai trò Giám sát.</div>';
  const mgrSel = $('df-mgr');
  mgrSel.innerHTML = '<option value="">— Chưa có —</option>';
  const cur = dept ? dept.managerUsername : '';
  const mgrs = state.users.filter((u) => (u.role === 'manager' && u.status === 'ACTIVE') || (cur && u.username.toLowerCase() === cur.toLowerCase()));
  if (cur && !mgrs.length) mgrs.push({ username: cur, fullName: cur, dept: '' });
  mgrs.forEach((u) => mgrSel.appendChild(new Option((u.fullName || u.username) + ' (' + u.username + (u.dept ? ' · ' + u.dept : '') + ')', u.username)));
  mgrSel.value = cur || '';
  document.querySelector('[data-key="dept-name"]').classList.remove('is-missing');
  openModal('dept-modal');
  $('df-name').focus();
}

async function onSaveDept(evt) {
  evt.preventDefault();
  const name = $('df-name').value.trim();
  document.querySelector('[data-key="dept-name"]').classList.toggle('is-missing', !name);
  if (!name) return;
  const sups = Array.from($('df-sups').querySelectorAll('input:checked')).map((c) => c.value);
  await withBusy($('btn-save-dept'), async () => {
    try {
      await callApi('saveDepartment', {
        dept: name,
        originalDept: state.editingDept ? state.editingDept.dept : '',
        supervisorUsernames: sups,
        managerUsername: $('df-mgr').value
      });
      toast('Đã lưu bộ phận ' + name, 'success');
      closeModal('dept-modal');
      afterDirectoryChange();
      loadDepts();
    } catch (err) { handleError(err); }
  });
}

async function onDeptsTableClick(e) {
  const btn = e.target.closest('[data-act]');
  const tr = e.target.closest('tr[data-dept]');
  if (!tr) return;
  const d = state.depts.find((x) => x.dept === tr.dataset.dept);
  if (!d) return;
  if (!btn || btn.dataset.act === 'edit') { openDeptModal(d); return; }
  const ok = await confirmDialog('Xoá bộ phận "' + d.dept + '"? Người dùng và giấy phép cũ vẫn giữ tên bộ phận này.', { title: 'Xoá bộ phận', confirmText: 'Xoá', danger: true });
  if (!ok) return;
  await withBusy(btn, async () => {
    try {
      await callApi('deleteDepartment', { dept: d.dept });
      toast('Đã xoá ' + d.dept, 'success');
      afterDirectoryChange();
      loadDepts();
    } catch (err) { handleError(err); }
  });
}

// =====================================================================
// Cấu hình / Nhật ký (admin)
// =====================================================================

const CONFIG_FIELDS = [
  ['cfg-max-requests-per-day', 'MAX_REQUESTS_PER_EMPL_PER_DAY'],
  ['cfg-max-register-per-day', 'MAX_REGISTER_PER_DAY'],
  ['cfg-max-pending-users', 'MAX_PENDING_USERS']
];
let loadedConfig = {};

async function loadConfig() {
  try {
    const data = await callApi('getConfig', {});
    loadedConfig = data.config || {};
    CONFIG_FIELDS.forEach(([id, key]) => { $(id).value = loadedConfig[key] || ''; });
    $('cfg-email-enabled').checked = String(loadedConfig.EMAIL_NOTIFICATIONS_ENABLED).toLowerCase() === 'true';
  } catch (err) { handleError(err); }
}

async function onSaveConfig(evt) {
  evt.preventDefault();
  const changes = [];
  CONFIG_FIELDS.forEach(([id, key]) => {
    const v = $(id).value.trim();
    if (v !== '' && v !== String(loadedConfig[key] || '')) changes.push([key, v]);
  });
  const email = $('cfg-email-enabled').checked ? 'true' : 'false';
  if (email !== String(loadedConfig.EMAIL_NOTIFICATIONS_ENABLED || 'false').toLowerCase()) changes.push(['EMAIL_NOTIFICATIONS_ENABLED', email]);
  if (!changes.length) { toast('Không có thay đổi', 'info'); return; }
  await withBusy($('btn-save-config'), async () => {
    try {
      for (const [key, value] of changes) await callApi('setConfig', { key, value });
      toast('Đã lưu cấu hình', 'success');
      loadConfig();
    } catch (err) { handleError(err); }
  });
}

async function loadAudit() {
  const payload = {};
  if ($('audit-date-from').value) payload.dateFrom = $('audit-date-from').value;
  if ($('audit-date-to').value) payload.dateTo = $('audit-date-to').value;
  $('audit-log-list').innerHTML = skeleton(5);
  try {
    const data = await callApi('listAuditLog', payload);
    const logs = data.logs || [];
    const head = [{ html: 'Thời gian' }, { html: 'Người thực hiện' }, { html: 'Hành động' }, { html: 'Đối tượng' }, { html: 'Chi tiết' }];
    const rows = logs.map((l) => '<tr><td class="nowrap">' + escapeHtml(formatDateTime(l.time)) + '</td><td>' + escapeHtml(l.actor) +
      '</td><td><span class="tag">' + escapeHtml(l.action) + '</span></td><td class="mono">' + escapeHtml(l.targetId) + '</td><td>' + escapeHtml(l.detail) + '</td></tr>');
    setTable('audit-log-list', tableHtml(head, rows, 'Không có nhật ký trong khoảng thời gian này'));
  } catch (err) {
    $('audit-log-list').innerHTML = '';
    handleError(err);
  }
}

// =====================================================================
// Tài khoản của tôi
// =====================================================================

async function loadAccount() {
  const u = state.user;
  if (!u) return;
  const kv = [['Họ tên', u.fullName], ['Tên đăng nhập', u.username], ['Mã nhân viên', u.emplId], ['Bộ phận', u.dept],
    ['Vai trò', roleLabel(u.role)], ['Email', u.email]];
  $('account-info').innerHTML = kv.map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd class="' + (v ? '' : 'empty') + '">' + escapeHtml(v || 'chưa có') + '</dd>').join('');
  try {
    const data = await callApi('getMySignature', {});
    if (data.dataUrl) {
      $('acc-sig-current').src = data.dataUrl;
      show($('acc-sig-current'));
      hide($('acc-sig-none'));
    } else {
      hide($('acc-sig-current'));
      show($('acc-sig-none'));
    }
  } catch (err) {
    if (err.code === 'SESSION_EXPIRED') handleError(err);
  }
}

async function onSaveMySignature() {
  if (!accSigPad || accSigPad.isEmpty()) { toast('Hãy ký vào khung trước khi lưu', 'warning'); return; }
  const imageBase64 = accSigPad.toDataUrl(300);
  await withBusy($('btn-acc-sig-save'), async () => {
    try {
      await callApi('uploadMySignature', { imageBase64 });
      state.user.hasSignature = true;
      updateSigWarning();
      $('acc-sig-current').src = imageBase64;
      show($('acc-sig-current'));
      hide($('acc-sig-none'));
      accSigPad.clear();
      toast('Đã lưu chữ ký', 'success');
    } catch (err) { handleError(err); }
  });
}

async function onChangePassword(evt) {
  evt.preventDefault();
  const oldPassword = $('acc-old-password').value;
  const newPassword = $('acc-new-password').value;
  if (!isStrongPw(newPassword)) { toast('Mật khẩu mới tối thiểu 8 ký tự, có cả chữ và số', 'warning'); return; }
  if (newPassword !== $('acc-confirm-password').value) { toast('Mật khẩu nhập lại không khớp', 'warning'); return; }
  await withBusy($('btn-acc-change-password'), async () => {
    try {
      await callApi('changePassword', { oldPassword, newPassword });
      $('acc-password-form').reset();
      toast('Đã đổi mật khẩu', 'success');
    } catch (err) { handleError(err); }
  });
}

// =====================================================================
// Khởi tạo — gắn sự kiện đúng 1 lần
// =====================================================================

function wireEvents() {
  $('auth-tab-login').addEventListener('click', () => setAuthTab('login'));
  $('auth-tab-register').addEventListener('click', () => setAuthTab('register'));
  $('login-form').addEventListener('submit', onLogin);
  $('register-form').addEventListener('submit', onRegister);
  $('force-change-form').addEventListener('submit', onForceChange);
  $('btn-force-cancel').addEventListener('click', () => logout());
  $('btn-logout').addEventListener('click', () => logout('Đã đăng xuất'));

  document.querySelectorAll('.nav-tab').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));

  // Requests
  document.querySelectorAll('#req-chips .chip').forEach((c) => c.addEventListener('click', () => setChip(c.dataset.chip)));
  $('flt-search').addEventListener('input', renderRequests);
  ['flt-date-from', 'flt-date-to', 'flt-dept'].forEach((id) => $(id).addEventListener('change', loadRequests));
  $('btn-filter').addEventListener('click', (e) => withBusy(e.currentTarget, loadRequests));
  $('requests-table').addEventListener('click', onRequestsTableClick);
  $('btn-bulk-approve').addEventListener('click', bulkApprove);
  $('btn-bulk-clear').addEventListener('click', () => { state.selected.clear(); renderRequests(); });
  $('btn-goto-account').addEventListener('click', () => activateTab('account'));
  $('btn-modal-approve').addEventListener('click', (e) => state.modalRequest && approveRequest(state.modalRequest, e.currentTarget));
  $('btn-modal-reject').addEventListener('click', (e) => state.modalRequest && rejectRequest(state.modalRequest, e.currentTarget));
  $('btn-modal-pdf').addEventListener('click', (e) => state.modalRequest && downloadPdf(state.modalRequest, e.currentTarget));

  // Users
  $('pending-users-list').addEventListener('click', onPendingAction);
  ['users-search', 'users-role-filter', 'users-status-filter'].forEach((id) => {
    $(id).addEventListener('input', renderUsers);
    $(id).addEventListener('change', renderUsers);
  });
  $('btn-create-user').addEventListener('click', () => openUserModal(null));
  $('all-users-list').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-username]');
    if (tr) openUserModal(userByName(tr.dataset.username));
  });
  $('user-form').addEventListener('submit', onSaveUser);
  ['uf-username', 'uf-fullname', 'uf-emplid', 'uf-email', 'uf-role', 'uf-dept', 'uf-dept-other'].forEach((id) => {
    $(id).addEventListener('input', refreshUserForm);
    $(id).addEventListener('change', refreshUserForm);
  });
  $('uf-dept').addEventListener('change', () => { if ($('uf-dept').value === DEPT_OTHER) $('uf-dept-other').focus(); });
  $('btn-user-reset').addEventListener('click', onResetPassword);
  $('btn-user-lock').addEventListener('click', onToggleLock);
  $('sig-upload-input').addEventListener('change', onSigFileChosen);
  $('btn-sig-upload-save').addEventListener('click', onSigUploadSave);

  // Departments
  $('btn-add-dept').addEventListener('click', () => (state.usersLoaded ? openDeptModal(null) : loadUsers().then(() => openDeptModal(null))));
  $('depts-table').addEventListener('click', onDeptsTableClick);
  $('dept-form').addEventListener('submit', onSaveDept);
  $('df-add-user').addEventListener('click', (e) => {
    e.preventDefault();
    const name = $('df-name').value.trim();
    closeModal('dept-modal');
    openUserModal(null, { dept: name, role: 'supervisor' });
  });

  // Config / audit / account
  $('config-form').addEventListener('submit', onSaveConfig);
  $('btn-audit-filter').addEventListener('click', loadAudit);
  $('acc-password-form').addEventListener('submit', onChangePassword);
  $('btn-acc-sig-clear').addEventListener('click', () => accSigPad && accSigPad.clear());
  $('btn-acc-sig-save').addEventListener('click', onSaveMySignature);

  // Đóng modal: nút [data-close], bấm nền, phím Esc.
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => {
      if (e.target === ov || e.target.closest('[data-close]')) hide(ov);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('.dialog')) return;
    const open = Array.from(document.querySelectorAll('.modal-overlay:not(.hidden)')).pop();
    if (open) hide(open);
  });
  // Sao chép mật khẩu tạm trong hộp thoại.
  document.addEventListener('click', async (e) => {
    if (e.target.id !== 'btn-copy-temp') return;
    try {
      await navigator.clipboard.writeText($('temp-pw').textContent);
      toast('Đã sao chép', 'success');
    } catch (err) { toast('Không sao chép được — hãy ghi lại', 'warning'); }
  });

  // Theo dõi hoạt động để tự đăng xuất khi bỏ máy.
  ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));
}

export async function initHrPage() {
  clearStaleSessionData();
  renderMockBanner();
  toggle($('demo-accounts'), MOCK_MODE);
  wireEvents();
  accSigPad = new SignaturePad($('acc-sig-canvas'));
  $('audit-date-from').value = addDays(todayYmd(), -7);
  $('audit-date-to').value = todayYmd();

  // Song song: danh sách bộ phận (cache) + kiểm tra phiên cũ trong tab này.
  const deptsP = loadDeptNames(false);
  const had = await checkExistingSession();
  if (!had) showAuth();
  await deptsP;
}
