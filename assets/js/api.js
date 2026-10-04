// assets/js/api.js — Lớp gọi API duy nhất dùng chung cho index.html / security.html / hr.html.
// Thật (fetch Apps Script Web App) hoặc MOCK MODE (localStorage) tùy assets/js/config.js.
// Nạp sau assets/js/config.js trong HTML (dùng <script type="module">).

// ===== PHẦN 1: config, token, callApi thật =====

const PLACEHOLDER_URL = 'PASTE_APPS_SCRIPT_WEBAPP_URL_HERE';
const TOKEN_KEY = 'gatepass_token';
const MOCK_DB_KEY = 'gatepass_mock_db_v2';
const CACHE_PREFIX = 'gatepass_cache:';
// Khoá cũ của các phiên bản trước — xoá khi tải trang để không còn "rác" làm chậm/lỗi.
const LEGACY_KEYS = ['gatepass_mock_db', 'gatepass_user', 'gatepass_session', 'gatepass_departments'];
const REQUEST_TIMEOUT_MS = 30000;

function resolveApiUrl() {
  const cfg = (typeof window !== 'undefined' && window.GATEPASS_CONFIG) || {};
  return typeof cfg.API_URL === 'string' ? cfg.API_URL.trim() : '';
}

export const MOCK_MODE = (() => {
  const url = resolveApiUrl();
  return url === '' || url === PLACEHOLDER_URL;
})();

function safeStorage(kind) {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch (err) {
    return null;
  }
}

export function getToken() {
  const s = safeStorage('session');
  try { return s ? s.getItem(TOKEN_KEY) : null; } catch (err) { return null; }
}

export function setToken(token) {
  const s = safeStorage('session');
  if (!s) return;
  try {
    if (!token) s.removeItem(TOKEN_KEY);
    else s.setItem(TOKEN_KEY, String(token));
  } catch (err) { /* bỏ qua */ }
}

export function clearToken() {
  setToken(null);
}

/**
 * Dọn thông tin phiên/bộ nhớ đệm cũ mỗi lần mở trang:
 *  - khoá localStorage của phiên bản cũ,
 *  - cache API đã hết hạn.
 * Token đăng nhập nằm trong sessionStorage nên tự mất khi đóng tab.
 */
export function clearStaleSessionData() {
  const ls = safeStorage('local');
  if (!ls) return;
  try {
    LEGACY_KEYS.forEach((k) => ls.removeItem(k));
    const now = Date.now();
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (!k || k.indexOf(CACHE_PREFIX) !== 0) continue;
      try {
        const item = JSON.parse(ls.getItem(k));
        if (!item || !item.exp || item.exp < now) ls.removeItem(k);
      } catch (e) {
        ls.removeItem(k);
      }
    }
  } catch (err) { /* bỏ qua */ }
}

/** Xoá toàn bộ dữ liệu phiên của người dùng hiện tại (gọi khi đăng xuất). */
export function clearAllSessionData() {
  clearToken();
  const ls = safeStorage('local');
  if (!ls) return;
  try {
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0) ls.removeItem(k);
    }
  } catch (err) { /* bỏ qua */ }
}

function makeApiError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function callApi(action, payload) {
  const safePayload = payload || {};

  if (MOCK_MODE) {
    return mockCallApi(action, safePayload);
  }

  const body = JSON.stringify({ action, token: getToken(), payload: safePayload });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

  let res;
  try {
    // text/plain để tránh CORS preflight với Apps Script.
    res = await fetch(resolveApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      signal: controller ? controller.signal : undefined
    });
  } catch (netErr) {
    const aborted = netErr && netErr.name === 'AbortError';
    throw makeApiError('NETWORK_ERROR', aborted
      ? 'Máy chủ phản hồi quá lâu, vui lòng thử lại'
      : 'Không thể kết nối máy chủ, vui lòng kiểm tra mạng và thử lại');
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    throw makeApiError('NETWORK_ERROR', 'Không thể kết nối máy chủ, vui lòng kiểm tra mạng và thử lại');
  }

  if (json && json.ok === true) return json.data;

  const code = (json && json.error && json.error.code) || 'INTERNAL_ERROR';
  const message = (json && json.error && json.error.message) || 'Lỗi không xác định từ máy chủ';
  if (code === 'SESSION_EXPIRED') clearToken();
  throw makeApiError(code, message);
}

/**
 * Gọi API có cache localStorage (stale-while-revalidate) — chỉ dùng cho dữ liệu công khai,
 * ít thay đổi (VD danh sách bộ phận). onData được gọi ngay với dữ liệu cache (nếu có),
 * rồi gọi lại khi có dữ liệu mới từ máy chủ.
 */
let cacheSeq = 0;

export async function cachedCall(action, payload, ttlMs, onData) {
  const key = CACHE_PREFIX + action + ':' + JSON.stringify(payload || {});
  const ls = safeStorage('local');
  let cached = null;
  try {
    const raw = ls ? ls.getItem(key) : null;
    const item = raw ? JSON.parse(raw) : null;
    if (item && item.exp > Date.now()) cached = item.data;
  } catch (err) { /* bỏ qua */ }
  if (cached && onData) onData(cached, true);

  // Ghi nhớ thời điểm BẮT ĐẦU gọi: nếu nhiều lần gọi chồng nhau, phản hồi cũ về sau
  // không được ghi đè dữ liệu mới hơn (tránh hiện người duyệt đã lỗi thời).
  const startedAt = Date.now() + (++cacheSeq) / 1000;
  const fresh = await callApi(action, payload);
  let newest = true;
  try {
    const raw = ls ? ls.getItem(key) : null;
    const cur = raw ? JSON.parse(raw) : null;
    if (cur && cur.at && cur.at > startedAt) newest = false;
    if (newest && ls) ls.setItem(key, JSON.stringify({ exp: Date.now() + ttlMs, at: startedAt, data: fresh }));
  } catch (err) { /* bỏ qua */ }
  if (newest && onData && JSON.stringify(fresh) !== JSON.stringify(cached)) onData(fresh, false);
  return fresh;
}

