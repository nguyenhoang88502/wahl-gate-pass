/**
 * Util.gs — Thư viện tiện ích dùng chung cho Wahl GatePass backend.
 * KHÔNG chứa logic nghiệp vụ (Users/Requests/Security/Auth).
 */

/** Múi giờ nghiệp vụ dùng xuyên suốt backend. */
var TZ = 'Asia/Ho_Chi_Minh';

/** Danh sách mã lỗi chuẩn hoá theo SPEC §5. */
var ERROR_CODES = [
  'UNKNOWN_ACTION',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'LOCKED_ACCOUNT',
  'RATE_LIMITED',
  'CONFLICT_VERSION',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR'
];

/**
 * Trả về ContentService TextOutput JSON đúng format SPEC §5.
 * @param {boolean} ok
 * @param {Object|null} data
 * @param {{code:string,message:string}|null} error
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function jsonResponse(ok, data, error) {
  var body = { ok: !!ok };
  if (ok) {
    body.data = (data === undefined || data === null) ? {} : data;
  } else {
    body.error = error || errorResponse('INTERNAL_ERROR', 'Lỗi không xác định');
  }
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Tạo object lỗi {code, message} theo danh sách mã chuẩn hoá.
 * @param {string} code
 * @param {string} message
 * @return {{code:string,message:string}}
 */
function errorResponse(code, message) {
  var safeCode = (ERROR_CODES.indexOf(code) >= 0) ? code : 'INTERNAL_ERROR';
  return {
    code: safeCode,
    message: message ? String(message) : ''
  };
}

/**
 * ISO 8601 UTC string của thời điểm hiện tại.
 * Ghi chú: timezone hiển thị (Asia/Ho_Chi_Minh) sẽ được xử lý ở frontend.
 * @return {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Chuỗi ngày 'YYYY-MM-DD' theo Asia/Ho_Chi_Minh.
 * @return {string}
 */
function todayStr() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/**
 * UUID ngẫu nhiên.
 * @return {string}
 */
function newUuid() {
  return Utilities.getUuid();
}

/**
 * Chuyển byte array (số âm hoặc 0..255) sang hex string.
 * @param {number[]} byteArray
 * @return {string}
 */
function toHex(byteArray) {
  var out = '';
  for (var i = 0; i < byteArray.length; i++) {
    var b = byteArray[i] & 0xff;
    var h = b.toString(16);
    if (h.length === 1) h = '0' + h;
    out += h;
  }
  return out;
}

/**
 * Băm mật khẩu: SHA-256 lặp nhiều vòng trên (password + salt).
 * Mỗi vòng hash lại hex string của vòng trước. Deterministic.
 * @param {string} password
 * @param {string} salt
 * @param {number=} iterations mặc định 1000
 * @return {string} hex string cuối cùng
 */
function sha256Hash(password, salt, iterations) {
  var rounds = (typeof iterations === 'number' && iterations > 0) ? iterations : 1000;
  var current = String(password) + String(salt);
  for (var i = 0; i < rounds; i++) {
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      current,
      Utilities.Charset.UTF_8
    );
    current = toHex(digest);
  }
  return current;
}

/**
 * Lấy sheet theo tên từ spreadsheet đang hoạt động.
 * @param {string} name
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} nếu sheet không tồn tại
 */
function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Không tìm thấy Spreadsheet đang hoạt động');
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet không tồn tại: ' + name);
  return sheet;
}

/**
 * Đọc toàn bộ sheet (header dòng 1) thành array of objects.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Object[]}
 */
function sheetToObjects(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];
  for (var r = 0; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[String(headers[c])] = values[r][c];
    }
    out.push(obj);
  }
  return out;
}

/**
 * Append 1 object vào sheet theo đúng thứ tự cột header dòng 1.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Object} obj
 */
function appendRowObject(sheet, obj) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw new Error('Sheet chưa có header: ' + sheet.getName());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var row = [];
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i]);
    row.push(protectCellValue(Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : ''));
  }
  sheet.appendRow(row);
}

