/**
 * Security.gs — Nghiệp vụ bảo vệ cổng (Wahl GatePass).
 * Phụ thuộc Util.gs, Auth.gs, Requests.gs. Không định nghĩa lại helper đã có.
 */

/**
 * handleListToday — PUBLIC (bảo vệ không cần tài khoản): danh sách giấy phép theo ngày
 * (mặc định hôm nay, Asia/Ho_Chi_Minh) để bảo vệ xem AI ĐÃ ĐƯỢC DUYỆT CHƯA.
 * Trả về DTO rút gọn: KHÔNG có lý do/chi tiết lý do/lý do từ chối/chữ ký (dữ liệu nhạy cảm).
 * Sắp xếp theo ComeOutPlanned tăng dần.
 * @param {Object} payload {date?: 'YYYY-MM-DD'}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleListToday(payload) {
  try {
    payload = payload || {};
    var day = sanitizeString(payload.date, 10);
    if (!day || !isValidDateStr(day)) day = todayStr();

    var sheet = getSheet('Requests');
    var rows = sheetToObjects(sheet);
    var full = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.RequestId) continue;
      var dto = requestRowToDTO(r);
      if (dto.date !== day) continue;
      full.push(dto);
    }
    full.sort(function (a, b) {
      var ta = a.comeOutPlanned || '99:99';
      var tb = b.comeOutPlanned || '99:99';
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });
    var names = buildApproverNames(full);
    var out = [];
    for (var k = 0; k < full.length; k++) {
      var d = full[k];
      out.push({
        requestId: d.requestId,
        date: d.date,
        fullName: d.fullName,
        emplId: d.emplId,
        dept: d.dept,
        comeOutPlanned: d.comeOutPlanned,
        comeInPlanned: d.comeInPlanned,
        status: d.status,
        supId: d.supId, supAt: d.supAt,
        mgrId: d.mgrId, mgrAt: d.mgrAt,
        hrId: d.hrId, hrAt: d.hrAt,
        rejectedBy: d.rejectedBy,
        guardOutAt: d.guardOutAt,
        guardInAt: d.guardInAt
      });
    }
    return jsonResponse(true, { date: day, requests: out, names: names, serverTime: nowIso() });
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy danh sách giấy phép hôm nay'));
  }
}

/**
 * handleRecordOut — bảo vệ xác nhận cho nhân viên ra cổng.
 * Điều kiện: Status = 'APPROVED'.
 * @param {Object} session
 * @param {Object} payload {requestId, version}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleRecordOut(session, payload) {
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
      if (String(row.Status || '') !== 'APPROVED') {
        return jsonResponse(false, null, errorResponse('INVALID_TRANSITION', 'Giấy phép chưa được duyệt đủ hoặc đã cho ra rồi'));
      }

      // Chữ ký bảo vệ: dùng nếu có, không bắt buộc.
      var guardSigFileId = String(row.GuardSigFileId || '');
      var userFound = findUserByUsername(session.Username);
      if (userFound && userFound.row && userFound.row.SigFileId) {
        guardSigFileId = String(userFound.row.SigFileId);
      }

      var sheet = getSheet('Requests');
      updateRowByIndex(sheet, found.rowIndex, {
        Status: 'OUT',
        GuardOutBy: session.Username,
        GuardOutAt: nowIso(),
        GuardSigFileId: guardSigFileId,
        Version: currentVersion + 1
      });

      writeAuditLog(session.Username, 'RECORD_OUT', requestId, 'Bảo vệ ' + session.Username + ' cho ra');

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
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi ghi nhận cho ra'));
  }
}

/**
 * handleRecordIn — bảo vệ xác nhận cho nhân viên vào cổng.
 * Điều kiện: Status = 'OUT'.
 * @param {Object} session
 * @param {Object} payload {requestId, version}
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleRecordIn(session, payload) {
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
      if (String(row.Status || '') !== 'OUT') {
        return jsonResponse(false, null, errorResponse('INVALID_TRANSITION', 'Giấy phép chưa được cho ra hoặc đã hoàn tất'));
      }

      // Chữ ký bảo vệ: dùng nếu có, không bắt buộc.
      var guardSigFileId = String(row.GuardSigFileId || '');
      var userFound = findUserByUsername(session.Username);
      if (userFound && userFound.row && userFound.row.SigFileId) {
        guardSigFileId = String(userFound.row.SigFileId);
      }

      var sheet = getSheet('Requests');
      updateRowByIndex(sheet, found.rowIndex, {
        Status: 'COMPLETED',
        GuardInBy: session.Username,
        GuardInAt: nowIso(),
        GuardSigFileId: guardSigFileId,
        Version: currentVersion + 1
      });

      writeAuditLog(session.Username, 'RECORD_IN', requestId, 'Bảo vệ ' + session.Username + ' cho vào');

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
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi ghi nhận cho vào'));
  }
}