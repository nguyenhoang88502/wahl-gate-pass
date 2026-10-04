/**
 * Users.gs — Handler quản trị người dùng (chỉ admin).
 * Phụ thuộc Util.gs và Auth.gs. Code.gs router đã kiểm tra role admin trước,
 * nhưng mỗi handler vẫn kiểm tra lại session.Role === 'admin' (defense in depth).
 */

/** Danh sách role hợp lệ cho Users.Role (SPEC §2.2). */
var VALID_USER_ROLES = ['admin', 'hr', 'manager', 'supervisor', 'security'];

/** Danh sách status hợp lệ cho Users.Status (SPEC §2.2). */
var VALID_USER_STATUSES = ['PENDING', 'ACTIVE', 'LOCKED', 'REJECTED'];

/** Kích thước tối đa ảnh chữ ký (byte nhị phân) — đồng bộ với Auth.gs. */
var MAX_SIGNATURE_BYTES_ADMIN = 1024 * 1024; // 1MB

/**
 * Kiểm tra session có role admin. Trả về null nếu OK, hoặc TextOutput lỗi nếu không.
 * @param {Object} session
 * @return {GoogleAppsScript.Content.TextOutput|null}
 */
function requireAdminSession(session) {
  if (!session || !session.Username) {
    return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
  }
  if (String(session.Role || '') !== 'admin') {
    return jsonResponse(false, null, errorResponse('FORBIDDEN', 'Chỉ quản trị viên được phép thực hiện'));
  }
  return null;
}

/**
 * Sinh mật khẩu tạm ngẫu nhiên 10 ký tự (chữ + số), đảm bảo có cả chữ và số.
 * @return {string}
 */
function genTempPassword() {
  var raw = String(Utilities.getUuid()).replace(/-/g, '');
  var letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var digits = '0123456789';
  var out = '';
  // Lấy 8 ký tự từ uuid, đảm bảo có ít nhất 1 chữ và 1 số
  for (var i = 0; i < 8 && i < raw.length; i++) {
    out += raw.charAt(i);
  }
  out += letters.charAt(Math.floor(Math.random() * letters.length));
  out += digits.charAt(Math.floor(Math.random() * digits.length));
  // Đảo trộn đơn giản
  var arr = out.split('');
  for (var j = arr.length - 1; j > 0; j--) {
    var k = Math.floor(Math.random() * (j + 1));
    var tmp = arr[j]; arr[j] = arr[k]; arr[k] = tmp;
  }
  var result = arr.join('');
  if (!isStrongPassword(result)) {
    // Fallback chắc chắn đủ mạnh
    result = 'Aa1' + raw.substring(0, 7);
  }
  return result;
}

