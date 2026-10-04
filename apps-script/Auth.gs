/**
 * Auth.gs — Xác thực, phiên đăng nhập, đăng ký, đổi mật khẩu, chữ ký cá nhân.
 * Phụ thuộc Util.gs. Không tự viết doPost — Code.gs router gọi các handler.
 */

/** Số vòng băm mật khẩu (>=1000 theo SPEC §10). */
var PW_HASH_ROUNDS = 1000;

/** Số lần sai liên tiếp trước khi khóa tạm. */
var MAX_FAILED_LOGIN = 5;

/** Thời gian khóa tạm (phút). */
var LOCK_MINUTES = 15;

/** Thời hạn session (giờ) theo role. */
var SESSION_HOURS_DEFAULT = 8;
var SESSION_HOURS_SECURITY = 12;

/** Kích thước tối đa ảnh chữ ký (byte nhị phân). */
var MAX_SIGNATURE_BYTES = 1024 * 1024; // 1MB

/**
 * Tìm user theo username (không phân biệt hoa thường).
 * @param {string} username
 * @return {{row:Object,rowIndex:number}|null}
 */
function findUserByUsername(username) {
  if (!username) return null;
  var sheet = getSheet('Users');
  var rowIndex = findRowIndexByColumn(sheet, 'Username', String(username));
  if (rowIndex < 0) return null;
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    obj[String(headers[i])] = values[i];
  }
  return { row: obj, rowIndex: rowIndex };
}

/**
 * Chuyển 1 dòng Users thành UserDTO (SPEC §5.1). KHÔNG bao giờ chứa PasswordHash/Salt.
 * @param {Object} userRow
 * @return {Object}
 */
function toUserDTO(userRow) {
  if (!userRow) return null;
  var sigId = userRow.SigFileId;
  return {
    username: cellToText(userRow.Username),
    fullName: cellToText(userRow.FullName),
    emplId: cellToText(userRow.EmplId),
    dept: cellToText(userRow.Dept),
    role: cellToText(userRow.Role),
    email: cellToText(userRow.Email),
    status: cellToText(userRow.Status),
    mustChangePw: userRow.MustChangePw === true || String(userRow.MustChangePw).toLowerCase() === 'true',
    hasSignature: !!(sigId && String(sigId).length > 0),
    createdAt: cellToText(userRow.CreatedAt)
  };
}

/** Thời gian cache kết quả xác thực token (giây) — ngắn để khoá/đổi role có hiệu lực nhanh. */
var SESSION_CACHE_SECONDS = 120;

function sessionCacheKey(token) {
  return 'gp_sess_' + String(token);
}

/**
 * Kiểm tra token trong Sessions còn hiệu lực. Kết quả hợp lệ được cache ngắn hạn để
 * không phải đọc 2 sheet (Sessions + Users) ở MỌI request — giảm độ trễ đáng kể.
 * Role trả về luôn là role HIỆN TẠI của user (không phải role lúc đăng nhập).
 * @param {string} token
 * @return {{valid:boolean, session:Object|null, user:Object|null}}
 */
function validateSessionToken(token) {
  if (!token) return { valid: false, session: null, user: null };

  var cached = cacheGetJson(sessionCacheKey(token));
  if (cached && cached.ExpiresAt && new Date(cached.ExpiresAt).getTime() > Date.now()) {
    return { valid: true, session: cached, user: null };
  }

  var sheet = getSheet('Sessions');
  var rowIndex = findRowIndexByColumn(sheet, 'Token', String(token));
  if (rowIndex < 0) return { valid: false, session: null, user: null };
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  var session = {};
  for (var i = 0; i < headers.length; i++) {
    session[String(headers[i])] = values[i];
  }
  var expiresAt = session.ExpiresAt;
  var expMs = expiresAt ? new Date(expiresAt).getTime() : 0;
  if (!expMs || expMs <= Date.now()) {
    return { valid: false, session: session, user: null };
  }
  var found = findUserByUsername(session.Username);
  if (!found) return { valid: false, session: session, user: null };
  // Tài khoản bị khoá / từ chối sau khi đăng nhập -> phiên hết hiệu lực ngay.
  if (String(found.row.Status) !== 'ACTIVE') return { valid: false, session: session, user: null };

  var slim = {
    Token: String(token),
    Username: cellToText(found.row.Username),
    Role: cellToText(found.row.Role),
    ExpiresAt: new Date(expMs).toISOString()
  };
  cachePutJson(sessionCacheKey(token), slim, SESSION_CACHE_SECONDS);
  return { valid: true, session: slim, user: found.row };
}

