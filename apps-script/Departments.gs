/**
 * Departments.gs — Quản lý bộ phận + liên kết người duyệt (chỉ admin).
 * Phụ thuộc Util.gs, Auth.gs, Requests.gs, Users.gs (requireAdminSession).
 *
 * Mô hình liên kết:
 *  - Sheet Departments: Dept | SupervisorUsernames (phân tách dấu phẩy) | ManagerUsername
 *  - Khi admin tạo/sửa/kích hoạt user có role supervisor/manager kèm Dept, user được TỰ ĐỘNG
 *    gắn vào bộ phận đó (syncUserDeptLink) — không cần sửa tay trên Sheet.
 *  - Admin cũng có thể chỉnh trực tiếp danh sách người duyệt từng bộ phận (handleSaveDepartment).
 */

/**
 * Đọc toàn bộ Departments kèm rowIndex.
 * @return {{rows:Object[], sheet:GoogleAppsScript.Spreadsheet.Sheet}}
 */
function readDepartmentRows() {
  var sheet = getSheet('Departments');
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) rows[i]._rowIndex = i + 2;
  return { rows: rows, sheet: sheet };
}

function findDeptIn(rows, dept) {
  var target = String(dept || '').toLowerCase();
  if (!target) return null;
  for (var i = 0; i < rows.length; i++) {
    if (cellToText(rows[i].Dept).toLowerCase() === target) return rows[i];
  }
  return null;
}

/**
 * Đảm bảo bộ phận tồn tại (tạo mới nếu chưa có). Gọi trong script lock.
 * @return {Object} dòng bộ phận
 */
function ensureDepartmentExists(dept) {
  var data = readDepartmentRows();
  var row = findDeptIn(data.rows, dept);
  if (row) return row;
  appendRowObject(data.sheet, { Dept: dept, SupervisorUsernames: '', ManagerUsername: '' });
  return findDeptIn(readDepartmentRows().rows, dept);
}

/**
 * Đồng bộ liên kết bộ phận khi role/Dept của 1 user thay đổi. Gọi trong script lock.
 *  - Bỏ user khỏi danh sách supervisor/manager của mọi bộ phận nếu không còn role đó,
 *    hoặc khỏi bộ phận cũ nếu đổi bộ phận.
 *  - Thêm user vào bộ phận mới theo role (manager chỉ ghi đè khi bộ phận chưa có manager hợp lệ).
 *  - Bộ phận chưa có trong sheet sẽ được tạo tự động.
 */
function syncUserDeptLink(username, newRole, newDept, oldRole, oldDept) {
  var uname = String(username || '');
  if (!uname) return;
  var unameLower = uname.toLowerCase();
  var newDeptL = String(newDept || '').toLowerCase();
  var oldDeptL = String(oldDept || '').toLowerCase();

  if (newDept) ensureDepartmentExists(newDept);

  var data = readDepartmentRows();
  var usersMap = loadUsersMap();
  for (var i = 0; i < data.rows.length; i++) {
    var d = data.rows[i];
    var dName = cellToText(d.Dept);
    var dL = dName.toLowerCase();
    var sups = splitUsernames(d.SupervisorUsernames);
    var mgr = cellToText(d.ManagerUsername);
    var changed = false;

    // --- Supervisor ---
    var idx = -1;
    for (var s = 0; s < sups.length; s++) {
      if (sups[s].toLowerCase() === unameLower) { idx = s; break; }
    }
    var shouldRemoveSup = idx >= 0 && (newRole !== 'supervisor' || (oldRole === 'supervisor' && dL === oldDeptL && dL !== newDeptL));
    if (shouldRemoveSup) { sups.splice(idx, 1); changed = true; idx = -1; }
    if (newRole === 'supervisor' && dL === newDeptL && idx < 0) { sups.push(uname); changed = true; }

    // --- Manager ---
    var isMgrHere = mgr.toLowerCase() === unameLower;
    if (isMgrHere && (newRole !== 'manager' || (oldRole === 'manager' && dL === oldDeptL && dL !== newDeptL))) {
      mgr = ''; changed = true; isMgrHere = false;
    }
    if (newRole === 'manager' && dL === newDeptL && !isMgrHere) {
      var cur = mgr ? usersMap[mgr.toLowerCase()] : null;
      var curValid = cur && String(cur.Status) === 'ACTIVE' && String(cur.Role) === 'manager';
      if (!curValid) { mgr = uname; changed = true; }
    }

    if (changed) {
      updateRowByIndex(data.sheet, d._rowIndex, {
        SupervisorUsernames: sups.join(','),
        ManagerUsername: mgr
      });
    }
  }
  invalidateDirectoryCache();
}

/**
 * handleListDepartmentsAdmin — danh sách bộ phận dạng thô (kể cả người duyệt đã khoá),
 * kèm số nhân viên (user) thuộc bộ phận.
 */
