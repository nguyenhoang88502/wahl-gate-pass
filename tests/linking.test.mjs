// tests/linking.test.mjs
// Kiểm thử các thay đổi: không trường bắt buộc, liên kết bộ phận <-> người duyệt quản lý từ admin,
// dashboard bảo vệ công khai, dọn phiên, và giữ đúng kiểu dữ liệu khi Google Sheets tự đổi kiểu.
// Chạy: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadyGasEnv,
  seedUser,
  seedUserSignature,
  seedDepartment,
  loginAs,
  FAKE_SIGNATURE_PNG
} from './gas-stub.mjs';

function adminEnv() {
  const env = createReadyGasEnv('AdminTmp123');
  const token = loginAs(env, 'admin', 'AdminTmp123');
  env.callApi('changePassword', token, { oldPassword: 'AdminTmp123', newPassword: 'AdminNew123' });
  return { env, admin: token };
}

function deptRow(env, name) {
  const rows = env.getSheetData('Departments');
  const h = rows[0];
  const r = rows.find((x) => String(x[h.indexOf('Dept')]) === name);
  if (!r) return null;
  return { sups: String(r[h.indexOf('SupervisorUsernames')] || ''), mgr: String(r[h.indexOf('ManagerUsername')] || '') };
}

test('không trường bắt buộc: gửi giấy phép rỗng hoàn toàn vẫn thành công, ngày mặc định hôm nay, đi thẳng tới HR', () => {
  const { env } = adminEnv();
  const res = env.callApi('submitRequest', null, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const id = res.data.requestId;

  const { admin } = { admin: loginAs(env, 'admin', 'AdminNew123') };
  const list = env.callApi('listRequests', admin, {});
  const r = list.data.requests.find((x) => x.requestId === id);
  assert.ok(r);
  assert.equal(r.status, 'PENDING_HR', 'không có giám sát + trưởng BP -> bỏ qua 2 bước');
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.fullName, '');
});

