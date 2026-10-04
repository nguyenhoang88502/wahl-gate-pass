// tests/backend.test.mjs
// Test Node (node:test) chạy trực tiếp logic apps-script/*.gs qua stub trong gas-stub.mjs.
// Chạy: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGasEnv,
  createReadyGasEnv,
  seedUser,
  seedUserSignature,
  seedDepartment,
  loginAs,
  FAKE_SIGNATURE_PNG
} from './gas-stub.mjs';

function freshEnv() {
  const env = createReadyGasEnv('AdminTmp123');
  return env;
}

// ---------------------------------------------------------------------------
// 1. Đăng ký không tự lên role / status (server luôn ép Role='' Status='PENDING')
// ---------------------------------------------------------------------------
test('register: client không thể tự gán role hoặc status', () => {
  const env = freshEnv();
  const res = env.callApi('register', null, {
    fullName: 'Nguyen Van A',
    emplId: 'NV900',
    dept: 'QA',
    email: 'a@wahl.com',
    username: 'newbie01',
    password: 'Abcd1234',
    confirmPassword: 'Abcd1234',
    // Cố tình chèn thêm field không được phép — server phải bỏ qua hoàn toàn:
    role: 'admin',
    status: 'ACTIVE'
  });
  assert.equal(res.ok, true, 'register phải thành công với payload hợp lệ');

  const rows = env.getSheetData('Users');
  const header = rows[0];
  const roleCol = header.indexOf('Role');
  const statusCol = header.indexOf('Status');
  const usernameCol = header.indexOf('Username');
  const created = rows.find((r) => r[usernameCol] === 'newbie01');
  assert.ok(created, 'user mới phải tồn tại trong sheet Users');
  assert.equal(created[roleCol], '', 'Role phải bị ép rỗng bất kể client gửi gì');
  assert.equal(created[statusCol], 'PENDING', 'Status phải bị ép PENDING bất kể client gửi gì');
});