/** Xoá cache của 1 action (VD sau khi admin sửa bộ phận/người dùng). */
export function invalidateCache(action) {
  const ls = safeStorage('local');
  if (!ls) return;
  try {
    const prefix = CACHE_PREFIX + action + ':';
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.indexOf(prefix) === 0) ls.removeItem(k);
    }
  } catch (err) { /* bỏ qua */ }
}

export function resetMockData() {
  const ls = safeStorage('local');
  try { if (ls) ls.removeItem(MOCK_DB_KEY); } catch (err) { /* bỏ qua */ }
}

/** Chèn banner "MOCK MODE" đầu trang nếu đang chạy mock. */
export function renderMockBanner() {
  if (!MOCK_MODE || typeof document === 'undefined') return;
  if (document.querySelector('.mock-banner')) return;
  const div = document.createElement('div');
  div.className = 'mock-banner';
  div.textContent = 'MOCK MODE — chưa kết nối Apps Script, dữ liệu lưu cục bộ trên trình duyệt này';
  document.body.insertBefore(div, document.body.firstChild);
}

// ===== PHẦN 2: MOCK MODE — mô phỏng đúng hành vi backend (apps-script/*.gs) =====

const MOCK_PASSWORD = 'Test1234';
const REASONS = ['PERSONAL', 'ANNUAL_LEAVE', 'MATERNITY', 'SICK', 'JOB_ACCIDENT', 'OTHER'];
const ROLES = ['admin', 'hr', 'manager', 'supervisor', 'security'];
const FINAL = ['APPROVED', 'OUT', 'COMPLETED', 'REJECTED'];

function pad2(n) { return String(n).padStart(2, '0'); }
function localDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayStr() { return localDate(new Date()); }
function nowIso() { return new Date().toISOString(); }
function lc(s) { return String(s || '').toLowerCase(); }
function str(v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max || 500); }

function mockThrow(code, message) { throw makeApiError(code, message); }

/** Chữ ký giả vẽ bằng canvas để demo PDF có chữ ký. */
function fakeSignature(name) {
  try {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 100;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = '#1a3a8a';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    let x = 20;
    ctx.moveTo(x, 60);
    for (let i = 0; i < 14; i++) {
      x += 18;
      ctx.quadraticCurveTo(x - 9, (i % 2 ? 20 : 85), x, 55 + (i % 3) * 6);
    }
    ctx.stroke();
    ctx.font = 'italic 16px Georgia, serif';
    ctx.fillStyle = '#1a3a8a';
    ctx.fillText(name, 30, 92);
    return c.toDataURL('image/png');
  } catch (err) {
    return '';
  }
}

function seedDb() {
  const now = nowIso();
  const u = (username, fullName, emplId, dept, role, sig) => ({
    username, fullName, emplId, dept, role, email: username + '@wahl.com', status: 'ACTIVE',
    passwordMock: MOCK_PASSWORD, mustChangePw: false, sigDataUrl: sig ? fakeSignature(fullName) : '',
    createdAt: now, failedCount: 0, lockedUntil: 0
  });
  const users = [
    u('admin', 'Quản Trị Hệ Thống', 'ADMIN001', '', 'admin', true),
    u('hr01', 'Phạm Thị Nhân Sự', 'NV103', 'HR', 'hr', true),
    u('sup01', 'Lê Văn Giám Sát', 'NV101', 'QA', 'supervisor', true),
    u('mgr01', 'Trần Thị Trưởng QA', 'NV102', 'QA', 'manager', true),
    u('sup02', 'Ngô Minh Tổ Trưởng', 'NV201', 'Sản xuất', 'supervisor', true),
    u('mgr02', 'Đặng Quốc Quản Đốc', 'NV202', 'Sản xuất', 'manager', false)
  ];
  const departments = [
    { dept: 'HR', supervisorUsernames: [], managerUsername: '' },
    { dept: 'QA', supervisorUsernames: ['sup01'], managerUsername: 'mgr01' },
    { dept: 'Sản xuất', supervisorUsernames: ['sup02'], managerUsername: 'mgr02' }
  ];
  const db = {
    requests: [], users, sessions: [], departments,
    config: { MAX_REQUESTS_PER_EMPL_PER_DAY: '5', MAX_REGISTER_PER_DAY: '20', MAX_PENDING_USERS: '50', EMAIL_NOTIFICATIONS_ENABLED: 'false' },
    auditLog: []
  };
  // Vài giấy phép mẫu hôm nay để dashboard bảo vệ có dữ liệu demo.
  const t = todayStr();
  const mk = (i, fullName, emplId, dept, out, inn, reason, status, sup, mgr) => {
    const r = {
      requestId: 'GP-' + t.replace(/-/g, '') + '-00' + i, createdAt: now, date: t, fullName, emplId, dept,
      comeOutPlanned: out, comeInPlanned: inn, reason, reasonDetail: '', status,
      supId: sup, mgrId: mgr, hrId: '', supAt: '', mgrAt: '', hrAt: '', rejectedBy: '', rejectReason: '',
      guardOutBy: '', guardOutAt: '', guardInBy: '', guardInAt: '',
      applicantSigDataUrl: fakeSignature(fullName), supSigDataUrl: '', mgrSigDataUrl: '', hrSigDataUrl: '', guardSigDataUrl: '',
      version: 1
    };
    const byU = (n) => users.find((x) => x.username === n);
    if (['PENDING_MGR', 'PENDING_HR', 'APPROVED', 'REJECTED'].includes(status) && sup) { r.supAt = now; r.supSigDataUrl = byU(sup).sigDataUrl; }
    if (['PENDING_HR', 'APPROVED'].includes(status) && mgr) { r.mgrAt = now; r.mgrSigDataUrl = byU(mgr).sigDataUrl; }
    if (status === 'APPROVED') { r.hrId = 'hr01'; r.hrAt = now; r.hrSigDataUrl = byU('hr01').sigDataUrl; }
    if (status === 'REJECTED') { r.rejectedBy = mgr; r.rejectReason = 'Trùng lịch kiểm hàng'; }
    return r;
  };
  db.requests.push(
    mk(1, 'Nguyễn Văn An', 'NV301', 'QA', '08:30', '10:00', 'PERSONAL', 'APPROVED', 'sup01', 'mgr01'),
    mk(2, 'Trần Thị Bình', 'NV302', 'Sản xuất', '09:15', '11:30', 'SICK', 'PENDING_HR', 'sup02', 'mgr02'),
    mk(3, 'Lê Hoàng Cường', 'NV303', 'QA', '13:00', '', 'ANNUAL_LEAVE', 'PENDING_SUP', 'sup01', 'mgr01'),
    mk(4, 'Phạm Minh Dũng', 'NV304', 'Sản xuất', '15:45', '16:30', 'PERSONAL', 'REJECTED', 'sup02', 'mgr02')
  );
  return db;
}

