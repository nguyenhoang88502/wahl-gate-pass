/**
 * Setup.gs — Khởi tạo cấu trúc Google Sheet, thư mục Drive chữ ký, Config mặc định
 * và tài khoản admin đầu tiên. Chạy 1 lần thủ công từ Apps Script editor.
 *
 * Idempotent: chạy lại nhiều lần không tạo trùng, không ghi đè dữ liệu đã có.
 * KHÔNG log mật khẩu/hash ra execution log.
 */

/** Định nghĩa header chính xác theo SPEC.md §2 — thứ tự cột là hợp đồng. */
var SETUP_SHEET_DEFS = [
  {
    name: 'Requests',
    headers: [
      'RequestId', 'CreatedAt', 'Date', 'FullName', 'EmplId', 'Dept',
      'ComeOutPlanned', 'ComeInPlanned', 'Reason', 'ReasonDetail', 'Status',
      'SupId', 'MgrId', 'HrId',
      'ApplicantSigFileId', 'SupSigFileId', 'MgrSigFileId', 'HrSigFileId',
      'SupAt', 'MgrAt', 'HrAt',
      'RejectedBy', 'RejectReason',
      'GuardOutBy', 'GuardOutAt', 'GuardInBy', 'GuardInAt', 'GuardSigFileId',
      'Version'
    ]
  },
  {
    name: 'Users',
    headers: [
      'Username', 'FullName', 'EmplId', 'Dept', 'Role', 'Email',
      'PasswordHash', 'Salt', 'MustChangePw', 'Status',
      'FailedCount', 'LockedUntil', 'SigFileId', 'CreatedAt',
      'ApprovedBy', 'ApprovedAt'
    ]
  },
  {
    name: 'Sessions',
    headers: ['Token', 'Username', 'Role', 'ExpiresAt']
  },
  {
    name: 'Departments',
    headers: ['Dept', 'SupervisorUsernames', 'ManagerUsername']
  },
  {
    name: 'Config',
    headers: ['Key', 'Value']
  },
  {
    name: 'AuditLog',
    headers: ['Time', 'Actor', 'Action', 'TargetId', 'Detail']
  }
];

/** Config mặc định theo SPEC.md §2.5. */
var SETUP_DEFAULT_CONFIG = [
  { Key: 'MAX_REQUESTS_PER_EMPL_PER_DAY', Value: '5' },
  { Key: 'MAX_REGISTER_PER_DAY', Value: '20' },
  { Key: 'MAX_PENDING_USERS', Value: '50' },
  { Key: 'EMAIL_NOTIFICATIONS_ENABLED', Value: 'false' }
];

/** Tên thư mục Drive lưu ảnh chữ ký. */
var SETUP_SIGNATURES_FOLDER_NAME = 'GatePass Signatures';

/**
 * Điểm vào chính — chạy thủ công 1 lần từ Apps Script editor.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Không tìm thấy Spreadsheet đang hoạt động. Hãy mở file Sheet rồi chạy lại setup().');
  }

  ensureSheets(ss);
  ensureSignaturesFolder();
  ensureDefaultConfig();
  ensureInitialAdmin();
  Logger.log('setup() hoàn tất.');
}

/**
 * Tạo sheet nếu chưa có; ghi header nếu dòng 1 rỗng. Không ghi đè header đã có.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function ensureSheets(ss) {
  for (var i = 0; i < SETUP_SHEET_DEFS.length; i++) {
    var def = SETUP_SHEET_DEFS[i];
    var sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      Logger.log('Đã tạo sheet ' + def.name);
    } else {
      Logger.log('Sheet ' + def.name + ' đã tồn tại, bỏ qua tạo mới');
    }
    writeHeaderIfEmpty(sheet, def.name, def.headers);
  }
}

/**
 * Ghi header vào dòng 1 nếu dòng 1 đang rỗng. Không ghi đè nếu đã có header.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} sheetName
 * @param {string[]} headers
 */
