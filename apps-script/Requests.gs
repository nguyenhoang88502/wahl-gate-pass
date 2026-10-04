/**
 * Requests.gs — Nghiệp vụ giấy phép ra/vào cổng (Wahl GatePass).
 * Phụ thuộc Util.gs và Auth.gs. Không định nghĩa lại helper đã có.
 */

/** Enum lý do hợp lệ theo SPEC §2.1. */
var REASON_ENUM = ['PERSONAL', 'ANNUAL_LEAVE', 'MATERNITY', 'SICK', 'JOB_ACCIDENT', 'OTHER'];

/** Trạng thái cuối — không thể approve/reject tiếp. */
var FINAL_STATUSES = ['APPROVED', 'OUT', 'COMPLETED', 'REJECTED'];

/** Trạng thái có thể reject. */
var REJECTABLE_STATUSES = ['PENDING_SUP', 'PENDING_MGR', 'PENDING_HR'];

/**
 * Chuyển 1 dòng Requests (PascalCase từ sheet) thành RequestDTO camelCase (SPEC §5.1).
 * KHÔNG bao gồm các trường FileId.
 * @param {Object} row
 * @return {Object}
 */
function requestRowToDTO(row) {
  if (!row) return null;
  var version = parseInt(row.Version, 10);
  if (isNaN(version)) version = 0;
  // cellToText: Sheets có thể đã tự đổi '08:30' thành Time, '2026-10-02' thành Date,
  // mã NV thành số... -> đưa tất cả về đúng chuỗi mà frontend mong đợi.
  return {
    requestId: cellToText(row.RequestId),
    createdAt: cellToText(row.CreatedAt),
    date: cellToText(row.Date, 'date'),
    fullName: cellToText(row.FullName),
    emplId: cellToText(row.EmplId),
    dept: cellToText(row.Dept),
    comeOutPlanned: cellToText(row.ComeOutPlanned, 'time'),
    comeInPlanned: cellToText(row.ComeInPlanned, 'time'),
    reason: cellToText(row.Reason),
    reasonDetail: cellToText(row.ReasonDetail),
    status: cellToText(row.Status),
    supId: cellToText(row.SupId),
    mgrId: cellToText(row.MgrId),
    hrId: cellToText(row.HrId),
    supAt: cellToText(row.SupAt),
    mgrAt: cellToText(row.MgrAt),
    hrAt: cellToText(row.HrAt),
    rejectedBy: cellToText(row.RejectedBy),
    rejectReason: cellToText(row.RejectReason),
    guardOutBy: cellToText(row.GuardOutBy),
    guardOutAt: cellToText(row.GuardOutAt),
    guardInBy: cellToText(row.GuardInBy),
    guardInAt: cellToText(row.GuardInAt),
    version: version
  };
}

/**
 * Map username -> họ tên cho mọi người duyệt/bảo vệ xuất hiện trong danh sách request,
 * để frontend hiển thị TÊN thay vì username.
 * @param {Object[]} dtos RequestDTO
 * @param {Object=} usersMap từ loadUsersMap()
 * @return {Object}
 */
function buildApproverNames(dtos, usersMap) {
  var map = usersMap || loadUsersMap();
  var names = {};
  var fields = ['supId', 'mgrId', 'hrId', 'rejectedBy', 'guardOutBy', 'guardInBy'];
  for (var i = 0; i < dtos.length; i++) {
    for (var f = 0; f < fields.length; f++) {
      var u = dtos[i] ? dtos[i][fields[f]] : '';
      if (!u || names[u] !== undefined) continue;
      var row = map[String(u).toLowerCase()];
      names[u] = row ? (cellToText(row.FullName) || u) : u;
    }
  }
  return names;
}

/**
 * Danh sách bộ phận mà 1 supervisor/manager được liên kết (Dept của user + mọi bộ phận
 * có tên họ trong SupervisorUsernames/ManagerUsername).
 * @param {string} username
 * @param {Object} userRow
 * @return {Object} set deptLower -> true
 */