/**
 * handleListUsers — trả về toàn bộ user dạng UserDTO.
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleListUsers(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    var sheet = getSheet('Users');
    var rows = sheetToObjects(sheet);
    var users = [];
    for (var i = 0; i < rows.length; i++) {
      users.push(toUserDTO(rows[i]));
    }
    return jsonResponse(true, { users: users });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy danh sách người dùng'));
  }
}

/**
 * handleListPendingUsers — trả về user có Status='PENDING'.
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleListPendingUsers(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    var sheet = getSheet('Users');
    var rows = sheetToObjects(sheet);
    var users = [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].Status) === 'PENDING') {
        users.push(toUserDTO(rows[i]));
      }
    }
    return jsonResponse(true, { users: users });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy danh sách chờ duyệt'));
  }
}

/**
 * handleActivateUser — kích hoạt tài khoản PENDING, gán role.
 * @param {Object} session
 * @param {Object} payload {username, role}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleActivateUser(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    requireFields(payload, ['username', 'role']);

    var username = sanitizeString(payload.username, 60);
    var role = sanitizeString(payload.role, 40);

    if (VALID_USER_ROLES.indexOf(role) < 0) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Role không hợp lệ'));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var found = findUserByUsername(username);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }
      if (String(found.row.Status) !== 'PENDING') {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Tài khoản không ở trạng thái chờ duyệt'));
      }

      var userSheet = getSheet('Users');
      var deptUpdate = {};
      if (payload.dept !== undefined && payload.dept !== null) {
        deptUpdate.Dept = sanitizeString(payload.dept, 80);
      }
      var finalDept = deptUpdate.Dept !== undefined ? deptUpdate.Dept : cellToText(found.row.Dept);
      var upd = {
        Role: role,
        Status: 'ACTIVE',
        ApprovedBy: session.Username,
        ApprovedAt: nowIso()
      };
      if (deptUpdate.Dept !== undefined) upd.Dept = deptUpdate.Dept;
      updateRowByIndex(userSheet, found.rowIndex, upd);
      syncUserDeptLink(cellToText(found.row.Username), role, finalDept, '', '');

      writeAuditLog(session.Username, 'ACTIVATE_USER', username, 'Gán role ' + role);
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi kích hoạt tài khoản'));
  }
}

/**
 * handleRejectUser — từ chối tài khoản đăng ký.
 * @param {Object} session
 * @param {Object} payload {username}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleRejectUser(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    requireFields(payload, ['username']);

    var username = sanitizeString(payload.username, 60);

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var found = findUserByUsername(username);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }

      var userSheet = getSheet('Users');
      updateRowByIndex(userSheet, found.rowIndex, { Status: 'REJECTED' });
      dropUserSessionCache(username);
      invalidateDirectoryCache();

      writeAuditLog(session.Username, 'REJECT_USER', username, 'Từ chối tài khoản đăng ký');
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi từ chối tài khoản'));
  }
}

/**
 * handleCreateUser — admin tạo user trực tiếp (Status=ACTIVE, MustChangePw=true).
 * @param {Object} session
 * @param {Object} payload {username, fullName, emplId, dept, role, email, tempPassword}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleCreateUser(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    // Chỉ tên đăng nhập là thật sự cần; các trường khác tuỳ chọn (frontend tô đỏ để nhắc).
    requireFields(payload, ['username']);

    var username = sanitizeString(payload.username, 60);
    var fullName = sanitizeString(payload.fullName, 120);
    var emplId = sanitizeString(payload.emplId, 40);
    var dept = sanitizeString(payload.dept, 80);
    var role = sanitizeString(payload.role, 40);
    var email = sanitizeString(payload.email, 120);

    if (!username) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Vui lòng nhập tên đăng nhập'));
    }
    if (role && VALID_USER_ROLES.indexOf(role) < 0) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Role không hợp lệ'));
    }
    if (email && !isBasicEmail(email)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Email không hợp lệ'));
    }

    var tempPassword = '';
    var generated = false;
    if (payload.tempPassword !== undefined && payload.tempPassword !== null && String(payload.tempPassword).length > 0) {
      tempPassword = String(payload.tempPassword);
      if (!isStrongPassword(tempPassword)) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mật khẩu tạm phải có ít nhất 8 ký tự, gồm cả chữ và số'));
      }
    } else {
      tempPassword = genTempPassword();
      generated = true;
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (findUserByUsername(username)) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Tên đăng nhập đã tồn tại'));
      }

      var usersSheet = getSheet('Users');
      if (emplId && findRowIndexByColumn(usersSheet, 'EmplId', emplId) >= 0) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mã nhân viên đã được đăng ký'));
      }

      var salt = newUuid();
      var hash = sha256Hash(tempPassword, salt, PW_HASH_ROUNDS);

      appendRowObject(usersSheet, {
        Username: username,
        FullName: fullName,
        EmplId: emplId,
        Dept: dept,
        Role: role,
        Email: email,
        PasswordHash: hash,
        Salt: salt,
        MustChangePw: true,
        Status: 'ACTIVE',
        FailedCount: 0,
        LockedUntil: '',
        SigFileId: '',
        CreatedAt: nowIso(),
        ApprovedBy: session.Username,
        ApprovedAt: nowIso()
      });

      syncUserDeptLink(username, role, dept, '', '');
      writeAuditLog(session.Username, 'CREATE_USER', username, 'Tạo tài khoản với role ' + (role || '(chưa có)'));
    } finally {
      lock.releaseLock();
    }

    // Mật khẩu tạm do HỆ THỐNG sinh chỉ trả về đúng 1 lần cho admin (qua HTTPS) để bàn giao;
    // KHÔNG lưu dạng rõ, KHÔNG ghi log. Mật khẩu do admin tự nhập thì không trả lại.
    return jsonResponse(true, generated ? { tempPassword: tempPassword } : {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi tạo tài khoản'));
  }
}

/**
 * handleUpdateUser — cập nhật thông tin user (chỉ field có trong payload).
 * @param {Object} session
 * @param {Object} payload {username, fullName, dept, role, email, status}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleUpdateUser(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    requireFields(payload, ['username']);

    var username = sanitizeString(payload.username, 60);

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var found = findUserByUsername(username);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }

      var updates = {};

      // Các trường thông tin đều tuỳ chọn: cho phép để trống (xoá giá trị).
      if (payload.fullName !== undefined && payload.fullName !== null) {
        updates.FullName = sanitizeString(payload.fullName, 120);
      }

      if (payload.emplId !== undefined && payload.emplId !== null) {
        var newEmpl = sanitizeString(payload.emplId, 40);
        if (newEmpl && newEmpl.toLowerCase() !== cellToText(found.row.EmplId).toLowerCase()) {
          var dupIdx = findRowIndexByColumn(getSheet('Users'), 'EmplId', newEmpl);
          if (dupIdx >= 0 && dupIdx !== found.rowIndex) {
            return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mã nhân viên đã được đăng ký'));
          }
        }
        updates.EmplId = newEmpl;
      }

      if (payload.dept !== undefined && payload.dept !== null) {
        updates.Dept = sanitizeString(payload.dept, 80);
      }

      if (payload.role !== undefined && payload.role !== null) {
        var role = sanitizeString(payload.role, 40);
        if (role && VALID_USER_ROLES.indexOf(role) < 0) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Role không hợp lệ'));
        }
        if (!role && String(session.Username).toLowerCase() === username.toLowerCase()) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Không thể tự gỡ vai trò của chính mình'));
        }
        updates.Role = role;
      }

      if (payload.email !== undefined && payload.email !== null) {
        var email = sanitizeString(payload.email, 120);
        if (email && !isBasicEmail(email)) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Email không hợp lệ'));
        }
        updates.Email = email;
      }

      if (payload.status !== undefined && payload.status !== null && String(payload.status).length > 0) {
        var status = sanitizeString(payload.status, 20);
        if (VALID_USER_STATUSES.indexOf(status) < 0) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Status không hợp lệ'));
        }
        updates.Status = status;

        // Nếu chuyển sang ACTIVE từ trạng thái khác và còn LockedUntil -> reset
        if (status === 'ACTIVE' && String(found.row.Status) !== 'ACTIVE') {
          var lockedUntil = found.row.LockedUntil;
          var lockedMs = lockedUntil ? new Date(lockedUntil).getTime() : 0;
          if (lockedMs && lockedMs > Date.now()) {
            updates.FailedCount = 0;
            updates.LockedUntil = '';
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Không có trường nào để cập nhật'));
      }

      if (updates.Status && updates.Status !== 'ACTIVE' && String(session.Username).toLowerCase() === username.toLowerCase()) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Không thể tự khoá tài khoản của chính mình'));
      }

      var userSheet = getSheet('Users');
      updateRowByIndex(userSheet, found.rowIndex, updates);

      var oldRole = cellToText(found.row.Role);
      var oldDept = cellToText(found.row.Dept);
      var newRole = updates.Role !== undefined ? updates.Role : oldRole;
      var newDept = updates.Dept !== undefined ? updates.Dept : oldDept;
      if (newRole !== oldRole || newDept !== oldDept) {
        syncUserDeptLink(cellToText(found.row.Username), newRole, newDept, oldRole, oldDept);
      }
      if (updates.Status !== undefined || updates.Role !== undefined) {
        dropUserSessionCache(username);
      }
      invalidateDirectoryCache();

      writeAuditLog(session.Username, 'UPDATE_USER', username, 'Cập nhật thông tin người dùng');
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi cập nhật người dùng'));
  }
}

/**
 * handleResetPassword — admin reset mật khẩu user, bắt buộc đổi khi đăng nhập.
 * @param {Object} session
 * @param {Object} payload {username, tempPassword}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleResetPassword(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    requireFields(payload, ['username']);

    var username = sanitizeString(payload.username, 60);

    var tempPassword = '';
    var generated = false;
    if (payload.tempPassword !== undefined && payload.tempPassword !== null && String(payload.tempPassword).length > 0) {
      tempPassword = String(payload.tempPassword);
      if (!isStrongPassword(tempPassword)) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mật khẩu tạm phải có ít nhất 8 ký tự, gồm cả chữ và số'));
      }
    } else {
      tempPassword = genTempPassword();
      generated = true;
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var found = findUserByUsername(username);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }

      var newSalt = newUuid();
      var newHash = sha256Hash(tempPassword, newSalt, PW_HASH_ROUNDS);

      var userSheet = getSheet('Users');
      updateRowByIndex(userSheet, found.rowIndex, {
        PasswordHash: newHash,
        Salt: newSalt,
        MustChangePw: true,
        FailedCount: 0,
        LockedUntil: ''
      });

      // KHÔNG ghi mật khẩu vào Detail.
      writeAuditLog(session.Username, 'RESET_PASSWORD', username, 'Reset mật khẩu người dùng');
    } finally {
      lock.releaseLock();
    }

    // Mật khẩu do hệ thống sinh trả về 1 lần cho admin để bàn giao (không lưu rõ, không log).
    return jsonResponse(true, generated ? { tempPassword: tempPassword } : {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi reset mật khẩu'));
  }
}

/**
 * handleUploadUserSignature — admin upload chữ ký cho user bất kỳ.
 * @param {Object} session
 * @param {Object} payload {username, imageBase64}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleUploadUserSignature(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    requireFields(payload, ['username', 'imageBase64']);

    var username = sanitizeString(payload.username, 60);
    var raw = String(payload.imageBase64);

    var mime = 'image/png';
    var base64 = raw;
    var match = raw.match(/^data:(image\/(?:png|jpeg|jpg));base64,(.*)$/i);
    if (match) {
      mime = match[1].toLowerCase();
      if (mime === 'image/jpg') mime = 'image/jpeg';
      base64 = match[2];
    }

    var padding = 0;
    if (base64.endsWith('==')) padding = 2;
    else if (base64.endsWith('=')) padding = 1;
    var approxBytes = Math.floor((base64.length * 3) / 4) - padding;
    if (approxBytes <= 0) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Dữ liệu ảnh không hợp lệ'));
    }
    if (approxBytes > MAX_SIGNATURE_BYTES_ADMIN) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Ảnh chữ ký vượt quá 1MB'));
    }

    var folderId = PropertiesService.getScriptProperties().getProperty('SIGNATURES_FOLDER_ID');
    if (!folderId) {
      return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Chưa cấu hình thư mục chữ ký'));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var found = findUserByUsername(username);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }

      var ext = (mime === 'image/jpeg') ? 'jpg' : 'png';
      var fileName = 'sig_' + username + '_' + Date.now() + '.' + ext;
      var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, fileName);
      var file = DriveApp.getFolderById(folderId).createFile(blob);

      var userSheet = getSheet('Users');
      updateRowByIndex(userSheet, found.rowIndex, { SigFileId: file.getId() });

      writeAuditLog(session.Username, 'UPLOAD_SIGNATURE_ADMIN', username, 'Admin cập nhật chữ ký người dùng');
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi upload chữ ký'));
  }
}

/**
 * handleSetConfig — admin set/update giá trị Config.
 * @param {Object} session
 * @param {Object} payload {key, value}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleSetConfig(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    requireFields(payload, ['key']);

    var key = sanitizeString(payload.key, 80);
    if (!key) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Key không được rỗng'));
    }
    var value = (payload.value === undefined || payload.value === null) ? '' : sanitizeString(payload.value, 500);

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sheet = getSheet('Config');
      var rowIndex = findRowIndexByColumn(sheet, 'Key', key);
      if (rowIndex >= 0) {
        updateRowByIndex(sheet, rowIndex, { Value: value });
      } else {
        appendRowObject(sheet, { Key: key, Value: value });
      }

      writeAuditLog(session.Username, 'SET_CONFIG', key, 'value=' + value);
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi cập nhật cấu hình'));
  }
}

/**
 * handleGetConfig — admin đọc toàn bộ cấu hình hiện tại {key: value} để hiển thị lên form.
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetConfig(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;
    var rows = sheetToObjects(getSheet('Config'));
    var config = {};
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].Key) config[cellToText(rows[i].Key)] = cellToText(rows[i].Value);
    }
    return jsonResponse(true, { config: config });
  } catch (err) {
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi đọc cấu hình'));
  }
}

/**
 * handleListAuditLog — admin xem audit log, lọc theo ngày, mặc định 200 dòng mới nhất.
 * @param {Object} session
 * @param {Object} payload {dateFrom?, dateTo?} dạng 'YYYY-MM-DD'
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleListAuditLog(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;

    payload = payload || {};
    var dateFrom = payload.dateFrom ? sanitizeString(payload.dateFrom, 10) : '';
    var dateTo = payload.dateTo ? sanitizeString(payload.dateTo, 10) : '';

    var sheet = getSheet('AuditLog');
    var rows = sheetToObjects(sheet);

    var logs = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var t = r.Time;
      var dayStr = '';
      if (t instanceof Date) {
        dayStr = Utilities.formatDate(t, TZ, 'yyyy-MM-dd');
      } else if (t) {
        var d = new Date(String(t));
        if (!isNaN(d.getTime())) {
          dayStr = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
        }
      }

      if (dateFrom && dayStr && dayStr < dateFrom) continue;
      if (dateTo && dayStr && dayStr > dateTo) continue;

      logs.push({
        time: (t instanceof Date) ? t.toISOString() : String(t || ''),
        actor: r.Actor || '',
        action: r.Action || '',
        targetId: r.TargetId || '',
        detail: r.Detail || ''
      });
    }

    // Sắp xếp mới nhất trước
    logs.sort(function (a, b) {
      var ta = a.time ? new Date(a.time).getTime() : 0;
      var tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });

    // Nếu không truyền dateFrom/dateTo -> giới hạn 200 dòng gần nhất
    if (!dateFrom && !dateTo && logs.length > 200) {
      logs = logs.slice(0, 200);
    }

    return jsonResponse(true, { logs: logs });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy audit log'));
  }
}