/**
 * Google Sheets tự "đoán kiểu" chuỗi khi ghi: '08:30' -> time, '2026-10-02' -> date,
 * '00123' -> 123, '=...' -> công thức. Thêm dấu ' ở đầu để Sheets giữ nguyên dạng text
 * (dấu ' không được lưu vào giá trị). Đồng thời chặn formula injection.
 * @param {*} v
 * @return {*}
 */
function protectCellValue(v) {
  if (typeof v !== 'string' || v === '') return v;
  if (/^[=+\-@]/.test(v) || /^[\d\s:\/.,]+$/.test(v) || /^(true|false)$/i.test(v)) {
    return "'" + v;
  }
  return v;
}

/** Múi giờ của spreadsheet (để đổi ô Date/Time do Sheets tự chuyển về lại text). */
var _SHEET_TZ = null;
function sheetTz() {
  if (_SHEET_TZ) return _SHEET_TZ;
  try {
    _SHEET_TZ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || TZ;
  } catch (err) {
    _SHEET_TZ = TZ;
  }
  return _SHEET_TZ;
}

/**
 * Chuẩn hoá giá trị ô đã bị Sheets đổi kiểu về lại chuỗi:
 *  kind 'date' -> 'YYYY-MM-DD', 'time' -> 'HH:mm', mặc định -> chuỗi (Date -> ISO).
 * @param {*} v
 * @param {string=} kind
 * @return {string}
 */
function cellToText(v, kind) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    if (kind === 'date') return Utilities.formatDate(v, sheetTz(), 'yyyy-MM-dd');
    if (kind === 'time') return Utilities.formatDate(v, sheetTz(), 'HH:mm');
    return v.toISOString();
  }
  return String(v);
}

/**
 * Tìm dòng đầu tiên có cột columnName = value (1-based, tính cả header).
 * So sánh không phân biệt hoa thường nếu value là string.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} columnName
 * @param {*} value
 * @return {number} rowIndex hoặc -1
 */
function findRowIndexByColumn(sheet, columnName, value) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return -1;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var colIdx = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]) === String(columnName)) { colIdx = i + 1; break; }
  }
  if (colIdx < 0) return -1;
  var colValues = sheet.getRange(2, colIdx, lastRow - 1, 1).getValues();
  var target = value;
  var isStr = (typeof value === 'string');
  var targetLower = isStr ? value.toLowerCase() : null;
  for (var r = 0; r < colValues.length; r++) {
    var cell = colValues[r][0];
    if (isStr) {
      // Ô có thể đã bị Sheets đổi sang số (VD mã NV) -> so sánh theo chuỗi.
      if (cell !== '' && cell !== null && String(cell).toLowerCase() === targetLower) return r + 2;
    } else if (cell === target) {
      return r + 2;
    }
  }
  return -1;
}

/**
 * Ghi đè 1 dòng theo object; chỉ ghi các cột có trong object, giữ nguyên cột khác.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rowIndex 1-based
 * @param {Object} obj
 */
function updateRowByIndex(sheet, rowIndex, obj) {
  if (rowIndex < 2) throw new Error('rowIndex không hợp lệ: ' + rowIndex);
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw new Error('Sheet chưa có header: ' + sheet.getName());
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  // Đọc 1 lần, ghi 1 lần cả dòng (nhanh hơn nhiều so với setValue từng ô).
  var range = sheet.getRange(rowIndex, 1, 1, lastCol);
  var row = range.getValues()[0];
  var changed = false;
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i]);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      row[i] = obj[key];
      changed = true;
    }
    // Ghi lại cả dòng nên mọi ô chuỗi đều phải được bảo vệ khỏi việc Sheets đổi kiểu.
    row[i] = protectCellValue(row[i]);
  }
  if (changed) range.setValues([row]);
}