test('dữ liệu sai định dạng (khi có nhập) vẫn bị từ chối', () => {
  const { env } = adminEnv();
  const res = env.callApi('submitRequest', null, { comeOutPlanned: '25:99' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'VALIDATION_ERROR');
});

test('Sheets tự đổi kiểu: mã NV có số 0 đầu, giờ, ngày đọc lại phải y nguyên', () => {
  const { env } = adminEnv();
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const res = env.callApi('submitRequest', null, {
    fullName: '=HYPERLINK("x")', emplId: '00123', date: today,
    comeOutPlanned: '08:30', comeInPlanned: '17:05', reason: 'SICK'
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const st = env.callApi('getRequestStatus', null, { requestId: res.data.requestId, emplId: '00123' });
  assert.equal(st.ok, true, JSON.stringify(st));
  const r = st.data.request;
  assert.equal(r.emplId, '00123');
  assert.equal(r.comeOutPlanned, '08:30');
  assert.equal(r.comeInPlanned, '17:05');
  assert.equal(r.date, today);
  assert.equal(r.fullName, '=HYPERLINK("x")', 'công thức phải được lưu dạng text, không bị thực thi');
});

test('RequestId không trùng khi có giấy xin cho ngày khác hôm nay', () => {
  const { env } = adminEnv();
  const tomorrow = new Date(Date.now() + 31 * 3600 * 1000).toISOString().slice(0, 10);
  const a = env.callApi('submitRequest', null, { emplId: 'A1', date: tomorrow });
  const b = env.callApi('submitRequest', null, { emplId: 'A2' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.data.requestId, b.data.requestId);
});

test('người duyệt không hợp lệ (không đúng role) bị bỏ qua thay vì làm kẹt giấy phép', () => {
  const { env } = adminEnv();
  seedUser(env, { username: 'nv01', role: 'hr', password: 'Abcd1234' });
  const res = env.callApi('submitRequest', null, { emplId: 'X1', supId: 'nv01', mgrId: 'khongco' });
  assert.equal(res.ok, true);
  const st = env.callApi('getRequestStatus', null, { requestId: res.data.requestId, emplId: 'X1' });
  assert.equal(st.data.request.status, 'PENDING_HR');
  assert.equal(st.data.request.supId, '');
  assert.equal(st.data.request.mgrId, '');
});

test('admin tạo supervisor/manager kèm bộ phận mới -> tự tạo bộ phận + tự liên kết người duyệt', () => {
  const { env, admin } = adminEnv();
  const c1 = env.callApi('createUser', admin, { username: 'supP', fullName: 'Giám Sát P', dept: 'PROD', role: 'supervisor' });
  assert.equal(c1.ok, true, JSON.stringify(c1));
  assert.ok(c1.data.tempPassword, 'mật khẩu tạm do hệ thống sinh phải trả về 1 lần cho admin');
  const c2 = env.callApi('createUser', admin, { username: 'mgrP', fullName: 'Trưởng P', dept: 'PROD', role: 'manager', tempPassword: 'Manager123' });
  assert.equal(c2.ok, true);
  assert.equal(c2.data.tempPassword, undefined, 'mật khẩu admin tự đặt không trả lại');

  assert.deepEqual(deptRow(env, 'PROD'), { sups: 'supP', mgr: 'mgrP' });

  const deps = env.callApi('getDepartments', null, {});
  const prod = deps.data.departments.find((d) => d.dept === 'PROD');
  assert.deepEqual(prod.supervisors, [{ username: 'supP', fullName: 'Giám Sát P' }]);
  assert.deepEqual(prod.manager, { username: 'mgrP', fullName: 'Trưởng P' });

  // Mật khẩu tạm dùng được để đăng nhập
  const login = env.callApi('login', null, { username: 'supP', password: c1.data.tempPassword });
  assert.equal(login.ok, true);
  assert.equal(login.data.user.mustChangePw, true);
});

test('đổi role/bộ phận của user -> liên kết bộ phận cập nhật theo, cache public được làm mới', () => {
  const { env, admin } = adminEnv();
  env.callApi('createUser', admin, { username: 'u1', dept: 'QA', role: 'supervisor', tempPassword: 'Abcd1234' });
  env.callApi('getDepartments', null, {}); // nạp cache
  assert.equal(deptRow(env, 'QA').sups, 'u1');

  const up = env.callApi('updateUser', admin, { username: 'u1', role: 'manager', dept: 'QC' });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(deptRow(env, 'QA').sups, '', 'không còn là giám sát QA');
  assert.equal(deptRow(env, 'QC').mgr, 'u1', 'thành trưởng bộ phận QC');

  const deps = env.callApi('getDepartments', null, {});
  const qc = deps.data.departments.find((d) => d.dept === 'QC');
  assert.equal(qc.manager.username, 'u1', 'cache getDepartments phải được xoá sau khi sửa user');
});

test('kích hoạt tài khoản đăng ký với role supervisor -> tự gắn vào bộ phận đã khai', () => {
  const { env, admin } = adminEnv();
  const reg = env.callApi('register', null, { username: 'selfsup', dept: 'WH', password: 'Abcd1234', confirmPassword: 'Abcd1234' });
  assert.equal(reg.ok, true, 'đăng ký chỉ cần username + mật khẩu: ' + JSON.stringify(reg));
  const act = env.callApi('activateUser', admin, { username: 'selfsup', role: 'supervisor' });
  assert.equal(act.ok, true);
  assert.equal(deptRow(env, 'WH').sups, 'selfsup');
});

test('saveDepartment: kiểm tra role người duyệt, đổi tên bộ phận cập nhật Dept của user', () => {
  const { env, admin } = adminEnv();
  seedUser(env, { username: 'hrx', role: 'hr', dept: 'OLD', password: 'Abcd1234' });
  seedUser(env, { username: 'supx', role: 'supervisor', dept: 'OLD', password: 'Abcd1234' });
  seedDepartment(env, { dept: 'OLD' });

  const bad = env.callApi('saveDepartment', admin, { dept: 'OLD', supervisorUsernames: ['hrx'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'VALIDATION_ERROR');

  const ok = env.callApi('saveDepartment', admin, { originalDept: 'OLD', dept: 'NEW', supervisorUsernames: ['SUPX'], managerUsername: '' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(deptRow(env, 'NEW'), { sups: 'supx', mgr: '' });
  assert.equal(deptRow(env, 'OLD'), null);
  const users = env.callApi('listUsers', admin, {}).data.users;
  assert.equal(users.find((u) => u.username === 'hrx').dept, 'NEW');

  const dup = env.callApi('saveDepartment', admin, { dept: 'new' });
  assert.equal(dup.ok, false, 'trùng tên (không phân biệt hoa thường) bị chặn');

  const list = env.callApi('listDepartmentsAdmin', admin, {});
  assert.equal(list.data.departments.find((d) => d.dept === 'NEW').memberCount, 2);

  const del = env.callApi('deleteDepartment', admin, { dept: 'NEW' });
  assert.equal(del.ok, true);
  assert.equal(deptRow(env, 'NEW'), null);
});

test('supervisor được liên kết với bộ phận thứ 2 thấy giấy phép của bộ phận đó', () => {
  const { env, admin } = adminEnv();
  seedUser(env, { username: 'supA', role: 'supervisor', dept: 'A', password: 'Abcd1234' });
  seedDepartment(env, { dept: 'A', supervisorUsernames: 'supA' });
  seedDepartment(env, { dept: 'B' });
  env.callApi('saveDepartment', admin, { dept: 'B', originalDept: 'B', supervisorUsernames: ['supA'] });
  const r = env.callApi('submitRequest', null, { emplId: 'E1', dept: 'B' });
  const other = env.callApi('submitRequest', null, { emplId: 'E2', dept: 'C' });

  const tok = loginAs(env, 'supA', 'Abcd1234');
  const ids = env.callApi('listRequests', tok, {}).data.requests.map((x) => x.requestId);
  assert.ok(ids.includes(r.data.requestId));
  assert.ok(!ids.includes(other.data.requestId));
});

test('dashboard bảo vệ công khai: không cần token, không lộ lý do, có tên người duyệt', () => {
  const { env } = adminEnv();
  seedUser(env, { username: 'mgr9', fullName: 'Trần Trưởng', role: 'manager', dept: 'QA', password: 'Abcd1234' });
  seedUserSignature(env, 'mgr9');
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const sub = env.callApi('submitRequest', null, {
    fullName: 'NV Một', emplId: 'Z1', dept: 'QA', date: today, comeOutPlanned: '09:00',
    reason: 'OTHER', reasonDetail: 'bí mật', mgrId: 'mgr9', applicantSignature: FAKE_SIGNATURE_PNG
  });
  const tok = loginAs(env, 'mgr9', 'Abcd1234');
  env.callApi('approve', tok, { requestId: sub.data.requestId, version: 1 });

  const res = env.callApi('listToday', null, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = res.data.requests.find((x) => x.requestId === sub.data.requestId);
  assert.ok(row);
  assert.equal(row.status, 'PENDING_HR');
  assert.equal(row.mgrId, 'mgr9');
  assert.ok(row.mgrAt);
  assert.equal(res.data.names.mgr9, 'Trần Trưởng');
  const json = JSON.stringify(res.data);
  assert.ok(!json.includes('bí mật'), 'không được lộ chi tiết lý do');
  assert.equal(row.reason, undefined);
  assert.equal(row.comeOutPlanned, '09:00');
});

test('khoá tài khoản có hiệu lực ngay cả khi phiên đang được cache', () => {
  const { env, admin } = adminEnv();
  seedUser(env, { username: 'hrL', role: 'hr', password: 'Abcd1234' });
  const tok = loginAs(env, 'hrL', 'Abcd1234');
  assert.equal(env.callApi('me', tok, {}).ok, true); // nạp cache
  const lock = env.callApi('updateUser', admin, { username: 'hrL', status: 'LOCKED' });
  assert.equal(lock.ok, true);
  const after = env.callApi('listRequests', tok, {});
  assert.equal(after.ok, false);
  assert.equal(after.error.code, 'SESSION_EXPIRED');
});

test('đổi role có hiệu lực ngay với phiên đang mở (dùng role hiện tại, không dùng role lúc đăng nhập)', () => {
  const { env, admin } = adminEnv();
  seedUser(env, { username: 'r1', role: 'hr', password: 'Abcd1234' });
  const tok = loginAs(env, 'r1', 'Abcd1234');
  assert.equal(env.callApi('listRequests', tok, {}).ok, true);
  env.callApi('updateUser', admin, { username: 'r1', role: 'security' });
  const res = env.callApi('listRequests', tok, {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN');
});

test('đăng nhập dọn phiên hết hạn và giữ tối đa 3 phiên / user', () => {
  const { env } = adminEnv();
  seedUser(env, { username: 's1', role: 'hr', password: 'Abcd1234' });
  const sheet = env.ctx.getSheet('Sessions');
  env.ctx.appendRowObject(sheet, { Token: 'old', Username: 'ghost', Role: 'hr', ExpiresAt: new Date(Date.now() - 1000).toISOString() });
  for (let i = 0; i < 5; i++) loginAs(env, 's1', 'Abcd1234');
  const rows = env.getSheetData('Sessions');
  const h = rows[0];
  const tokens = rows.slice(1).map((r) => r[h.indexOf('Token')]);
  assert.ok(!tokens.includes('old'), 'phiên hết hạn phải bị xoá');
  const s1 = rows.slice(1).filter((r) => r[h.indexOf('Username')] === 's1').length;
  assert.ok(s1 <= 4, 'tối đa 3 phiên cũ + 1 phiên mới cho mỗi user, thực tế: ' + s1);
});

test('getConfig trả cấu hình hiện tại; reset mật khẩu trả mật khẩu tạm dùng được', () => {
  const { env, admin } = adminEnv();
  env.callApi('setConfig', admin, { key: 'MAX_REQUESTS_PER_EMPL_PER_DAY', value: '7' });
  const cfg = env.callApi('getConfig', admin, {});
  assert.equal(cfg.ok, true);
  assert.equal(cfg.data.config.MAX_REQUESTS_PER_EMPL_PER_DAY, '7');
  assert.equal(cfg.data.config.EMAIL_NOTIFICATIONS_ENABLED, 'false');

  seedUser(env, { username: 'rp', role: 'hr', password: 'Abcd1234' });
  const rp = env.callApi('resetPassword', admin, { username: 'rp' });
  assert.equal(rp.ok, true);
  assert.ok(rp.data.tempPassword);
  assert.equal(env.callApi('login', null, { username: 'rp', password: rp.data.tempPassword }).ok, true);
});

test('getMySignature trả ảnh chữ ký của chính mình', () => {
  const { env } = adminEnv();
  seedUser(env, { username: 'sg', role: 'hr', password: 'Abcd1234' });
  const tok = loginAs(env, 'sg', 'Abcd1234');
  assert.equal(env.callApi('getMySignature', tok, {}).data.dataUrl, null);
  env.callApi('uploadMySignature', tok, { imageBase64: FAKE_SIGNATURE_PNG });
  assert.match(env.callApi('getMySignature', tok, {}).data.dataUrl, /^data:image\/png;base64,/);
});