function loadDb() {
  const ls = safeStorage('local');
  try {
    const raw = ls ? ls.getItem(MOCK_DB_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users)) return parsed;
    }
  } catch (err) { /* seed lại */ }
  const fresh = seedDb();
  saveDb(fresh);
  return fresh;
}

function saveDb(db) {
  const ls = safeStorage('local');
  try { if (ls) ls.setItem(MOCK_DB_KEY, JSON.stringify(db)); } catch (err) { /* bỏ qua */ }
}

function findUser(db, username) {
  const t = lc(username);
  return t ? db.users.find((u) => lc(u.username) === t) || null : null;
}

function findDept(db, name) {
  const t = lc(name);
  return t ? db.departments.find((d) => lc(d.dept) === t) || null : null;
}

function audit(db, actor, action, targetId, detail) {
  db.auditLog.push({ time: nowIso(), actor: actor || 'SYSTEM', action, targetId: targetId || '', detail: detail || '' });
  if (db.auditLog.length > 500) db.auditLog = db.auditLog.slice(-500);
}

function userDto(u) {
  return {
    username: u.username, fullName: u.fullName || '', emplId: u.emplId || '', dept: u.dept || '',
    role: u.role || '', email: u.email || '', status: u.status, mustChangePw: !!u.mustChangePw,
    hasSignature: !!u.sigDataUrl, createdAt: u.createdAt || ''
  };
}

function reqDto(r) {
  return {
    requestId: r.requestId, createdAt: r.createdAt, date: r.date, fullName: r.fullName, emplId: r.emplId,
    dept: r.dept, comeOutPlanned: r.comeOutPlanned, comeInPlanned: r.comeInPlanned, reason: r.reason,
    reasonDetail: r.reasonDetail, status: r.status, supId: r.supId, mgrId: r.mgrId, hrId: r.hrId,
    supAt: r.supAt, mgrAt: r.mgrAt, hrAt: r.hrAt, rejectedBy: r.rejectedBy, rejectReason: r.rejectReason,
    guardOutBy: r.guardOutBy, guardOutAt: r.guardOutAt, guardInBy: r.guardInBy, guardInAt: r.guardInAt,
    version: r.version
  };
}

function approverOption(db, username, requiredRole) {
  const u = findUser(db, username);
  if (!u || u.status !== 'ACTIVE') return null;
  if (requiredRole && u.role !== requiredRole && u.role !== 'admin') return null;
  return { username: u.username, fullName: u.fullName || '' };
}

function deptInfo(db, d) {
  return {
    dept: d.dept,
    supervisors: d.supervisorUsernames.map((s) => approverOption(db, s, 'supervisor')).filter(Boolean),
    manager: d.managerUsername ? approverOption(db, d.managerUsername, 'manager') : null
  };
}

function namesFor(db, dtos) {
  const names = {};
  dtos.forEach((r) => {
    ['supId', 'mgrId', 'hrId', 'rejectedBy', 'guardOutBy', 'guardInBy'].forEach((f) => {
      const n = r[f];
      if (!n || names[n] !== undefined) return;
      const u = findUser(db, n);
      names[n] = u ? (u.fullName || n) : n;
    });
  });
  return names;
}

function ensureDept(db, name) {
  let d = findDept(db, name);
  if (!d) {
    d = { dept: name, supervisorUsernames: [], managerUsername: '' };
    db.departments.push(d);
  }
  return d;
}

/** Giống syncUserDeptLink ở Departments.gs. */
function syncLink(db, username, newRole, newDept, oldRole, oldDept) {
  const me = lc(username);
  if (newDept) ensureDept(db, newDept);
  db.departments.forEach((d) => {
    const dL = lc(d.dept);
    let idx = d.supervisorUsernames.findIndex((s) => lc(s) === me);
    if (idx >= 0 && (newRole !== 'supervisor' || (oldRole === 'supervisor' && dL === lc(oldDept) && dL !== lc(newDept)))) {
      d.supervisorUsernames.splice(idx, 1);
      idx = -1;
    }
    if (newRole === 'supervisor' && dL === lc(newDept) && idx < 0) d.supervisorUsernames.push(username);
    let isMgr = lc(d.managerUsername) === me;
    if (isMgr && (newRole !== 'manager' || (oldRole === 'manager' && dL === lc(oldDept) && dL !== lc(newDept)))) {
      d.managerUsername = '';
      isMgr = false;
    }
    if (newRole === 'manager' && dL === lc(newDept) && !isMgr) {
      const cur = findUser(db, d.managerUsername);
      if (!(cur && cur.status === 'ACTIVE' && cur.role === 'manager')) d.managerUsername = username;
    }
  });
}