function linkedDeptSet(username, userRow) {
  var set = {};
  var own = cellToText(userRow && userRow.Dept).toLowerCase();
  if (own) set[own] = true;
  var me = String(username || '').toLowerCase();
  var rows = sheetToObjects(getSheet('Departments'));
  for (var i = 0; i < rows.length; i++) {
    var d = rows[i];
    if (!d || !d.Dept) continue;
    var sups = splitUsernames(d.SupervisorUsernames);
    var isLinked = String(d.ManagerUsername || '').toLowerCase() === me;
    for (var s = 0; s < sups.length && !isLinked; s++) {
      if (sups[s].toLowerCase() === me) isLinked = true;
    }
    if (isLinked) set[cellToText(d.Dept).toLowerCase()] = true;
  }
  return set;
}

/** Tách chuỗi 'a, b,c' -> ['a','b','c'] (bỏ rỗng). */
function splitUsernames(raw) {
  var out = [];
  if (!raw) return out;
  var parts = String(raw).split(',');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p) out.push(p);
  }
  return out;
}

/**
 * Supervisor/manager có được xem request này không: request gán đích danh cho họ,
 * hoặc thuộc bộ phận họ được liên kết.
 */
function approverCanSee(username, deptSet, dto) {
  var me = String(username || '').toLowerCase();
  if (String(dto.supId || '').toLowerCase() === me) return true;
  if (String(dto.mgrId || '').toLowerCase() === me) return true;
  return !!deptSet[String(dto.dept || '').toLowerCase()];
}

/**
 * Tìm dòng Requests theo RequestId.
 * @param {string} requestId
 * @return {{row:Object,rowIndex:number}|null}
 */
function findRequestById(requestId) {
  if (!requestId) return null;
  var sheet = getSheet('Requests');
  var rowIndex = findRowIndexByColumn(sheet, 'RequestId', String(requestId));
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
 * Tìm dòng Departments theo Dept (không phân biệt hoa thường).
 * @param {string} dept
 * @return {Object|null}
 */
function findDepartmentRow(dept) {
  if (!dept) return null;
  var sheet = getSheet('Departments');
  var rowIndex = findRowIndexByColumn(sheet, 'Dept', String(dept));
  if (rowIndex < 0) return null;
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  var obj = {};
  for (var i = 0; i < headers.length; i++) {
    obj[String(headers[i])] = values[i];
  }
  return obj;
}

/**
 * username -> ApproverOption {username, fullName}; null nếu user không tồn tại, không ACTIVE
 * hoặc không đúng role yêu cầu (người không đủ quyền thì không hiện trong danh sách chọn).
 * @param {string} username
 * @param {Object} usersMap
 * @param {string} requiredRole
 * @return {Object|null}
 */
function usernameToApproverOption(username, usersMap, requiredRole) {
  var u = sanitizeString(username, 60);
  if (!u) return null;
  var row = usersMap[u.toLowerCase()];
  if (!row) return null;
  if (String(row.Status) !== 'ACTIVE') return null;
  var role = String(row.Role || '');
  if (requiredRole && role !== requiredRole && role !== 'admin') return null;
  return {
    username: cellToText(row.Username) || u,
    fullName: cellToText(row.FullName)
  };
}

/**
 * Xây dựng {dept, supervisors:[ApproverOption], manager:ApproverOption|null} từ 1 dòng Departments.
 * @param {Object} deptRow
 * @param {Object=} usersMap
 * @return {Object}
 */
function buildDepartmentInfo(deptRow, usersMap) {
  var map = usersMap || loadUsersMap();
  var supervisors = [];
  var sups = splitUsernames(deptRow && deptRow.SupervisorUsernames);
  for (var i = 0; i < sups.length; i++) {
    var opt = usernameToApproverOption(sups[i], map, 'supervisor');
    if (opt) supervisors.push(opt);
  }
  var manager = null;
  if (deptRow && deptRow.ManagerUsername) {
    manager = usernameToApproverOption(deptRow.ManagerUsername, map, 'manager');
  }
  return {
    dept: cellToText(deptRow && deptRow.Dept),
    supervisors: supervisors,
    manager: manager
  };
}

/** Danh sách bộ phận public (có cache CacheService 5 phút, xoá khi admin sửa Users/Departments). */
function getDepartmentsCached() {
  var cached = cacheGetJson(DEPT_CACHE_KEY);
  if (cached) return cached;
  var rows = sheetToObjects(getSheet('Departments'));
  var usersMap = loadUsersMap();
  var departments = [];
  for (var i = 0; i < rows.length; i++) {
    var d = rows[i];
    if (!d || !d.Dept) continue;
    departments.push(buildDepartmentInfo(d, usersMap));
  }
  departments.sort(function (a, b) { return a.dept.localeCompare(b.dept); });
  cachePutJson(DEPT_CACHE_KEY, departments, 300);
  return departments;
}

/**
 * handleGetDepartments — trả về toàn bộ bộ phận kèm supervisor/manager.
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetDepartments(payload) {
  try {
    return jsonResponse(true, { departments: getDepartmentsCached() });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy danh sách bộ phận'));
  }
}

/**
 * handleGetApproverOptions — trả về supervisor/manager của 1 bộ phận.
 * @param {Object} payload {dept}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetApproverOptions(payload) {
  try {
    payload = payload || {};
    var dept = sanitizeString(payload.dept, 80);
    if (!dept) {
      return jsonResponse(true, { supervisors: [], manager: null });
    }
    var all = getDepartmentsCached();
    for (var i = 0; i < all.length; i++) {
      if (all[i].dept.toLowerCase() === dept.toLowerCase()) {
        return jsonResponse(true, { supervisors: all[i].supervisors, manager: all[i].manager });
      }
    }
    return jsonResponse(true, { supervisors: [], manager: null });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy người duyệt'));
  }
}

/**
 * Kiểm tra chuỗi ngày 'YYYY-MM-DD' hợp lệ.
 * @param {string} s
 * @return {boolean}
 */
function isValidDateStr(s) {
  if (!s || typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var parts = s.split('-');
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d;
}

/**
 * Kiểm tra chuỗi giờ 'HH:mm' hợp lệ.
 * @param {string} s
 * @return {boolean}
 */
function isValidTimeStr(s) {
  if (!s || typeof s !== 'string') return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/**
 * Đếm số request của 1 EmplId trong ngày hôm nay.
 * @param {string} emplId
 * @param {string} today
 * @return {number}
 */
function countRequestsTodayByEmpl(emplId, today) {
  var sheet = getSheet('Requests');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var emplCol = -1, dateCol = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i]);
    if (h === 'EmplId') emplCol = i + 1;
    if (h === 'Date') dateCol = i + 1;
  }
  if (emplCol < 0 || dateCol < 0) return 0;
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var target = String(emplId || '').toLowerCase();
  var count = 0;
  for (var r = 0; r < values.length; r++) {
    if (cellToText(values[r][emplCol - 1]).toLowerCase() !== target) continue;
    if (dateCellToStr(values[r][dateCol - 1]) === today) count++;
  }
  return count;
}