/**
 * Xoá cache xác thực của mọi phiên thuộc 1 user — gọi khi admin khoá / đổi role / reset mật khẩu
 * để thay đổi có hiệu lực NGAY (không đợi cache hết hạn).
 * @param {string} username
 */
function dropUserSessionCache(username) {
  try {
    var target = String(username || '').toLowerCase();
    var rows = sheetToObjects(getSheet('Sessions'));
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].Username || '').toLowerCase() === target) {
        cacheRemove(sessionCacheKey(rows[i].Token));
      }
    }
  } catch (err) {
    // bỏ qua
  }
}

/**
 * Dọn sheet Sessions: xoá phiên hết hạn + chỉ giữ tối đa MAX_SESSIONS_PER_USER phiên mới nhất
 * mỗi user. Ghi lại cả sheet 1 lần (nhanh). Gọi bên trong script lock.
 */
var MAX_SESSIONS_PER_USER = 3;
function purgeSessions() {
  var sheet = getSheet('Sessions');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var userCol = headers.indexOf('Username');
  var expCol = headers.indexOf('ExpiresAt');
  var now = Date.now();
  var alive = [];
  for (var r = 0; r < values.length; r++) {
    var exp = values[r][expCol] ? new Date(values[r][expCol]).getTime() : 0;
    if (exp && exp > now) alive.push(values[r]);
  }
  // Mới nhất trước (ExpiresAt lớn hơn = đăng nhập sau) rồi giữ N phiên / user.
  alive.sort(function (a, b) { return new Date(b[expCol]).getTime() - new Date(a[expCol]).getTime(); });
  var perUser = {};
  var keep = [];
  for (var k = 0; k < alive.length; k++) {
    var u = String(alive[k][userCol]).toLowerCase();
    perUser[u] = (perUser[u] || 0) + 1;
    if (perUser[u] <= MAX_SESSIONS_PER_USER) keep.push(alive[k]);
  }
  if (keep.length === values.length) return;
  sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  if (keep.length > 0) {
    sheet.getRange(2, 1, keep.length, lastCol).setValues(keep);
  }
}

/**
 * Ghi 1 dòng AuditLog. KHÔNG chứa mật khẩu/hash.
 * @param {string} actor
 * @param {string} action
 * @param {string} targetId
 * @param {string} detail
 */
function writeAuditLog(actor, action, targetId, detail) {
  try {
    var sheet = getSheet('AuditLog');
    appendRowObject(sheet, {
      Time: nowIso(),
      Actor: actor || 'SYSTEM',
      Action: action || '',
      TargetId: targetId || '',
      Detail: sanitizeString(detail || '', 300)
    });
  } catch (err) {
    // Không để lỗi audit làm hỏng luồng chính.
  }
}

/**
 * Đọc giá trị Config theo key, trả về chuỗi hoặc defaultValue.
 * @param {string} key
 * @param {string} defaultValue
 * @return {string}
 */
function getConfigValue(key, defaultValue) {
  try {
    var sheet = getSheet('Config');
    var rowIndex = findRowIndexByColumn(sheet, 'Key', String(key));
    if (rowIndex < 0) return defaultValue;
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var values = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]) === 'Value') {
        var v = values[i];
        return (v === null || v === undefined || v === '') ? defaultValue : String(v);
      }
    }
  } catch (err) {
    // ignore
  }
  return defaultValue;
}

/**
 * Đếm số dòng AuditLog có Action = action và Time trong ngày hôm nay (Asia/Ho_Chi_Minh).
 * @param {string} action
 * @return {number}
 */