function linkedDepts(db, user) {
  const set = new Set();
  if (user.dept) set.add(lc(user.dept));
  const me = lc(user.username);
  db.departments.forEach((d) => {
    if (lc(d.managerUsername) === me || d.supervisorUsernames.some((s) => lc(s) === me)) set.add(lc(d.dept));
  });
  return set;
}

function canSee(user, set, r) {
  const me = lc(user.username);
  return lc(r.supId) === me || lc(r.mgrId) === me || set.has(lc(r.dept));
}

function isStrong(pw) { return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function genTemp() { return 'Gp' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10); }

function getReq(db, id) {
  const r = db.requests.find((x) => x.requestId === id);
  if (!r) mockThrow('NOT_FOUND', 'Không tìm thấy giấy phép');
  return r;
}

function canAct(user, r) {
  if (user.role === 'admin') return true;
  if (r.status === 'PENDING_SUP') return user.role === 'supervisor' && lc(r.supId) === lc(user.username);
  if (r.status === 'PENDING_MGR') return user.role === 'manager' && lc(r.mgrId) === lc(user.username);
  if (r.status === 'PENDING_HR') return user.role === 'hr';
  return false;
}

function sigs(r) {
  return {
    applicant: r.applicantSigDataUrl || null, supervisor: r.supSigDataUrl || null, manager: r.mgrSigDataUrl || null,
    hr: r.hrSigDataUrl || null, security: r.guardSigDataUrl || null
  };
}

// Phân quyền giống ACTION_CONFIG trong Code.gs.
const PUBLIC = ['getDepartments', 'getApproverOptions', 'submitRequest', 'getRequestStatus', 'register', 'login', 'listToday'];
const AUTHED = ['logout', 'me', 'changePassword', 'uploadMySignature', 'getMySignature'];
const STAFF = ['hr', 'admin', 'manager', 'supervisor'];
const ROLE_ACTIONS = {
  listRequests: STAFF, approve: STAFF, reject: STAFF,
  getRequestPdfData: STAFF.concat(['security']),
  listUsers: ['admin'], listPendingUsers: ['admin'], activateUser: ['admin'], rejectUser: ['admin'],
  createUser: ['admin'], updateUser: ['admin'], resetPassword: ['admin'], uploadUserSignature: ['admin'],
  setConfig: ['admin'], getConfig: ['admin'], listAuditLog: ['admin'],
  listDepartmentsAdmin: ['admin'], saveDepartment: ['admin'], deleteDepartment: ['admin'],
  recordOut: ['security', 'hr', 'admin'], recordIn: ['security', 'hr', 'admin']
};