/**
 * Cache dùng chung (CacheService) — bọc try/catch để không bao giờ làm hỏng luồng chính.
 */
function cacheGetJson(key) {
  try {
    var raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function cachePutJson(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), seconds || 300);
  } catch (err) {
    // bỏ qua
  }
}

function cacheRemove(key) {
  try {
    CacheService.getScriptCache().remove(key);
  } catch (err) {
    // bỏ qua
  }
}

/** Key cache danh sách bộ phận (public getDepartments). */
var DEPT_CACHE_KEY = 'gp_departments_v2';

/** Xoá cache liên quan bộ phận/người duyệt — gọi sau mọi thay đổi Users/Departments. */
function invalidateDirectoryCache() {
  cacheRemove(DEPT_CACHE_KEY);
}

/**
 * Đọc Users 1 lần, trả về map usernameLower -> row (dùng để tra tên người duyệt nhanh).
 * @return {Object}
 */
function loadUsersMap() {
  var rows = sheetToObjects(getSheet('Users'));
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var u = rows[i];
    if (u && u.Username) map[String(u.Username).toLowerCase()] = u;
  }
  return map;
}

/**
 * Chuyển ô ngày của sheet (Date hoặc chuỗi) thành 'YYYY-MM-DD'.
 * @param {*} d
 * @return {string}
 */
function dateCellToStr(d) {
  return cellToText(d, 'date');
}

/**
 * Trim, cắt bớt nếu quá maxLen, loại bỏ ký tự điều khiển.
 * @param {*} str
 * @param {number=} maxLen mặc định 500
 * @return {string}
 */
function sanitizeString(str, maxLen) {
  var limit = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 500;
  if (str === null || str === undefined) return '';
  var s = String(str);
  // Loại bỏ ký tự điều khiển (0x00-0x1F, 0x7F) trừ \t \n \r
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  s = s.trim();
  if (s.length > limit) s = s.substring(0, limit);
  return s;
}

/**
 * Kiểm tra các field bắt buộc có trong payload (không rỗng).
 * @param {Object} payload
 * @param {string[]} fieldNames
 * @throws {Error} nếu thiếu field
 */
function requireFields(payload, fieldNames) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload không hợp lệ');
  }
  var missing = [];
  for (var i = 0; i < fieldNames.length; i++) {
    var f = fieldNames[i];
    var v = payload[f];
    if (v === undefined || v === null || v === '') missing.push(f);
  }
  if (missing.length > 0) {
    var err = new Error('Thiếu trường bắt buộc: ' + missing.join(', '));
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
}

/**
 * Sinh mã RequestId dạng GP-YYYYMMDD-NNN theo ngày hôm nay (Asia/Ho_Chi_Minh).
 * NNN = (số thứ tự lớn nhất của các RequestId đã cấp hôm nay) + 1, pad 3 chữ số.
 * Dựa vào cột RequestId (không dựa vào cột Date — Date là ngày xin phép, có thể khác hôm nay).
 * Hàm này PHẢI được gọi bên trong LockService.getScriptLock() ở Requests.gs.
 * @return {string}
 */
function genRequestId() {
  var today = todayStr();
  var prefix = 'GP-' + today.replace(/-/g, '') + '-';
  var sheet = getSheet('Requests');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var maxSeq = 0;
  if (lastRow >= 2 && lastCol >= 1) {
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var idCol = -1;
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]) === 'RequestId') { idCol = i + 1; break; }
    }
    if (idCol > 0) {
      var colValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
      for (var r = 0; r < colValues.length; r++) {
        var id = String(colValues[r][0] || '');
        if (id.indexOf(prefix) !== 0) continue;
        var n = parseInt(id.substring(prefix.length), 10);
        if (!isNaN(n) && n > maxSeq) maxSeq = n;
      }
    }
  }
  var seq = maxSeq + 1;
  var seqStr = seq < 1000 ? ('000' + seq).slice(-3) : String(seq);
  return prefix + seqStr;
}