/**
 * Lưu ảnh chữ ký base64 vào Drive folder SIGNATURES_FOLDER_ID.
 * @param {string} base64Raw
 * @param {string} fileName
 * @return {string} fileId
 */
function saveSignatureToDrive(base64Raw, fileName) {
  var raw = String(base64Raw || '');
  var mime = 'image/png';
  var base64 = raw;
  var match = raw.match(/^data:(image\/(?:png|jpeg|jpg));base64,(.*)$/i);
  if (match) {
    mime = match[1].toLowerCase();
    if (mime === 'image/jpg') mime = 'image/jpeg';
    base64 = match[2];
  }
  var folderId = PropertiesService.getScriptProperties().getProperty('SIGNATURES_FOLDER_ID');
  if (!folderId) throw new Error('Chưa cấu hình thư mục chữ ký');
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, fileName);
  var file = DriveApp.getFolderById(folderId).createFile(blob);
  return file.getId();
}

/**
 * handleSubmitRequest — nhân viên gửi giấy phép ra/vào cổng.
 * @param {Object} payload
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleSubmitRequest(payload) {
  try {
    payload = payload || {};

    // Honeypot: giả thành công, không ghi gì.
    if (payload.honeypot !== undefined && payload.honeypot !== null && String(payload.honeypot).length > 0) {
      return jsonResponse(true, { requestId: 'GP-00000000-000' });
    }

    // Không có trường bắt buộc: thiếu thì vẫn lưu (frontend chỉ tô đỏ để nhắc).
    // Chỉ từ chối khi dữ liệu có nhập nhưng sai định dạng.
    var fullName = sanitizeString(payload.fullName, 120);
    var emplId = sanitizeString(payload.emplId, 40);
    var dept = sanitizeString(payload.dept, 80);
    var date = sanitizeString(payload.date, 10);
    var comeOutPlanned = sanitizeString(payload.comeOutPlanned, 5);
    var comeInPlanned = sanitizeString(payload.comeInPlanned, 5);
    var reason = sanitizeString(payload.reason, 30);
    var reasonDetail = sanitizeString(payload.reasonDetail, 500);
    var supId = sanitizeString(payload.supId, 60);
    var mgrId = sanitizeString(payload.mgrId, 60);

    var today = todayStr();
    if (!date) date = today;
    if (!isValidDateStr(date)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Ngày không hợp lệ (định dạng YYYY-MM-DD)'));
    }
    if (comeOutPlanned && !isValidTimeStr(comeOutPlanned)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Giờ ra dự kiến không hợp lệ (HH:mm)'));
    }
    if (comeInPlanned && !isValidTimeStr(comeInPlanned)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Giờ vào dự kiến không hợp lệ (HH:mm)'));
    }
    if (reason && REASON_ENUM.indexOf(reason) < 0) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Lý do không hợp lệ'));
    }

    // Người duyệt phải là tài khoản ACTIVE đúng vai trò; nếu không thì bỏ qua bước đó
    // (tránh giấy phép bị "kẹt" ở người không có quyền duyệt). Lưu đúng username chuẩn.
    var usersMap = loadUsersMap();
    var supOpt = supId ? usernameToApproverOption(supId, usersMap, 'supervisor') : null;
    var mgrOpt = mgrId ? usernameToApproverOption(mgrId, usersMap, 'manager') : null;
    supId = supOpt ? supOpt.username : '';
    mgrId = mgrOpt ? mgrOpt.username : '';

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var requestId = '';
    try {
      // Rate limit theo EmplId/ngày
      var maxPerDay = parseInt(getConfigValue('MAX_REQUESTS_PER_EMPL_PER_DAY', '5'), 10);
      // Giấy không ghi mã NV được gộp chung 1 nhóm, hạn mức rộng hơn (chống spam).
      if (!emplId && !isNaN(maxPerDay)) maxPerDay = maxPerDay * 10;
      if (!isNaN(maxPerDay) && maxPerDay > 0) {
        var used = countRequestsTodayByEmpl(emplId, today);
        if (used >= maxPerDay) {
          return jsonResponse(false, null, errorResponse('RATE_LIMITED', 'Đã đạt giới hạn số giấy phép trong ngày'));
        }
      }

      // Lưu chữ ký applicant
      var sigFileId = '';
      if (payload.applicantSignature) {
        try {
          sigFileId = saveSignatureToDrive(
            payload.applicantSignature,
            'sig_req_' + (emplId || 'x') + '_' + Date.now() + '.png'
          );
        } catch (sigErr) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Không lưu được chữ ký, vui lòng thử lại'));
        }
      }

      requestId = genRequestId();
      // Bỏ qua bước không có người duyệt: không sup -> MGR, không mgr -> HR.
      var initialStatus = supId ? 'PENDING_SUP' : (mgrId ? 'PENDING_MGR' : 'PENDING_HR');

      var sheet = getSheet('Requests');
      appendRowObject(sheet, {
        RequestId: requestId,
        CreatedAt: nowIso(),
        Date: date,
        FullName: fullName,
        EmplId: emplId,
        Dept: dept,
        ComeOutPlanned: comeOutPlanned,
        ComeInPlanned: comeInPlanned,
        Reason: reason,
        ReasonDetail: reasonDetail,
        Status: initialStatus,
        SupId: supId,
        MgrId: mgrId,
        HrId: '',
        ApplicantSigFileId: sigFileId,
        SupSigFileId: '',
        MgrSigFileId: '',
        HrSigFileId: '',
        SupAt: '',
        MgrAt: '',
        HrAt: '',
        RejectedBy: '',
        RejectReason: '',
        GuardOutBy: '',
        GuardOutAt: '',
        GuardInBy: '',
        GuardInAt: '',
        GuardSigFileId: '',
        Version: 1
      });

      writeAuditLog(emplId, 'SUBMIT_REQUEST', requestId, 'Gửi giấy phép ra/vào cổng');
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, { requestId: requestId });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi gửi giấy phép'));
  }
}

/**
 * handleGetRequestStatus — tra cứu trạng thái giấy phép (public, cần khớp RequestId + EmplId).
 * @param {Object} payload {requestId, emplId}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetRequestStatus(payload) {
  try {
    payload = payload || {};
    requireFields(payload, ['requestId', 'emplId']);
    var requestId = sanitizeString(payload.requestId, 40);
    var emplId = sanitizeString(payload.emplId, 40);

    var found = findRequestById(requestId);
    if (!found) {
      return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy giấy phép'));
    }
    if (cellToText(found.row.EmplId).toLowerCase() !== emplId.toLowerCase()) {
      return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy giấy phép'));
    }

    var row = found.row;
    var dto = requestRowToDTO(row);
    var timeline = [];
    if (dto.supAt) timeline.push({ step: 'PENDING_SUP', by: dto.supId, at: dto.supAt, action: 'APPROVE' });
    if (dto.mgrAt) timeline.push({ step: 'PENDING_MGR', by: dto.mgrId, at: dto.mgrAt, action: 'APPROVE' });
    if (dto.hrAt) timeline.push({ step: 'PENDING_HR', by: dto.hrId, at: dto.hrAt, action: 'APPROVE' });
    if (dto.guardOutAt) timeline.push({ step: 'OUT', by: dto.guardOutBy, at: dto.guardOutAt, action: 'RECORD_OUT' });
    if (dto.guardInAt) timeline.push({ step: 'COMPLETED', by: dto.guardInBy, at: dto.guardInAt, action: 'RECORD_IN' });
    // Lưu ý: Sheet Requests không có cột RejectedAt riêng (xem SPEC §2.1), nên mốc thời gian
    // từ chối không có sẵn; chỉ hiển thị người từ chối + lý do.
    if (dto.rejectedBy) timeline.push({ step: 'REJECTED', by: dto.rejectedBy, at: '', action: 'REJECT' });

    timeline.sort(function (a, b) {
      var ta = a.at ? new Date(a.at).getTime() : 0;
      var tb = b.at ? new Date(b.at).getTime() : 0;
      return ta - tb;
    });

    // Khi đã APPROVED trở lên, đính kèm chữ ký base64 để trang nhân viên (công khai) có thể
    // tự xuất PDF đầy đủ mà không cần đăng nhập (getRequestPdfData yêu cầu role nội bộ).
    var signatures = null;
    var pdfReadyStatuses = ['APPROVED', 'OUT', 'COMPLETED'];
    if (pdfReadyStatuses.indexOf(String(row.Status || '')) !== -1) {
      signatures = {
        applicant: fileIdToDataUrl(row.ApplicantSigFileId),
        supervisor: fileIdToDataUrl(row.SupSigFileId),
        manager: fileIdToDataUrl(row.MgrSigFileId),
        hr: fileIdToDataUrl(row.HrSigFileId),
        security: fileIdToDataUrl(row.GuardSigFileId)
      };
    }

    return jsonResponse(true, {
      request: dto,
      timeline: timeline,
      signatures: signatures,
      names: buildApproverNames([dto])
    });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi tra cứu giấy phép'));
  }
}

/**
 * Helper nội bộ: kiểm tra session có quyền duyệt/từ chối dòng Request hiện tại không.
 * @param {Object} session {Username, Role}
 * @param {Object} row dòng Requests
 * @return {boolean}
 */