const H = {
  getDepartments(db) {
    const list = db.departments.map((d) => deptInfo(db, d)).sort((a, b) => a.dept.localeCompare(b.dept));
    return { departments: list };
  },

  getApproverOptions(db, p) {
    const d = findDept(db, p.dept);
    if (!d) return { supervisors: [], manager: null };
    const info = deptInfo(db, d);
    return { supervisors: info.supervisors, manager: info.manager };
  },

  submitRequest(db, p) {
    if (p.honeypot) return { requestId: 'GP-00000000-000' };
    const date = str(p.date, 10) || todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) mockThrow('VALIDATION_ERROR', 'Ngày không hợp lệ (định dạng YYYY-MM-DD)');
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    const out = str(p.comeOutPlanned, 5);
    const inn = str(p.comeInPlanned, 5);
    if (out && !timeRe.test(out)) mockThrow('VALIDATION_ERROR', 'Giờ ra dự kiến không hợp lệ (HH:mm)');
    if (inn && !timeRe.test(inn)) mockThrow('VALIDATION_ERROR', 'Giờ vào dự kiến không hợp lệ (HH:mm)');
    const reason = str(p.reason, 30);
    if (reason && REASONS.indexOf(reason) < 0) mockThrow('VALIDATION_ERROR', 'Lý do không hợp lệ');
    const emplId = str(p.emplId, 40);
    let max = parseInt(db.config.MAX_REQUESTS_PER_EMPL_PER_DAY, 10) || 5;
    if (!emplId) max *= 10;
    const used = db.requests.filter((r) => lc(r.emplId) === lc(emplId) && r.date === todayStr()).length;
    if (used >= max) mockThrow('RATE_LIMITED', 'Đã đạt giới hạn số giấy phép trong ngày');
    const sup = p.supId ? approverOption(db, p.supId, 'supervisor') : null;
    const mgr = p.mgrId ? approverOption(db, p.mgrId, 'manager') : null;
    const prefix = 'GP-' + todayStr().replace(/-/g, '') + '-';
    const maxSeq = db.requests.reduce((m, r) => (r.requestId.indexOf(prefix) === 0 ? Math.max(m, parseInt(r.requestId.slice(prefix.length), 10) || 0) : m), 0);
    const id = prefix + String(maxSeq + 1).padStart(3, '0');
    db.requests.push({
      requestId: id, createdAt: nowIso(), date, fullName: str(p.fullName, 120), emplId, dept: str(p.dept, 80),
      comeOutPlanned: out, comeInPlanned: inn, reason, reasonDetail: str(p.reasonDetail, 500),
      status: sup ? 'PENDING_SUP' : (mgr ? 'PENDING_MGR' : 'PENDING_HR'),
      supId: sup ? sup.username : '', mgrId: mgr ? mgr.username : '', hrId: '', supAt: '', mgrAt: '', hrAt: '',
      rejectedBy: '', rejectReason: '', guardOutBy: '', guardOutAt: '', guardInBy: '', guardInAt: '',
      applicantSigDataUrl: p.applicantSignature || '', supSigDataUrl: '', mgrSigDataUrl: '', hrSigDataUrl: '',
      guardSigDataUrl: '', version: 1
    });
    audit(db, emplId, 'SUBMIT_REQUEST', id, 'Gửi giấy phép ra/vào cổng');
    return { requestId: id };
  },

  getRequestStatus(db, p) {
    if (!p.requestId || !p.emplId) mockThrow('VALIDATION_ERROR', 'Thiếu trường bắt buộc: requestId, emplId');
    const r = db.requests.find((x) => x.requestId === str(p.requestId) && lc(x.emplId) === lc(str(p.emplId)));
    if (!r) mockThrow('NOT_FOUND', 'Không tìm thấy giấy phép');
    const timeline = [];
    if (r.supAt) timeline.push({ step: 'PENDING_SUP', by: r.supId, at: r.supAt, action: 'APPROVE' });
    if (r.mgrAt) timeline.push({ step: 'PENDING_MGR', by: r.mgrId, at: r.mgrAt, action: 'APPROVE' });
    if (r.hrAt) timeline.push({ step: 'PENDING_HR', by: r.hrId, at: r.hrAt, action: 'APPROVE' });
    if (r.guardOutAt) timeline.push({ step: 'OUT', by: r.guardOutBy, at: r.guardOutAt, action: 'RECORD_OUT' });
    if (r.guardInAt) timeline.push({ step: 'COMPLETED', by: r.guardInBy, at: r.guardInAt, action: 'RECORD_IN' });
    if (r.rejectedBy) timeline.push({ step: 'REJECTED', by: r.rejectedBy, at: '', action: 'REJECT' });
    const ready = ['APPROVED', 'OUT', 'COMPLETED'].indexOf(r.status) >= 0;
    return { request: reqDto(r), timeline, signatures: ready ? sigs(r) : null, names: namesFor(db, [r]) };
  },

  register(db, p) {
    if (p.honeypot) return { message: 'Tài khoản đang chờ admin kích hoạt' };
    if (!p.username || !p.password || !p.confirmPassword) mockThrow('VALIDATION_ERROR', 'Thiếu trường bắt buộc: username, password');
    const email = str(p.email, 120);
    if (email && !isEmail(email)) mockThrow('VALIDATION_ERROR', 'Email không hợp lệ');
    if (!isStrong(p.password)) mockThrow('VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 8 ký tự, gồm cả chữ và số');
    if (p.password !== p.confirmPassword) mockThrow('VALIDATION_ERROR', 'Mật khẩu xác nhận không khớp');
    if (findUser(db, p.username)) mockThrow('VALIDATION_ERROR', 'Tên đăng nhập đã tồn tại');
    const emplId = str(p.emplId, 40);
    if (emplId && db.users.some((u) => lc(u.emplId) === lc(emplId))) mockThrow('VALIDATION_ERROR', 'Mã nhân viên đã được đăng ký');
    db.users.push({
      username: str(p.username, 60), fullName: str(p.fullName, 120), emplId, dept: str(p.dept, 80), role: '',
      email, status: 'PENDING', passwordMock: p.password, mustChangePw: false, sigDataUrl: '', createdAt: nowIso(),
      failedCount: 0, lockedUntil: 0
    });
    audit(db, p.username, 'REGISTER', p.username, 'Đăng ký tài khoản mới');
    return { message: 'Tài khoản đang chờ admin kích hoạt' };
  },

  login(db, p) {
    const u = findUser(db, p.username);
    if (!u) mockThrow('UNAUTHENTICATED', 'Sai tên đăng nhập hoặc mật khẩu');
    if (u.status === 'LOCKED' || (u.lockedUntil && u.lockedUntil > Date.now())) {
      mockThrow('LOCKED_ACCOUNT', 'Tài khoản đang bị khóa tạm thời, vui lòng thử lại sau');
    }
    if (u.passwordMock !== p.password) {
      u.failedCount = (u.failedCount || 0) + 1;
      if (u.failedCount >= 5) u.lockedUntil = Date.now() + 15 * 60 * 1000;
      saveDb(db);
      mockThrow('UNAUTHENTICATED', 'Sai tên đăng nhập hoặc mật khẩu');
    }
    if (u.status !== 'ACTIVE') mockThrow('FORBIDDEN', 'Tài khoản chưa được kích hoạt hoặc đã bị từ chối');
    u.failedCount = 0;
    u.lockedUntil = 0;
    // Dọn phiên hết hạn + giữ tối đa 3 phiên mỗi user (giống purgeSessions()).
    const now = Date.now();
    db.sessions = db.sessions.filter((s) => s.expiresAt > now);
    const mine = db.sessions.filter((s) => lc(s.username) === lc(u.username)).sort((a, b) => b.expiresAt - a.expiresAt);
    const drop = new Set(mine.slice(3).map((s) => s.token));
    db.sessions = db.sessions.filter((s) => !drop.has(s.token));
    const session = {
      token: 'mock-' + now + '-' + Math.random().toString(36).slice(2),
      username: u.username, expiresAt: now + (u.role === 'security' ? 12 : 8) * 3600 * 1000
    };
    db.sessions.push(session);
    audit(db, u.username, 'LOGIN', u.username, 'Đăng nhập thành công');
    return { token: session.token, user: userDto(u) };
  },

  listToday(db, p) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(str(p.date)) ? str(p.date) : todayStr();
    const full = db.requests.filter((r) => r.date === day)
      .sort((a, b) => (a.comeOutPlanned || '99:99').localeCompare(b.comeOutPlanned || '99:99'));
    const requests = full.map((r) => ({
      requestId: r.requestId, date: r.date, fullName: r.fullName, emplId: r.emplId, dept: r.dept,
      comeOutPlanned: r.comeOutPlanned, comeInPlanned: r.comeInPlanned, status: r.status,
      supId: r.supId, supAt: r.supAt, mgrId: r.mgrId, mgrAt: r.mgrAt, hrId: r.hrId, hrAt: r.hrAt,
      rejectedBy: r.rejectedBy, guardOutAt: r.guardOutAt, guardInAt: r.guardInAt
    }));
    return { date: day, requests, names: namesFor(db, full), serverTime: nowIso() };
  },

  logout(db, p, ctx) {
    db.sessions = db.sessions.filter((s) => s.token !== ctx.session.token);
    return {};
  },

  me(db, p, ctx) { return { user: userDto(ctx.user) }; },

  changePassword(db, p, ctx) {
    if (ctx.user.passwordMock !== p.oldPassword) mockThrow('UNAUTHENTICATED', 'Mật khẩu cũ không đúng');
    if (!isStrong(p.newPassword)) mockThrow('VALIDATION_ERROR', 'Mật khẩu mới phải có ít nhất 8 ký tự, gồm cả chữ và số');
    ctx.user.passwordMock = p.newPassword;
    ctx.user.mustChangePw = false;
    return {};
  },

  uploadMySignature(db, p, ctx) {
    if (!p.imageBase64) mockThrow('VALIDATION_ERROR', 'Thiếu trường bắt buộc: imageBase64');
    ctx.user.sigDataUrl = p.imageBase64;
    return {};
  },

  getMySignature(db, p, ctx) { return { dataUrl: ctx.user.sigDataUrl || null }; },

  listRequests(db, p, ctx) {
    const scoped = ctx.user.role === 'manager' || ctx.user.role === 'supervisor';
    const set = scoped ? linkedDepts(db, ctx.user) : null;
    const list = db.requests.filter((r) => {
      if (p.dateFrom && r.date < p.dateFrom) return false;
      if (p.dateTo && r.date > p.dateTo) return false;
      if (scoped && !canSee(ctx.user, set, r)) return false;
      if (p.dept && lc(r.dept) !== lc(p.dept)) return false;
      if (p.status && r.status !== p.status) return false;
      return true;
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { requests: list.map(reqDto), names: namesFor(db, list) };
  },

  approve(db, p, ctx) {
    const r = getReq(db, p.requestId);
    if (r.version !== Number(p.version)) mockThrow('CONFLICT_VERSION', 'Giấy phép đã được cập nhật bởi người khác, vui lòng tải lại');
    if (FINAL.indexOf(r.status) >= 0) mockThrow('INVALID_TRANSITION', 'Giấy phép đã ở trạng thái cuối, không thể duyệt');
    if (!canAct(ctx.user, r)) mockThrow('FORBIDDEN', 'Bạn không có quyền duyệt bước này');
    if (!ctx.user.sigDataUrl) mockThrow('VALIDATION_ERROR', 'Bạn chưa có chữ ký số, vui lòng upload trước khi duyệt');
    const now = nowIso();
    const from = r.status;
    if (r.status === 'PENDING_SUP') {
      r.status = r.mgrId ? 'PENDING_MGR' : 'PENDING_HR'; r.supSigDataUrl = ctx.user.sigDataUrl; r.supAt = now;
    } else if (r.status === 'PENDING_MGR') {
      r.status = 'PENDING_HR'; r.mgrSigDataUrl = ctx.user.sigDataUrl; r.mgrAt = now;
    } else {
      r.status = 'APPROVED'; r.hrId = ctx.user.username; r.hrSigDataUrl = ctx.user.sigDataUrl; r.hrAt = now;
    }
    r.version += 1;
    audit(db, ctx.user.username, 'APPROVE', r.requestId, 'Duyệt bước ' + from);
    return { request: reqDto(r) };
  },

  reject(db, p, ctx) {
    const r = getReq(db, p.requestId);
    if (!p.reason || !String(p.reason).trim()) mockThrow('VALIDATION_ERROR', 'Vui lòng nhập lý do từ chối');
    if (r.version !== Number(p.version)) mockThrow('CONFLICT_VERSION', 'Giấy phép đã được cập nhật bởi người khác, vui lòng tải lại');
    if (FINAL.indexOf(r.status) >= 0) mockThrow('INVALID_TRANSITION', 'Không thể từ chối ở trạng thái hiện tại');
    if (!canAct(ctx.user, r)) mockThrow('FORBIDDEN', 'Bạn không có quyền từ chối bước này');
    audit(db, ctx.user.username, 'REJECT', r.requestId, 'Từ chối bước ' + r.status);
    r.status = 'REJECTED'; r.rejectedBy = ctx.user.username; r.rejectReason = str(p.reason, 500); r.version += 1;
    return { request: reqDto(r) };
  },

  getRequestPdfData(db, p, ctx) {
    const r = getReq(db, p.requestId);
    const role = ctx.user.role;
    let ok = role === 'hr' || role === 'admin' || role === 'security';
    if (!ok && (role === 'manager' || role === 'supervisor')) ok = canSee(ctx.user, linkedDepts(db, ctx.user), r);
    if (!ok) mockThrow('FORBIDDEN', 'Bạn không có quyền xem giấy phép này');
    return { request: reqDto(r), signatures: sigs(r), names: namesFor(db, [r]) };
  },

  listUsers(db) { return { users: db.users.map(userDto) }; },
  listPendingUsers(db) { return { users: db.users.filter((u) => u.status === 'PENDING').map(userDto) }; },

  activateUser(db, p, ctx) {
    if (ROLES.indexOf(p.role) < 0) mockThrow('VALIDATION_ERROR', 'Role không hợp lệ');
    const u = findUser(db, p.username);
    if (!u) mockThrow('NOT_FOUND', 'Không tìm thấy người dùng');
    if (u.status !== 'PENDING') mockThrow('VALIDATION_ERROR', 'Tài khoản không ở trạng thái chờ duyệt');
    if (p.dept !== undefined && p.dept !== null) u.dept = str(p.dept, 80);
    u.role = p.role; u.status = 'ACTIVE'; u.approvedBy = ctx.user.username;
    syncLink(db, u.username, u.role, u.dept, '', '');
    audit(db, ctx.user.username, 'ACTIVATE_USER', u.username, 'Gán role ' + u.role);
    return {};
  },

  rejectUser(db, p, ctx) {
    const u = findUser(db, p.username);
    if (!u) mockThrow('NOT_FOUND', 'Không tìm thấy người dùng');
    u.status = 'REJECTED';
    audit(db, ctx.user.username, 'REJECT_USER', u.username, 'Từ chối tài khoản đăng ký');
    return {};
  },

  createUser(db, p, ctx) {
    const username = str(p.username, 60);
    if (!username) mockThrow('VALIDATION_ERROR', 'Vui lòng nhập tên đăng nhập');
    const role = str(p.role, 40);
    if (role && ROLES.indexOf(role) < 0) mockThrow('VALIDATION_ERROR', 'Role không hợp lệ');
    const email = str(p.email, 120);
    if (email && !isEmail(email)) mockThrow('VALIDATION_ERROR', 'Email không hợp lệ');
    let temp = p.tempPassword ? String(p.tempPassword) : '';
    const generated = !temp;
    if (temp && !isStrong(temp)) mockThrow('VALIDATION_ERROR', 'Mật khẩu tạm phải có ít nhất 8 ký tự, gồm cả chữ và số');
    if (generated) temp = genTemp();
    if (findUser(db, username)) mockThrow('VALIDATION_ERROR', 'Tên đăng nhập đã tồn tại');
    const emplId = str(p.emplId, 40);
    if (emplId && db.users.some((u) => lc(u.emplId) === lc(emplId))) mockThrow('VALIDATION_ERROR', 'Mã nhân viên đã được đăng ký');
    const dept = str(p.dept, 80);
    db.users.push({
      username, fullName: str(p.fullName, 120), emplId, dept, role, email, status: 'ACTIVE',
      passwordMock: temp, mustChangePw: true, sigDataUrl: '', createdAt: nowIso(), failedCount: 0, lockedUntil: 0
    });
    syncLink(db, username, role, dept, '', '');
    audit(db, ctx.user.username, 'CREATE_USER', username, 'Tạo tài khoản với role ' + (role || '(chưa có)'));
    return generated ? { tempPassword: temp } : {};
  },

  updateUser(db, p, ctx) {
    const u = findUser(db, p.username);
    if (!u) mockThrow('NOT_FOUND', 'Không tìm thấy người dùng');
    const self = lc(u.username) === lc(ctx.user.username);
    const oldRole = u.role, oldDept = u.dept;
    const has = (k) => p[k] !== undefined && p[k] !== null;
    if (has('role')) {
      if (p.role && ROLES.indexOf(p.role) < 0) mockThrow('VALIDATION_ERROR', 'Role không hợp lệ');
      if (!p.role && self) mockThrow('VALIDATION_ERROR', 'Không thể tự gỡ vai trò của chính mình');
    }
    if (has('email') && p.email && !isEmail(p.email)) mockThrow('VALIDATION_ERROR', 'Email không hợp lệ');
    if (has('status') && p.status !== 'ACTIVE' && self) mockThrow('VALIDATION_ERROR', 'Không thể tự khoá tài khoản của chính mình');
    if (has('emplId') && p.emplId && lc(p.emplId) !== lc(u.emplId) && db.users.some((x) => x !== u && lc(x.emplId) === lc(p.emplId))) {
      mockThrow('VALIDATION_ERROR', 'Mã nhân viên đã được đăng ký');
    }
    ['fullName', 'emplId', 'dept', 'role', 'email', 'status'].forEach((k) => { if (has(k)) u[k] = str(p[k], 120); });
    if (u.status === 'ACTIVE') { u.failedCount = 0; u.lockedUntil = 0; }
    if (u.role !== oldRole || u.dept !== oldDept) syncLink(db, u.username, u.role, u.dept, oldRole, oldDept);
    audit(db, ctx.user.username, 'UPDATE_USER', u.username, 'Cập nhật thông tin người dùng');
    return {};
  },

  resetPassword(db, p, ctx) {
    const u = findUser(db, p.username);
    if (!u) mockThrow('NOT_FOUND', 'Không tìm thấy người dùng');
    let temp = p.tempPassword ? String(p.tempPassword) : '';
    const generated = !temp;
    if (temp && !isStrong(temp)) mockThrow('VALIDATION_ERROR', 'Mật khẩu tạm phải có ít nhất 8 ký tự, gồm cả chữ và số');
    if (generated) temp = genTemp();
    u.passwordMock = temp; u.mustChangePw = true; u.failedCount = 0; u.lockedUntil = 0;
    audit(db, ctx.user.username, 'RESET_PASSWORD', u.username, 'Reset mật khẩu người dùng');
    return generated ? { tempPassword: temp } : {};
  },

  uploadUserSignature(db, p, ctx) {
    const u = findUser(db, p.username);
    if (!u) mockThrow('NOT_FOUND', 'Không tìm thấy người dùng');
    u.sigDataUrl = p.imageBase64 || '';
    audit(db, ctx.user.username, 'UPLOAD_SIGNATURE_ADMIN', u.username, 'Admin cập nhật chữ ký người dùng');
    return {};
  },

  setConfig(db, p, ctx) {
    if (!p.key) mockThrow('VALIDATION_ERROR', 'Key không được rỗng');
    db.config[p.key] = str(p.value, 500);
    audit(db, ctx.user.username, 'SET_CONFIG', p.key, 'value=' + p.value);
    return {};
  },

  getConfig(db) { return { config: Object.assign({}, db.config) }; },

  listAuditLog(db, p) {
    let logs = db.auditLog.slice().reverse();
    if (p.dateFrom) logs = logs.filter((l) => localDate(new Date(l.time)) >= p.dateFrom);
    if (p.dateTo) logs = logs.filter((l) => localDate(new Date(l.time)) <= p.dateTo);
    if (!p.dateFrom && !p.dateTo) logs = logs.slice(0, 200);
    return { logs };
  },

  listDepartmentsAdmin(db) {
    const departments = db.departments.map((d) => ({
      dept: d.dept, supervisorUsernames: d.supervisorUsernames.slice(), managerUsername: d.managerUsername,
      memberCount: db.users.filter((u) => lc(u.dept) === lc(d.dept)).length
    })).sort((a, b) => a.dept.localeCompare(b.dept));
    return { departments };
  },

  saveDepartment(db, p, ctx) {
    const dept = str(p.dept, 80);
    if (!dept) mockThrow('VALIDATION_ERROR', 'Vui lòng nhập tên bộ phận');
    const sups = [];
    (Array.isArray(p.supervisorUsernames) ? p.supervisorUsernames : []).forEach((s) => {
      const u = findUser(db, s);
      if (!u) mockThrow('VALIDATION_ERROR', 'Không tìm thấy người dùng: ' + s);
      if (u.role !== 'supervisor' && u.role !== 'admin') mockThrow('VALIDATION_ERROR', s + ' chưa có vai trò Giám sát (supervisor)');
      if (sups.indexOf(u.username) < 0) sups.push(u.username);
    });
    let mgr = '';
    if (p.managerUsername) {
      const u = findUser(db, p.managerUsername);
      if (!u) mockThrow('VALIDATION_ERROR', 'Không tìm thấy người dùng: ' + p.managerUsername);
      if (u.role !== 'manager' && u.role !== 'admin') mockThrow('VALIDATION_ERROR', p.managerUsername + ' chưa có vai trò Trưởng bộ phận (manager)');
      mgr = u.username;
    }
    const existing = p.originalDept ? findDept(db, p.originalDept) : null;
    if (p.originalDept && !existing) mockThrow('NOT_FOUND', 'Không tìm thấy bộ phận ' + p.originalDept);
    const clash = findDept(db, dept);
    if (clash && clash !== existing) mockThrow('VALIDATION_ERROR', 'Bộ phận "' + dept + '" đã tồn tại');
    if (existing) {
      const oldName = existing.dept;
      existing.dept = dept; existing.supervisorUsernames = sups; existing.managerUsername = mgr;
      if (oldName !== dept) db.users.forEach((u) => { if (lc(u.dept) === lc(oldName)) u.dept = dept; });
    } else {
      db.departments.push({ dept, supervisorUsernames: sups, managerUsername: mgr });
    }
    audit(db, ctx.user.username, 'SAVE_DEPARTMENT', dept, 'Giám sát: ' + (sups.join(',') || '-') + ' | Trưởng BP: ' + (mgr || '-'));
    return {};
  },

  deleteDepartment(db, p, ctx) {
    const d = findDept(db, p.dept);
    if (!d) mockThrow('NOT_FOUND', 'Không tìm thấy bộ phận');
    db.departments = db.departments.filter((x) => x !== d);
    audit(db, ctx.user.username, 'DELETE_DEPARTMENT', d.dept, 'Xoá bộ phận');
    return {};
  },

  recordOut(db, p, ctx) {
    const r = getReq(db, p.requestId);
    if (r.version !== Number(p.version)) mockThrow('CONFLICT_VERSION', 'Giấy phép đã được cập nhật bởi người khác, vui lòng tải lại');
    if (r.status !== 'APPROVED') mockThrow('INVALID_TRANSITION', 'Giấy phép chưa được duyệt đủ hoặc đã cho ra rồi');
    r.status = 'OUT'; r.guardOutBy = ctx.user.username; r.guardOutAt = nowIso();
    r.guardSigDataUrl = ctx.user.sigDataUrl || r.guardSigDataUrl; r.version += 1;
    return { request: reqDto(r) };
  },

  recordIn(db, p, ctx) {
    const r = getReq(db, p.requestId);
    if (r.version !== Number(p.version)) mockThrow('CONFLICT_VERSION', 'Giấy phép đã được cập nhật bởi người khác, vui lòng tải lại');
    if (r.status !== 'OUT') mockThrow('INVALID_TRANSITION', 'Giấy phép chưa được cho ra hoặc đã hoàn tất');
    r.status = 'COMPLETED'; r.guardInBy = ctx.user.username; r.guardInAt = nowIso();
    r.guardSigDataUrl = ctx.user.sigDataUrl || r.guardSigDataUrl; r.version += 1;
    return { request: reqDto(r) };
  }
};

function requireSession(db, token) {
  const s = token ? db.sessions.find((x) => x.token === token) : null;
  const u = s ? findUser(db, s.username) : null;
  if (!s || s.expiresAt <= Date.now() || !u || u.status !== 'ACTIVE') {
    clearToken();
    mockThrow('SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
  }
  return { session: s, user: u };
}

async function mockCallApi(action, payload) {
  // Độ trễ nhỏ để giao diện loading hiển thị giống khi gọi máy chủ thật.
  await new Promise((r) => setTimeout(r, 120));
  const handler = H[action];
  if (!handler) mockThrow('UNKNOWN_ACTION', 'Hành động không tồn tại');
  const db = loadDb();
  let ctx = null;
  if (PUBLIC.indexOf(action) < 0) {
    ctx = requireSession(db, getToken());
    const roles = ROLE_ACTIONS[action];
    if (AUTHED.indexOf(action) < 0 && (!roles || roles.indexOf(ctx.user.role) < 0)) {
      mockThrow('FORBIDDEN', 'Bạn không có quyền thực hiện hành động này');
    }
  }
  const data = handler(db, payload || {}, ctx);
  saveDb(db);
  // Trả bản sao để UI không vô tình sửa "DB".
  return JSON.parse(JSON.stringify(data));
}