test('register: đăng ký trùng username bị từ chối với VALIDATION_ERROR (không phải lỗi hệ thống chung chung)', () => {
  const env = freshEnv();
  const payload = {
    fullName: 'B', emplId: 'NV901', dept: 'QA', email: 'b@wahl.com',
    username: 'dupuser', password: 'Abcd1234', confirmPassword: 'Abcd1234'
  };
  const first = env.callApi('register', null, payload);
  assert.equal(first.ok, true);
  const second = env.callApi('register', null, { ...payload, emplId: 'NV902' });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 2. Sai role bị từ chối (FORBIDDEN)
// ---------------------------------------------------------------------------
test('sai role: tài khoản hr gọi action chỉ dành cho admin (listAuditLog) bị FORBIDDEN', () => {
  const env = freshEnv();
  seedUser(env, { username: 'hr01', dept: '', role: 'hr', password: 'Abcd1234' });
  const token = loginAs(env, 'hr01', 'Abcd1234');
  const res = env.callApi('listAuditLog', token, {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN');
});

test('sai role: tài khoản security gọi action chỉ dành cho admin (listUsers) bị FORBIDDEN', () => {
  const env = freshEnv();
  seedUser(env, { username: 'bv01', dept: '', role: 'security', password: 'Abcd1234' });
  const token = loginAs(env, 'bv01', 'Abcd1234');
  const res = env.callApi('listUsers', token, {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN');
});

test('token rỗng/không hợp lệ gọi action cần đăng nhập bị SESSION_EXPIRED', () => {
  const env = freshEnv();
  const res = env.callApi('listRequests', 'token-khong-ton-tai', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'SESSION_EXPIRED');
});

// ---------------------------------------------------------------------------
// 3. Sai bộ phận bị từ chối (manager/supervisor chỉ thấy & duyệt đúng bộ phận)
// ---------------------------------------------------------------------------
function submitRequestFor(env, { dept, supId, mgrId, emplId = 'NVX01' }) {
  const res = env.callApi('submitRequest', null, {
    fullName: 'Nhan Vien Test',
    emplId,
    dept,
    date: new Date().toISOString().slice(0, 10),
    comeOutPlanned: '08:00',
    comeInPlanned: '11:00',
    reason: 'PERSONAL',
    reasonDetail: '',
    supId: supId || '',
    mgrId,
    applicantSignature: FAKE_SIGNATURE_PNG,
    honeypot: ''
  });
  assert.equal(res.ok, true, 'submitRequest phải thành công: ' + JSON.stringify(res));
  return res.data.requestId;
}

test('sai bộ phận: manager bộ phận khác không thấy request của bộ phận khác qua listRequests', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedDepartment(env, { dept: 'SALES', managerUsername: 'mgrSALES' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUser(env, { username: 'mgrSALES', dept: 'SALES', role: 'manager', password: 'Abcd1234' });

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' });

  const tokenSales = loginAs(env, 'mgrSALES', 'Abcd1234');
  const listRes = env.callApi('listRequests', tokenSales, {});
  assert.equal(listRes.ok, true);
  const ids = listRes.data.requests.map((r) => r.requestId);
  assert.ok(!ids.includes(reqId), 'manager bộ phận SALES không được thấy request của bộ phận QA');

  const tokenQA = loginAs(env, 'mgrQA', 'Abcd1234');
  const listResQA = env.callApi('listRequests', tokenQA, {});
  assert.ok(listResQA.data.requests.map((r) => r.requestId).includes(reqId), 'manager đúng bộ phận phải thấy request của mình');
});

test('sai bộ phận: manager không phải mgrId của request bị FORBIDDEN khi approve', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedDepartment(env, { dept: 'SALES', managerUsername: 'mgrSALES' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUser(env, { username: 'mgrSALES', dept: 'SALES', role: 'manager', password: 'Abcd1234' });
  seedUserSignature(env, 'mgrSALES');

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' });

  const tokenSales = loginAs(env, 'mgrSALES', 'Abcd1234');
  const approveRes = env.callApi('approve', tokenSales, { requestId: reqId, version: 1 });
  assert.equal(approveRes.ok, false);
  assert.equal(approveRes.error.code, 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// 4. Duyệt sai thứ tự bị từ chối (INVALID_TRANSITION)
// ---------------------------------------------------------------------------
test('duyệt sai thứ tự: HR không thể duyệt khi request còn ở PENDING_MGR', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUser(env, { username: 'hr01', dept: '', role: 'hr', password: 'Abcd1234' });
  seedUserSignature(env, 'hr01');

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' }); // status PENDING_MGR (không có supId)

  const tokenHr = loginAs(env, 'hr01', 'Abcd1234');
  const res = env.callApi('approve', tokenHr, { requestId: reqId, version: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN', 'HR chưa đến lượt duyệt (status vẫn PENDING_MGR) phải bị từ chối');
});

test('duyệt sai thứ tự: không thể duyệt lại request đã APPROVED (INVALID_TRANSITION)', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUser(env, { username: 'hr01', dept: '', role: 'hr', password: 'Abcd1234' });
  seedUserSignature(env, 'mgrQA');
  seedUserSignature(env, 'hr01');

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' }); // PENDING_MGR

  const tokenMgr = loginAs(env, 'mgrQA', 'Abcd1234');
  const r1 = env.callApi('approve', tokenMgr, { requestId: reqId, version: 1 }); // -> PENDING_HR
  assert.equal(r1.ok, true);
  assert.equal(r1.data.request.status, 'PENDING_HR');

  const tokenHr = loginAs(env, 'hr01', 'Abcd1234');
  const r2 = env.callApi('approve', tokenHr, { requestId: reqId, version: 2 }); // -> APPROVED
  assert.equal(r2.ok, true);
  assert.equal(r2.data.request.status, 'APPROVED');

  const r3 = env.callApi('approve', tokenHr, { requestId: reqId, version: 3 }); // đã APPROVED, duyệt lại
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'INVALID_TRANSITION');
});

test('duyệt sai thứ tự: recordOut khi chưa APPROVED bị INVALID_TRANSITION', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUser(env, { username: 'bv01', dept: '', role: 'security', password: 'Abcd1234' });

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' }); // PENDING_MGR, chưa APPROVED

  const tokenBv = loginAs(env, 'bv01', 'Abcd1234');
  const res = env.callApi('recordOut', tokenBv, { requestId: reqId, version: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INVALID_TRANSITION');
});

test('phiên bản (version) lệch bị CONFLICT_VERSION', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUserSignature(env, 'mgrQA');

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' });
  const tokenMgr = loginAs(env, 'mgrQA', 'Abcd1234');
  const res = env.callApi('approve', tokenMgr, { requestId: reqId, version: 99 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'CONFLICT_VERSION');
});

test('duyệt khi chưa có chữ ký số bị VALIDATION_ERROR', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' }); // chưa seedUserSignature

  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA' });
  const tokenMgr = loginAs(env, 'mgrQA', 'Abcd1234');
  const res = env.callApi('approve', tokenMgr, { requestId: reqId, version: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 5. Khóa tài khoản sau 5 lần sai mật khẩu liên tiếp
// ---------------------------------------------------------------------------
test('khóa tài khoản sau 5 lần đăng nhập sai liên tiếp', () => {
  const env = freshEnv();
  seedUser(env, { username: 'locktest', dept: '', role: 'hr', password: 'Correct123' });

  for (let i = 0; i < 5; i++) {
    const res = env.callApi('login', null, { username: 'locktest', password: 'WrongPass1' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'UNAUTHENTICATED', `lần sai thứ ${i + 1} phải là UNAUTHENTICATED`);
  }

  // Lần thứ 6 — kể cả với MẬT KHẨU ĐÚNG — phải bị khóa tạm.
  const lockedRes = env.callApi('login', null, { username: 'locktest', password: 'Correct123' });
  assert.equal(lockedRes.ok, false);
  assert.equal(lockedRes.error.code, 'LOCKED_ACCOUNT', 'tài khoản phải bị khóa tạm sau 5 lần sai');
});

test('đăng nhập sai username không tồn tại trả thông báo chung chung UNAUTHENTICATED (không tiết lộ)', () => {
  const env = freshEnv();
  const res = env.callApi('login', null, { username: 'khong-ton-tai', password: 'bat-ky' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UNAUTHENTICATED');
  assert.equal(res.error.message, 'Sai tên đăng nhập hoặc mật khẩu');
});

// ---------------------------------------------------------------------------
// 6. Duyệt đồng thời không trùng RequestId
// ---------------------------------------------------------------------------
test('nhiều submitRequest liên tiếp (mô phỏng gần-đồng-thời) sinh RequestId không trùng', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgrQA' });
  seedUser(env, { username: 'mgrQA', dept: 'QA', role: 'manager', password: 'Abcd1234' });

  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = submitRequestFor(env, { dept: 'QA', mgrId: 'mgrQA', emplId: 'NVLOOP' + i });
    ids.push(id);
  }
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'tất cả RequestId sinh ra phải khác nhau: ' + ids.join(','));
  for (const id of ids) {
    assert.match(id, /^GP-\d{8}-\d{3}$/, 'RequestId phải đúng định dạng GP-YYYYMMDD-NNN');
  }
});

// ---------------------------------------------------------------------------
// 7. Luồng đầy đủ: đăng ký -> kích hoạt -> gửi -> duyệt sup/mgr/hr -> ra -> vào -> tra cứu
// ---------------------------------------------------------------------------
test('luồng đầy đủ end-to-end thành công', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', supervisorUsernames: 'sup01', managerUsername: 'mgr01' });
  seedUser(env, { username: 'sup01', dept: 'QA', role: 'supervisor', password: 'Abcd1234' });
  seedUser(env, { username: 'mgr01', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  seedUser(env, { username: 'hr01', dept: '', role: 'hr', password: 'Abcd1234' });
  seedUser(env, { username: 'bv01', dept: '', role: 'security', password: 'Abcd1234' });
  seedUserSignature(env, 'sup01');
  seedUserSignature(env, 'mgr01');
  seedUserSignature(env, 'hr01');
  seedUserSignature(env, 'bv01');

  // 1) Đăng ký tài khoản mới qua flow thật + admin kích hoạt
  const regRes = env.callApi('register', null, {
    fullName: 'Tester Flow', emplId: 'NVFLOW1', dept: 'QA', email: 'flow@wahl.com',
    username: 'flowuser', password: 'Abcd1234', confirmPassword: 'Abcd1234'
  });
  assert.equal(regRes.ok, true);
  const adminToken = loginAs(env, 'admin', 'AdminTmp123');
  // admin bị MustChangePw=true sau setup() — đổi mật khẩu trước khi thao tác tiếp (giống luồng thật).
  const cpRes = env.callApi('changePassword', adminToken, { oldPassword: 'AdminTmp123', newPassword: 'AdminNew123' });
  assert.equal(cpRes.ok, true);
  const activateRes = env.callApi('activateUser', adminToken, { username: 'flowuser', role: 'hr' });
  assert.equal(activateRes.ok, true);

  // 2) Nhân viên gửi giấy phép
  const reqId = submitRequestFor(env, { dept: 'QA', supId: 'sup01', mgrId: 'mgr01', emplId: 'NVFLOW2' });

  // 3) Duyệt lần lượt sup -> mgr -> hr
  const tokenSup = loginAs(env, 'sup01', 'Abcd1234');
  const r1 = env.callApi('approve', tokenSup, { requestId: reqId, version: 1 });
  assert.equal(r1.ok, true);
  assert.equal(r1.data.request.status, 'PENDING_MGR');

  const tokenMgr = loginAs(env, 'mgr01', 'Abcd1234');
  const r2 = env.callApi('approve', tokenMgr, { requestId: reqId, version: 2 });
  assert.equal(r2.ok, true);
  assert.equal(r2.data.request.status, 'PENDING_HR');

  const tokenHr = loginAs(env, 'hr01', 'Abcd1234');
  const r3 = env.callApi('approve', tokenHr, { requestId: reqId, version: 3 });
  assert.equal(r3.ok, true);
  assert.equal(r3.data.request.status, 'APPROVED');

  // 4) Bảo vệ cho ra / cho vào
  const tokenBv = loginAs(env, 'bv01', 'Abcd1234');
  const outRes = env.callApi('recordOut', tokenBv, { requestId: reqId, version: 4 });
  assert.equal(outRes.ok, true);
  assert.equal(outRes.data.request.status, 'OUT');

  const inRes = env.callApi('recordIn', tokenBv, { requestId: reqId, version: 5 });
  assert.equal(inRes.ok, true);
  assert.equal(inRes.data.request.status, 'COMPLETED');

  // 5) Tra cứu công khai kèm chữ ký đầy đủ (dùng để xuất PDF không cần đăng nhập)
  const statusRes = env.callApi('getRequestStatus', null, { requestId: reqId, emplId: 'NVFLOW2' });
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.data.request.status, 'COMPLETED');
  assert.ok(statusRes.data.signatures, 'signatures phải có khi status >= APPROVED');
  assert.ok(statusRes.data.signatures.applicant, 'phải có chữ ký applicant');
  assert.ok(statusRes.data.signatures.supervisor, 'phải có chữ ký supervisor');
  assert.ok(statusRes.data.signatures.manager, 'phải có chữ ký manager');
  assert.ok(statusRes.data.signatures.hr, 'phải có chữ ký hr');
  assert.ok(statusRes.data.timeline.length >= 5, 'timeline phải ghi đủ các bước');

  // 6) getRequestPdfData (nội bộ) cũng phải trả đủ chữ ký
  const pdfRes = env.callApi('getRequestPdfData', tokenHr, { requestId: reqId });
  assert.equal(pdfRes.ok, true);
  assert.ok(pdfRes.data.signatures.security, 'phải có chữ ký bảo vệ sau khi recordOut/recordIn');
});

test('tra cứu công khai: sai emplId thì không thấy giấy phép (NOT_FOUND)', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgr01' });
  seedUser(env, { username: 'mgr01', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgr01', emplId: 'REAL001' });
  const res = env.callApi('getRequestStatus', null, { requestId: reqId, emplId: 'SAI_MA_NV' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'NOT_FOUND');
});

test('từ chối (reject) yêu cầu lý do, ghi RejectedBy/RejectReason, dừng hẳn luồng', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgr01' });
  seedUser(env, { username: 'mgr01', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  const reqId = submitRequestFor(env, { dept: 'QA', mgrId: 'mgr01' });
  const token = loginAs(env, 'mgr01', 'Abcd1234');

  const missingReason = env.callApi('reject', token, { requestId: reqId, version: 1, reason: '' });
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.error.code, 'VALIDATION_ERROR');

  const res = env.callApi('reject', token, { requestId: reqId, version: 1, reason: 'Thiếu thông tin' });
  assert.equal(res.ok, true);
  assert.equal(res.data.request.status, 'REJECTED');
  assert.equal(res.data.request.rejectedBy, 'mgr01');
  assert.equal(res.data.request.rejectReason, 'Thiếu thông tin');

  // Request đã REJECTED không thể duyệt tiếp
  const approveAfterReject = env.callApi('approve', token, { requestId: reqId, version: 2 });
  assert.equal(approveAfterReject.ok, false);
  assert.equal(approveAfterReject.error.code, 'INVALID_TRANSITION');
});

test('honeypot: submitRequest có honeypot thì không ghi dữ liệu thật', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgr01' });
  seedUser(env, { username: 'mgr01', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  const before = env.getSheetData('Requests').length;
  const res = env.callApi('submitRequest', null, {
    fullName: 'Bot', emplId: 'BOT001', dept: 'QA', date: new Date().toISOString().slice(0, 10),
    comeOutPlanned: '08:00', reason: 'PERSONAL', mgrId: 'mgr01',
    applicantSignature: FAKE_SIGNATURE_PNG, honeypot: 'im-a-bot'
  });
  assert.equal(res.ok, true);
  const after = env.getSheetData('Requests').length;
  assert.equal(after, before, 'honeypot không được ghi thêm dòng thật vào Requests');
});

test('rate limit: vượt quá MAX_REQUESTS_PER_EMPL_PER_DAY bị RATE_LIMITED', () => {
  const env = freshEnv();
  seedDepartment(env, { dept: 'QA', managerUsername: 'mgr01' });
  seedUser(env, { username: 'mgr01', dept: 'QA', role: 'manager', password: 'Abcd1234' });
  const adminToken = loginAs(env, 'admin', 'AdminTmp123');
  env.callApi('changePassword', adminToken, { oldPassword: 'AdminTmp123', newPassword: 'AdminNew123' });
  const cfgRes = env.callApi('setConfig', adminToken, { key: 'MAX_REQUESTS_PER_EMPL_PER_DAY', value: '2' });
  assert.equal(cfgRes.ok, true);

  submitRequestFor(env, { dept: 'QA', mgrId: 'mgr01', emplId: 'RATELIM1' });
  submitRequestFor(env, { dept: 'QA', mgrId: 'mgr01', emplId: 'RATELIM1' });
  const res = env.callApi('submitRequest', null, {
    fullName: 'X', emplId: 'RATELIM1', dept: 'QA', date: new Date().toISOString().slice(0, 10),
    comeOutPlanned: '08:00', reason: 'PERSONAL', mgrId: 'mgr01',
    applicantSignature: FAKE_SIGNATURE_PNG, honeypot: ''
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'RATE_LIMITED');
});

test('PasswordHash/Salt không bao giờ xuất hiện trong response me/listUsers', () => {
  const env = freshEnv();
  const adminToken = loginAs(env, 'admin', 'AdminTmp123');
  const meRes = env.callApi('me', adminToken, {});
  assert.equal(meRes.ok, true);
  assert.equal(meRes.data.user.PasswordHash, undefined);
  assert.equal(meRes.data.user.Salt, undefined);
  assert.equal(meRes.data.user.passwordHash, undefined);
  assert.equal(meRes.data.user.salt, undefined);

  const listRes = env.callApi('listUsers', adminToken, {});
  assert.equal(listRes.ok, true);
  for (const u of listRes.data.users) {
    assert.equal(u.PasswordHash, undefined);
    assert.equal(u.Salt, undefined);
    assert.equal(u.passwordHash, undefined);
    assert.equal(u.salt, undefined);
  }
});