function writeHeaderIfEmpty(sheet, sheetName, headers) {
  var lastCol = sheet.getLastColumn();
  var existing = [];
  if (lastCol >= 1) {
    existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  }
  var hasHeader = false;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i] !== '' && existing[i] !== null && existing[i] !== undefined) {
      hasHeader = true;
      break;
    }
  }
  if (hasHeader) {
    Logger.log('Header sheet ' + sheetName + ' đã có, bỏ qua');
    return;
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  Logger.log('Đã ghi header cho sheet ' + sheetName + ' (' + headers.length + ' cột)');
}

/**
 * Đảm bảo thư mục Drive 'GatePass Signatures' tồn tại và lưu id vào Script Properties.
 * Nếu property đã có và folder còn tồn tại → bỏ qua.
 */
function ensureSignaturesFolder() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty('SIGNATURES_FOLDER_ID');
  if (existingId) {
    try {
      var existing = DriveApp.getFolderById(existingId);
      if (existing && !existing.isTrashed()) {
        Logger.log('Thư mục Drive chữ ký đã có (id đã lưu trong Script Properties)');
        return;
      }
    } catch (err) {
      Logger.log('SIGNATURES_FOLDER_ID cũ không truy cập được, sẽ tạo/tìm lại');
    }
  }

  var folder = null;
  var it = DriveApp.getFoldersByName(SETUP_SIGNATURES_FOLDER_NAME);
  if (it.hasNext()) {
    folder = it.next();
    Logger.log('Đã tìm thấy thư mục Drive "' + SETUP_SIGNATURES_FOLDER_NAME + '"');
  } else {
    folder = DriveApp.createFolder(SETUP_SIGNATURES_FOLDER_NAME);
    Logger.log('Đã tạo thư mục Drive "' + SETUP_SIGNATURES_FOLDER_NAME + '"');
  }
  props.setProperty('SIGNATURES_FOLDER_ID', folder.getId());
}

/**
 * Ghi các dòng Config mặc định nếu sheet Config đang rỗng (chỉ có header).
 */
function ensureDefaultConfig() {
  var sheet = getSheet('Config');
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    Logger.log('Sheet Config đã có dữ liệu, bỏ qua ghi mặc định');
    return;
  }
  for (var i = 0; i < SETUP_DEFAULT_CONFIG.length; i++) {
    appendRowObject(sheet, SETUP_DEFAULT_CONFIG[i]);
  }
  Logger.log('Đã ghi ' + SETUP_DEFAULT_CONFIG.length + ' dòng Config mặc định');
}

/**
 * Tạo tài khoản admin đầu tiên nếu sheet Users chưa có dòng dữ liệu nào.
 * Mật khẩu tạm đọc từ Script Properties key ADMIN_INITIAL_PASSWORD.
 * KHÔNG log mật khẩu/hash.
 */
function ensureInitialAdmin() {
  var sheet = getSheet('Users');
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    Logger.log('Sheet Users đã có dữ liệu, bỏ qua tạo admin đầu tiên');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var tempPassword = props.getProperty('ADMIN_INITIAL_PASSWORD');
  if (!tempPassword) {
    throw new Error(
      'Chưa đặt Script Property ADMIN_INITIAL_PASSWORD. ' +
      'Vào Project Settings → Script Properties để đặt mật khẩu tạm cho admin trước khi chạy setup().'
    );
  }

  var salt = newUuid();
  var hash = sha256Hash(tempPassword, salt);
  var now = nowIso();

  var adminRow = {
    Username: 'admin',
    FullName: 'Quan tri he thong',
    EmplId: 'ADMIN001',
    Dept: '',
    Role: 'admin',
    Email: '',
    PasswordHash: hash,
    Salt: salt,
    MustChangePw: true,
    Status: 'ACTIVE',
    FailedCount: 0,
    LockedUntil: '',
    SigFileId: '',
    CreatedAt: now,
    ApprovedBy: 'SYSTEM',
    ApprovedAt: now
  };

  appendRowObject(sheet, adminRow);
  Logger.log('Đã tạo admin đầu tiên (username=admin, MustChangePw=true)');
}