function requireApprovalStepRole(session, row) {
  if (!session || !row) return false;
  var role = String(session.Role || '');
  var username = String(session.Username || '');
  if (role === 'admin') return true;

  var status = String(row.Status || '');
  if (status === 'PENDING_SUP') {
    if (role !== 'supervisor') return false;
    var supId = String(row.SupId || '');
    if (!supId) return false;
    return supId.toLowerCase() === username.toLowerCase();
  }
  if (status === 'PENDING_MGR') {
    if (role !== 'manager') return false;
    var mgrId = String(row.MgrId || '');
    if (!mgrId) return false;
    return mgrId.toLowerCase() === username.toLowerCase();
  }
  if (status === 'PENDING_HR') {
    return role === 'hr';
  }
  return false;
}

/**
 * handleApprove — duyệt giấy phép ở bước hiện tại.
 * @param {Object} session
 * @param {Object} payload {requestId, version}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleApprove(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    payload = payload || {};
    requireFields(payload, ['requestId', 'version']);

    var requestId = sanitizeString(payload.requestId, 40);
    var clientVersion = parseInt(payload.version, 10);
    if (isNaN(clientVersion)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Version không hợp lệ'));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var updatedRow = null;
    try {
      var found = findRequestById(requestId);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy giấy phép'));
      }
      var row = found.row;
      var currentVersion = parseInt(row.Version, 10);
      if (isNaN(currentVersion)) currentVersion = 0;
      if (currentVersion !== clientVersion) {
        return jsonResponse(false, null, errorResponse('CONFLICT_VERSION', 'Giấy phép đã được cập nhật bởi người khác, vui lòng tải lại'));
      }
      var status = String(row.Status || '');
      if (FINAL_STATUSES.indexOf(status) >= 0) {
        return jsonResponse(false, null, errorResponse('INVALID_TRANSITION', 'Giấy phép đã ở trạng thái cuối, không thể duyệt'));
      }
      if (!requireApprovalStepRole(session, row)) {
        return jsonResponse(false, null, errorResponse('FORBIDDEN', 'Bạn không có quyền duyệt bước này'));
      }

      var userFound = findUserByUsername(session.Username);
      if (!userFound) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }
      var sigFileId = String(userFound.row.SigFileId || '');
      if (!sigFileId) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Bạn chưa có chữ ký số, vui lòng upload trước khi duyệt'));
      }

      var updates = {};
      var now = nowIso();
      if (status === 'PENDING_SUP') {
        updates.Status = String(row.MgrId || '') ? 'PENDING_MGR' : 'PENDING_HR';
        updates.SupSigFileId = sigFileId;
        updates.SupAt = now;
      } else if (status === 'PENDING_MGR') {
        updates.Status = 'PENDING_HR';
        updates.MgrSigFileId = sigFileId;
        updates.MgrAt = now;
      } else if (status === 'PENDING_HR') {
        updates.Status = 'APPROVED';
        updates.HrId = session.Username;
        updates.HrSigFileId = sigFileId;
        updates.HrAt = now;
      } else {
        return jsonResponse(false, null, errorResponse('INVALID_TRANSITION', 'Trạng thái không hợp lệ để duyệt'));
      }
      updates.Version = currentVersion + 1;

      var sheet = getSheet('Requests');
      updateRowByIndex(sheet, found.rowIndex, updates);

      writeAuditLog(session.Username, 'APPROVE', requestId, 'Duyệt bước ' + status);

      var refreshed = findRequestById(requestId);
      updatedRow = refreshed ? refreshed.row : row;
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, { request: requestRowToDTO(updatedRow) });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi duyệt giấy phép'));
  }
}

/**
 * handleReject — từ chối giấy phép ở bước hiện tại.
 * @param {Object} session
 * @param {Object} payload {requestId, version, reason}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleReject(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    payload = payload || {};
    requireFields(payload, ['requestId', 'version', 'reason']);

    var requestId = sanitizeString(payload.requestId, 40);
    var clientVersion = parseInt(payload.version, 10);
    if (isNaN(clientVersion)) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Version không hợp lệ'));
    }
    var reason = sanitizeString(payload.reason, 500);
    if (!reason) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Vui lòng nhập lý do từ chối'));
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var updatedRow = null;
    try {
      var found = findRequestById(requestId);
      if (!found) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy giấy phép'));
      }
      var row = found.row;
      var currentVersion = parseInt(row.Version, 10);
      if (isNaN(currentVersion)) currentVersion = 0;
      if (currentVersion !== clientVersion) {
        return jsonResponse(false, null, errorResponse('CONFLICT_VERSION', 'Giấy phép đã được cập nhật bởi người khác, vui lòng tải lại'));
      }
      var status = String(row.Status || '');
      if (REJECTABLE_STATUSES.indexOf(status) < 0) {
        return jsonResponse(false, null, errorResponse('INVALID_TRANSITION', 'Không thể từ chối ở trạng thái hiện tại'));
      }
      if (!requireApprovalStepRole(session, row)) {
        return jsonResponse(false, null, errorResponse('FORBIDDEN', 'Bạn không có quyền từ chối bước này'));
      }

      var sheet = getSheet('Requests');
      updateRowByIndex(sheet, found.rowIndex, {
        Status: 'REJECTED',
        RejectedBy: session.Username,
        RejectReason: reason,
        Version: currentVersion + 1
      });

      writeAuditLog(session.Username, 'REJECT', requestId, 'Từ chối bước ' + status);

      var refreshed = findRequestById(requestId);
      updatedRow = refreshed ? refreshed.row : row;
    } finally {
      lock.releaseLock();
    }

    return jsonResponse(true, { request: requestRowToDTO(updatedRow) });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi từ chối giấy phép'));
  }
}

/**
 * handleListRequests — danh sách giấy phép theo bộ lọc và quyền.
 * @param {Object} session
 * @param {Object} payload {dateFrom?, dateTo?, dept?, status?}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleListRequests(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    payload = payload || {};
    var dateFrom = sanitizeString(payload.dateFrom, 10);
    var dateTo = sanitizeString(payload.dateTo, 10);
    var deptFilter = sanitizeString(payload.dept, 80);
    var statusFilter = sanitizeString(payload.status, 30);

    var role = String(session.Role || '');
    var scoped = (role === 'manager' || role === 'supervisor');
    var deptSet = null;
    var usersMap = loadUsersMap();
    if (scoped) {
      var meRow = usersMap[String(session.Username).toLowerCase()];
      if (!meRow) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy người dùng'));
      }
      deptSet = linkedDeptSet(session.Username, meRow);
    }

    var sheet = getSheet('Requests');
    var rows = sheetToObjects(sheet);
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.RequestId) continue;
      var dto = requestRowToDTO(r);

      if (dateFrom && dto.date < dateFrom) continue;
      if (dateTo && dto.date > dateTo) continue;

      // Supervisor/manager: chỉ thấy giấy gán cho mình hoặc thuộc bộ phận mình được liên kết.
      if (scoped && !approverCanSee(session.Username, deptSet, dto)) continue;
      if (deptFilter && dto.dept.toLowerCase() !== deptFilter.toLowerCase()) continue;

      if (statusFilter && dto.status !== statusFilter) continue;

      out.push(dto);
    }

    out.sort(function (a, b) {
      var ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      var tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    return jsonResponse(true, { requests: out, names: buildApproverNames(out, usersMap) });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy danh sách giấy phép'));
  }
}

/**
 * Đọc file Drive theo id và trả về data URL base64, hoặc null nếu id rỗng.
 * @param {string} fileId
 * @return {string|null}
 */