function countAuditToday(action) {
  var sheet = getSheet('AuditLog');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var timeCol = -1, actionCol = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i]);
    if (h === 'Time') timeCol = i + 1;
    if (h === 'Action') actionCol = i + 1;
  }
  if (timeCol < 0 || actionCol < 0) return 0;
  // AuditLog chỉ append theo thời gian -> chỉ cần quét phần đuôi (nhanh khi log lớn).
  var startRow = Math.max(2, lastRow - 3000 + 1);
  var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
  var today = todayStr();
  var count = 0;
  for (var r = 0; r < values.length; r++) {
    var a = String(values[r][actionCol - 1]);
    if (a !== action) continue;
    var t = values[r][timeCol - 1];
    var tStr = '';
    if (t instanceof Date) {
      tStr = Utilities.formatDate(t, TZ, 'yyyy-MM-dd');
    } else {
      // ISO string -> lấy ngày theo TZ
      var d = new Date(String(t));
      if (!isNaN(d.getTime())) {
        tStr = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
      }
    }
    if (tStr === today) count++;
  }
  return count;
}

/**
 * Đếm số user có Status = PENDING.
 * @return {number}
 */
function countPendingUsers() {
  var sheet = getSheet('Users');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var statusCol = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]) === 'Status') { statusCol = i + 1; break; }
  }
  if (statusCol < 0) return 0;
  var values = sheet.getRange(2, statusCol, lastRow - 1, 1).getValues();
  var count = 0;
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]) === 'PENDING') count++;
  }
  return count;
}

/**
 * Kiểm tra mật khẩu >=8 ký tự, có cả chữ và số.
 * @param {string} pw
 * @return {boolean}
 */
function isStrongPassword(pw) {
  if (!pw || typeof pw !== 'string') return false;
  if (pw.length < 8) return false;
  var hasLetter = /[A-Za-z]/.test(pw);
  var hasDigit = /[0-9]/.test(pw);
  return hasLetter && hasDigit;
}

/**
 * Kiểm tra email cơ bản.
 * @param {string} email
 * @return {boolean}
 */
function isBasicEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
}