function handleListDepartmentsAdmin(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;
    var rows = sheetToObjects(getSheet('Departments'));
    var users = sheetToObjects(getSheet('Users'));
    var memberCount = {};
    for (var u = 0; u < users.length; u++) {
      var ud = cellToText(users[u].Dept).toLowerCase();
      if (ud) memberCount[ud] = (memberCount[ud] || 0) + 1;
    }
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      if (!d || !d.Dept) continue;
      var name = cellToText(d.Dept);
      out.push({
        dept: name,
        supervisorUsernames: splitUsernames(d.SupervisorUsernames),
        managerUsername: cellToText(d.ManagerUsername),
        memberCount: memberCount[name.toLowerCase()] || 0
      });
    }
    out.sort(function (a, b) { return a.dept.localeCompare(b.dept); });
    return jsonResponse(true, { departments: out });
  } catch (err) {
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lấy danh sách bộ phận'));
  }
}

/**
 * handleSaveDepartment — tạo/sửa bộ phận.
 * payload {dept, originalDept?, supervisorUsernames: string[], managerUsername}
 * Đổi tên bộ phận -> cập nhật Users.Dept tương ứng (giấy phép cũ giữ nguyên tên cũ).
 */
function handleSaveDepartment(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;
    payload = payload || {};
    var dept = sanitizeString(payload.dept, 80);
    var originalDept = sanitizeString(payload.originalDept, 80);
    if (!dept) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Vui lòng nhập tên bộ phận'));
    }
    var supList = Array.isArray(payload.supervisorUsernames) ? payload.supervisorUsernames : [];
    var managerUsername = sanitizeString(payload.managerUsername, 60);

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var usersMap = loadUsersMap();
      var cleanSups = [];
      for (var i = 0; i < supList.length; i++) {
        var su = sanitizeString(supList[i], 60);
        if (!su) continue;
        var srow = usersMap[su.toLowerCase()];
        if (!srow) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Không tìm thấy người dùng: ' + su));
        }
        if (String(srow.Role) !== 'supervisor' && String(srow.Role) !== 'admin') {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', su + ' chưa có vai trò Giám sát (supervisor)'));
        }
        var canon = cellToText(srow.Username);
        if (cleanSups.indexOf(canon) < 0) cleanSups.push(canon);
      }
      var cleanMgr = '';
      if (managerUsername) {
        var mrow = usersMap[managerUsername.toLowerCase()];
        if (!mrow) {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Không tìm thấy người dùng: ' + managerUsername));
        }
        if (String(mrow.Role) !== 'manager' && String(mrow.Role) !== 'admin') {
          return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', managerUsername + ' chưa có vai trò Trưởng bộ phận (manager)'));
        }
        cleanMgr = cellToText(mrow.Username);
      }

      var data = readDepartmentRows();
      // Không có originalDept = tạo mới -> trùng tên là lỗi; có originalDept = sửa bộ phận đó.
      var existing = originalDept ? findDeptIn(data.rows, originalDept) : null;
      if (originalDept && !existing) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy bộ phận ' + originalDept));
      }
      var clash = findDeptIn(data.rows, dept);
      if (clash && (!existing || clash._rowIndex !== existing._rowIndex)) {
        return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Bộ phận "' + dept + '" đã tồn tại'));
      }

      var record = { Dept: dept, SupervisorUsernames: cleanSups.join(','), ManagerUsername: cleanMgr };
      if (existing) {
        updateRowByIndex(data.sheet, existing._rowIndex, record);
      } else {
        appendRowObject(data.sheet, record);
      }

      // Đổi tên -> cập nhật Dept của các user thuộc bộ phận cũ.
      var oldName = existing ? cellToText(existing.Dept) : '';
      if (oldName && oldName !== dept) {
        var usersSheet = getSheet('Users');
        var users = sheetToObjects(usersSheet);
        for (var k = 0; k < users.length; k++) {
          if (cellToText(users[k].Dept).toLowerCase() === oldName.toLowerCase()) {
            updateRowByIndex(usersSheet, k + 2, { Dept: dept });
          }
        }
      }

      writeAuditLog(session.Username, 'SAVE_DEPARTMENT', dept,
        'Giám sát: ' + (cleanSups.join(',') || '-') + ' | Trưởng BP: ' + (cleanMgr || '-'));
    } finally {
      lock.releaseLock();
    }
    invalidateDirectoryCache();
    return jsonResponse(true, {});
  } catch (err) {
    if (err && err.code === 'VALIDATION_ERROR') {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', err.message));
    }
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi lưu bộ phận'));
  }
}

/**
 * handleDeleteDepartment — xoá bộ phận (không xoá user/giấy phép; user giữ nguyên tên bộ phận).
 * payload {dept}
 */
function handleDeleteDepartment(session, payload) {
  try {
    var denied = requireAdminSession(session);
    if (denied) return denied;
    payload = payload || {};
    var dept = sanitizeString(payload.dept, 80);
    if (!dept) {
      return jsonResponse(false, null, errorResponse('VALIDATION_ERROR', 'Thiếu tên bộ phận'));
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var data = readDepartmentRows();
      var row = findDeptIn(data.rows, dept);
      if (!row) {
        return jsonResponse(false, null, errorResponse('NOT_FOUND', 'Không tìm thấy bộ phận'));
      }
      data.sheet.deleteRow(row._rowIndex);
      writeAuditLog(session.Username, 'DELETE_DEPARTMENT', dept, 'Xoá bộ phận');
    } finally {
      lock.releaseLock();
    }
    invalidateDirectoryCache();
    return jsonResponse(true, {});
  } catch (err) {
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống khi xoá bộ phận'));
  }
}