function fileIdToDataUrl(fileId) {
  if (!fileId) return null;
  try {
    var blob = DriveApp.getFileById(String(fileId)).getBlob();
    var base64 = Utilities.base64Encode(blob.getBytes());
    return 'data:' + blob.getContentType() + ';base64,' + base64;
  } catch (err) {
    return null;
  }
}

/**
 * handleGetRequestPdfData — dữ liệu để render PDF (kèm chữ ký base64).
 * @param {Object} session
 * @param {Object} payload {requestId}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleGetRequestPdfData(session, payload) {
  try {
    if (!session || !session.Username) {
      return jsonResponse(false, null, errorResponse('UNAUTHENTICATED', 'Chưa đăng nhập'));
    }
    payload = payload || {};
    requireFields(payload, ['requestId']);
    var requestId = sanitizeString(payload.requestId, 40);

    var found = findRequestById(requestId);
    if (!found) {
      return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy giấy phép'));
    }
    var row = found.row;
    var dto = requestRowToDTO(row);
    var role = String(session.Role || '');

    var allowed = false;
    if (role === 'hr' || role === 'admin' || role === 'security') {
      allowed = true;
    } else if (role === 'manager' || role === 'supervisor') {
      var userFound = findUserByUsername(session.Username);
      if (userFound && approverCanSee(session.Username, linkedDeptSet(session.Username, userFound.row), dto)) {
        allowed = true;
      }
    }
    if (!allowed) {
      return jsonResponse(false, null, errorResponse('FORBIDDEN', 'Bạn không có quyền xem giấy phép này'));
    }

    var signatures = {
      applicant: fileIdToDataUrl(row.ApplicantSigFileId),
      supervisor: fileIdToDataUrl(row.SupSigFileId),
      manager: fileIdToDataUrl(row.MgrSigFileId),
      hr: fileIdToDataUrl(row.HrSigFileId),
      security: fileIdToDataUrl(row.GuardSigFileId)
    };

    return jsonResponse(true, {
      request: dto,
      signatures: signatures,
      names: buildApproverNames([dto])
    });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy dữ liệu PDF'));
  }
}