/**
 * handleRegister — đăng ký tài khoản mới (Status=PENDING).
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleRegister(payload) {
  try {
    payload = payload || {};

    // Honeypot: nếu có dữ liệu -> giả thành công, KHÔNG ghi gì.
    if (payload.honeypot !== undefined && payload.honeypot !== null && String(payload.honeypot).length > 0) {
      return jsonResponse(true, { message: 'Tài khoản đang chờ admin kích hoạt' });
    }

    // Chỉ tên đăng nhập + mật khẩu là cần thiết để có tài khoản; các trường còn lại tuỳ chọn.
    requireFields(payload, ['username', 'password', 'confirmPassword']);

    var fullName = sanitizeString(payload.fullName, 120);
    var emplId = sanitizeString(payload.emplId, 40);
    var dept = sanitizeString(payload.dept, 80);
    var email = sanitizeString(payload.email, 120);
    var username = sanitizeString(payload.username, 60);
    var password = String(payload.password);
    var confirmPassword = String(payload.confirmPassword);

    if (!username) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Vui lòng nhập tên đăng nhập'));
    }
    if (email && !isBasicEmail(email)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Email không hợp lệ'));
    }
    if (!isStrongPassword(password)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mật khẩu phải có ít nhất 8 ký tự, gồm cả chữ và số'));
    }
    if (password !== confirmPassword) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mật khẩu xác nhận không khớp'));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      // Rate limit đăng ký/ngày
      var maxRegister = parseInt(getConfigValue('MAX_REGISTER_PER_DAY', '20'), 10);
      if (!isNaN(maxRegister) && maxRegister > 0) {
        var todayCount = countAuditToday('REGISTER');
        if (todayCount >= maxRegister) {
          return jsonResponse(false, null, errorResponse('RATE_LIMITED', 'Đã đạt giới hạn đăng ký trong ngày, vui lòng thử lại sau'));
        }
      }

      // Giới hạn số PENDING
      var maxPending = parseInt(getConfigValue('MAX_PENDING_USERS', '50'), 10);
      if (!isNaN(maxPending) && maxPending > 0) {
        if (countPendingUsers() >= maxPending) {
          return jsonResponse(false, null, errorResponse('RATE_LIMITED', 'Hệ thống đang có quá nhiều tài khoản chờ duyệt, vui lòng thử lại sau'));
        }
      }

      // Trùng username (không phân biệt hoa thường)
      if (findUserByUsername(username)) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Tên đăng nhập đã tồn tại'));
      }

      // Trùng EmplId (bất kể status) — chỉ kiểm tra khi có nhập
      var usersSheet = getSheet('Users');
      if (emplId && findRowIndexByColumn(usersSheet, 'EmplId', emplId) >= 0) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mã nhân viên đã được đăng ký'));
      }

      var salt = newUuid();
      var hash = sha256Hash(password, salt, PW_HASH_ROUNDS);

      appendRowObject(usersSheet, {
        Username: username,
        FullName: fullName,
        EmplId: emplId,
        Dept: dept,
        Role: '',
        Email: email,
        PasswordHash: hash,
        Salt: salt,
        MustChangePw: false,
        Status: 'PENDING',
        FailedCount: 0,
        LockedUntil: '',
        SigFileId: '',
        CreatedAt: nowIso(),
        ApprovedBy: '',
        ApprovedAt: ''
      });

      writeAuditLog(username, 'REGISTER', username, 'Đăng ký tài khoản mới');
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, { message: 'Tài khoản đang chờ admin kích hoạt' });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi đăng ký'));
  }
}

/**
 * handleLogin — đăng nhập, tạo session.
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleLogin(payload) {
  try {
    payload = payload || {};
    requireFields(payload, ['username', 'password']);

    var username = sanitizeString(payload.username, 60);
    var password = String(payload.password);

    var found = findUserByUsername(username);

    // Không tìm thấy user -> trả lỗi chung (không tiết lộ tồn tại)
    if (!found) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Sai tên đăng nhập hoặc mật khẩu'));
    }

    var user = found.row;
    var userSheet = getSheet('Users');

    // Kiểm tra khóa tạm
    var lockedUntil = user.LockedUntil;
    var lockedMs = lockedUntil ? new Date(lockedUntil).getTime() : 0;
    if (String(user.Status) === 'LOCKED' || (lockedMs && lockedMs > Date.now())) {
      return jsonResponse(false, null, errorResponse('LOCKED_ACCOUNT', 'Tài khoản đang bị khóa tạm thời, vui lòng thử lại sau'));
    }

    // Kiểm tra mật khẩu
    var salt = String(user.Salt || '');
    var expected = String(user.PasswordHash || '');
    var actual = sha256Hash(password, salt, PW_HASH_ROUNDS);

    if (actual !== expected) {
      var failed = parseInt(user.FailedCount, 10);
      if (isNaN(failed)) failed = 0;
      failed += 1;
      var updates = { FailedCount: failed };
      if (failed >= MAX_FAILED_LOGIN) {
        var until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
        updates.LockedUntil = until;
      }
      updateRowByIndex(userSheet, found.rowIndex, updates);
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Sai tên đăng nhập hoặc mật khẩu'));
    }

    // Mật khẩu đúng nhưng status không ACTIVE
    if (String(user.Status) !== 'ACTIVE') {
      return jsonResponse(false, null, errorResponse('FORBIDDEN', 'Tài khoản chưa được kích hoạt hoặc đã bị từ chối'));
    }

    // Reset failed count + tạo session
    updateRowByIndex(userSheet, found.rowIndex, { FailedCount: 0, LockedUntil: '' });

    var role = String(user.Role || '');
    var hours = (role === 'security') ? SESSION_HOURS_SECURITY : SESSION_HOURS_DEFAULT;
    var expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    var token = newUuid();

    var sessionsSheet = getSheet('Sessions');
    var sLock = LockService.getScriptLock();
    sLock.waitLock(30000);
    try {
      // Mỗi lần đăng nhập dọn phiên cũ/hết hạn để sheet Sessions luôn nhỏ (tránh chậm dần).
      purgeSessions();
      appendRowObject(sessionsSheet, {
        Token: token,
        Username: user.Username,
        Role: role,
        ExpiresAt: expiresAt
      });
    } finally {
      sLock.releaseLock();
    }

    writeAuditLog(user.Username, 'LOGIN', user.Username, 'Đăng nhập thành công');

    // Refresh user row sau khi update
    var refreshed = findUserByUsername(user.Username);
    var userRow = refreshed ? refreshed.row : user;

    return jsonResponse(true, { token: token, user: toUserDTO(userRow) });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi đăng nhập'));
  }
}

/**
 * handleLogout — xóa session hiện tại.
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleLogout(session, payload) {
  try {
    if (!session || !session.Token) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    cacheRemove(sessionCacheKey(session.Token));
    var sheet = getSheet('Sessions');
    var rowIndex = findRowIndexByColumn(sheet, 'Token', String(session.Token));
    if (rowIndex >= 0) {
      sheet.deleteRow(rowIndex);
    }
    writeAuditLog(session.Username || 'SYSTEM', 'LOGOUT', session.Username || '', 'Đăng xuất');
    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi đăng xuất'));
  }
}

/**
 * handleMe — trả về UserDTO của session hiện tại.
 * @param {Object} session — object session có Username (và có thể có userRow).
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleMe(session) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    var found = findUserByUsername(session.Username);
    if (!found) {
      return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
    }
    return jsonResponse(true, { user: toUserDTO(found.row) });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống'));
  }
}

/**
 * handleChangePassword — đổi mật khẩu (cần mật khẩu cũ đúng).
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleChangePassword(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    payload = payload || {};
    requireFields(payload, ['oldPassword', 'newPassword']);

    var oldPassword = String(payload.oldPassword);
    var newPassword = String(payload.newPassword);

    if (!isStrongPassword(newPassword)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Mật khẩu mới phải có ít nhất 8 ký tự, gồm cả chữ và số'));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var found = findUserByUsername(session.Username);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }
      var user = found.row;
      var salt = String(user.Salt || '');
      var expected = String(user.PasswordHash || '');
      var actual = sha256Hash(oldPassword, salt, PW_HASH_ROUNDS);
      if (actual !== expected) {
        return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Mật khẩu cũ không đúng'));
      }

      var newSalt = newUuid();
      var newHash = sha256Hash(newPassword, newSalt, PW_HASH_ROUNDS);

      var userSheet = getSheet('Users');
      updateRowByIndex(userSheet, found.rowIndex, {
        PasswordHash: newHash,
        Salt: newSalt,
        MustChangePw: false
      });

      writeAuditLog(session.Username, 'CHANGE_PASSWORD', session.Username, 'Đổi mật khẩu');
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi đổi mật khẩu'));
  }
}

/**
 * handleGetMySignature — trả ảnh chữ ký hiện tại của chính mình (data URL) để xem lại.
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetMySignature(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    var found = findUserByUsername(session.Username);
    if (!found) {
      return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
    }
    return jsonResponse(true, { dataUrl: fileIdToDataUrl(found.row.SigFileId) });
  } catch (err) {
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy chữ ký'));
  }
}

/**
 * handleUploadMySignature — upload chữ ký cá nhân lên Drive.
 * @param {Object} session
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleUploadMySignature(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    payload = payload || {};
    requireFields(payload, ['imageBase64']);

    var raw = String(payload.imageBase64);
    var mime = 'image/png';
    var base64 = raw;

    var match = raw.match(/^data:(image\/(?:png|jpeg|jpg));base64,(.*)$/i);
    if (match) {
      mime = match[1].toLowerCase();
      if (mime === 'image/jpg') mime = 'image/jpeg';
      base64 = match[2];
    }

    // Ước lượng kích thước nhị phân từ base64
    var padding = 0;
    if (base64.endsWith('==')) padding = 2;
    else if (base64.endsWith('=')) padding = 1;
    var approxBytes = Math.floor((base64.length * 3) / 4) - padding;
    if (approxBytes <= 0) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Dữ liệu ảnh không hợp lệ'));
    }
    if (approxBytes > MAX_SIGNATURE_BYTES) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Ảnh chữ ký vượt quá 1MB'));
    }

    var folderId = PropertiesService.getScriptProperties().getProperty('SIGNATURES_FOLDER_ID');
    if (!folderId) {
      return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Chưa cấu hình thư mục chữ ký'));
    }

    var ext = (mime === 'image/jpeg') ? 'jpg' : 'png';
    var fileName = 'sig_' + session.Username + '_' + Date.now() + '.' + ext;
    var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, fileName);
    var file = DriveApp.getFolderById(folderId).createFile(blob);

    var found = findUserByUsername(session.Username);
    if (!found) {
      return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
    }
    var userSheet = getSheet('Users');
    updateRowByIndex(userSheet, found.rowIndex, { SigFileId: file.getId() });

    writeAuditLog(session.Username, 'UPLOAD_SIGNATURE', session.Username, 'Cập nhật chữ ký cá nhân');

    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi upload chữ ký'));
  }
}