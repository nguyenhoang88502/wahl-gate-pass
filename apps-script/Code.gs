/**
 * Code.gs — Router duy nhất của Web App Wahl GatePass.
 *
 * Nhiệm vụ:
 *  - doGet(e): health check đơn giản.
 *  - doPost(e): parse JSON body, xác thực token (nếu cần), kiểm tra role,
 *    rồi dispatch tới handler tương ứng đã định nghĩa trong Auth.gs / Users.gs /
 *    Requests.gs / Security.gs.
 *
 * KHÔNG định nghĩa lại bất kỳ handle* hay helper nào của Util.gs.
 * Mọi handler đã tự gọi jsonResponse() — Code.gs chỉ return nguyên vẹn.
 */

/**
 * Health check — dùng để kiểm tra Web App còn sống.
 * @param {Object} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Cấu hình phân quyền theo action (SPEC §4).
 *  - public: không cần token.
 *  - authenticated: cần token hợp lệ, không giới hạn role.
 *  - roles: cần token hợp lệ + role nằm trong danh sách.
 */
var ACTION_CONFIG = {
  // --- PUBLIC ---
  getDepartments:      { type: 'public' },
  getApproverOptions:  { type: 'public' },
  submitRequest:       { type: 'public' },
  getRequestStatus:    { type: 'public' },
  register:            { type: 'public' },
  login:               { type: 'public' },
  // Bảo vệ không cần tài khoản: dashboard chỉ đọc, dữ liệu rút gọn (không lý do/chữ ký).
  listToday:           { type: 'public' },

  // --- AUTHENTICATED (không giới hạn role) ---
  logout:              { type: 'authenticated' },
  me:                  { type: 'authenticated' },
  changePassword:      { type: 'authenticated' },
  uploadMySignature:   { type: 'authenticated' },
  getMySignature:      { type: 'authenticated' },

  // --- ROLE-BASED ---
  listRequests:        { type: 'roles', roles: ['hr', 'admin', 'manager', 'supervisor'] },
  approve:             { type: 'roles', roles: ['hr', 'admin', 'manager', 'supervisor'] },
  reject:              { type: 'roles', roles: ['hr', 'admin', 'manager', 'supervisor'] },
  // getRequestPdfData: bảo vệ cũng cần xem trước khi cho ra/vào.
  getRequestPdfData:   { type: 'roles', roles: ['hr', 'admin', 'manager', 'supervisor', 'security'] },

  listUsers:           { type: 'roles', roles: ['admin'] },
  listPendingUsers:    { type: 'roles', roles: ['admin'] },
  activateUser:        { type: 'roles', roles: ['admin'] },
  rejectUser:          { type: 'roles', roles: ['admin'] },
  createUser:          { type: 'roles', roles: ['admin'] },
  updateUser:          { type: 'roles', roles: ['admin'] },
  resetPassword:       { type: 'roles', roles: ['admin'] },
  uploadUserSignature: { type: 'roles', roles: ['admin'] },
  setConfig:           { type: 'roles', roles: ['admin'] },
  getConfig:           { type: 'roles', roles: ['admin'] },
  listAuditLog:        { type: 'roles', roles: ['admin'] },
  listDepartmentsAdmin:{ type: 'roles', roles: ['admin'] },
  saveDepartment:      { type: 'roles', roles: ['admin'] },
  deleteDepartment:    { type: 'roles', roles: ['admin'] },

  // Ghi nhận ra/vào thực tế: vẫn cần tài khoản nội bộ (giữ toàn vẹn dữ liệu);
  // trang bảo vệ công khai chỉ hiển thị, không gọi 2 action này.
  recordOut:           { type: 'roles', roles: ['security', 'hr', 'admin'] },
  recordIn:            { type: 'roles', roles: ['security', 'hr', 'admin'] }
};

/**
 * Ánh xạ tên action -> tên hàm handler.
 * Tên hàm phải khớp chính xác với các file Auth.gs / Users.gs / Requests.gs / Security.gs.
 */
var HANDLER_MAP = {
  // Public
  getDepartments:      handleGetDepartments,
  getApproverOptions:  handleGetApproverOptions,
  submitRequest:       handleSubmitRequest,
  getRequestStatus:    handleGetRequestStatus,
  register:            handleRegister,
  login:               handleLogin,
  listToday:           handleListToday,

  // Authenticated
  logout:              handleLogout,
  me:                  handleMe,
  changePassword:      handleChangePassword,
  uploadMySignature:   handleUploadMySignature,
  getMySignature:      handleGetMySignature,

  // Role-based — Requests
  listRequests:        handleListRequests,
  approve:             handleApprove,
  reject:              handleReject,
  getRequestPdfData:   handleGetRequestPdfData,

  // Role-based — Users (admin)
  listUsers:           handleListUsers,
  listPendingUsers:    handleListPendingUsers,
  activateUser:        handleActivateUser,
  rejectUser:          handleRejectUser,
  createUser:          handleCreateUser,
  updateUser:          handleUpdateUser,
  resetPassword:       handleResetPassword,
  uploadUserSignature: handleUploadUserSignature,
  setConfig:           handleSetConfig,
  getConfig:           handleGetConfig,
  listAuditLog:        handleListAuditLog,

  // Role-based — Departments (admin)
  listDepartmentsAdmin: handleListDepartmentsAdmin,
  saveDepartment:      handleSaveDepartment,
  deleteDepartment:    handleDeleteDepartment,

  // Role-based — Security
  recordOut:           handleRecordOut,
  recordIn:            handleRecordIn
};

/**
 * Các action mà handler chỉ nhận 1 tham số (payload) — không cần session.
 * Dùng để gọi đúng chữ ký hàm.
 */
var PUBLIC_ACTIONS = [
  'getDepartments',
  'getApproverOptions',
  'submitRequest',
  'getRequestStatus',
  'register',
  'login',
  'listToday'
];

/**
 * Các action mà handler chỉ nhận 1 tham số (session) — không cần payload.
 * (Hiện tại chỉ có 'me'.)
 */
var SESSION_ONLY_ACTIONS = ['me'];

/**
 * doPost — điểm vào duy nhất cho mọi request API.
 * @param {Object} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  try {
    // 1) Parse body JSON.
    var body = null;
    try {
      var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
      body = JSON.parse(raw);
    } catch (parseErr) {
      return jsonResponse(false, null, errorResponse('BAD_REQUEST', 'Dữ liệu gửi lên không hợp lệ'));
    }

    if (!body || typeof body !== 'object') {
      return jsonResponse(false, null, errorResponse('BAD_REQUEST', 'Dữ liệu gửi lên không hợp lệ'));
    }

    var action = body.action ? String(body.action) : '';
    var token = body.token ? String(body.token) : '';
    var payload = (body.payload && typeof body.payload === 'object') ? body.payload : {};

    // 2) Action phải tồn tại.
    if (!action || !Object.prototype.hasOwnProperty.call(HANDLER_MAP, action)) {
      return jsonResponse(false, null, errorResponse('UNKNOWN_ACTION', 'Hành động không tồn tại'));
    }

    var handler = HANDLER_MAP[action];
    var config = ACTION_CONFIG[action] || { type: 'public' };

    // 3) PUBLIC — gọi handler(payload).
    if (config.type === 'public') {
      return handler(payload);
    }

    // 4) Cần token hợp lệ.
    var authResult = validateSessionToken(token);
    if (!authResult || !authResult.valid || !authResult.session) {
      return jsonResponse(false, null, errorResponse('SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại'));
    }

    // combinedSession: gộp Username + Role từ Sessions row để truyền vào handler.
    var sessionRow = authResult.session;
    var combinedSession = {
      Token: sessionRow.Token || token,
      Username: sessionRow.Username || '',
      Role: sessionRow.Role || '',
      ExpiresAt: sessionRow.ExpiresAt || ''
    };

    // 5) AUTHENTICATED — không giới hạn role.
    if (config.type === 'authenticated') {
      if (SESSION_ONLY_ACTIONS.indexOf(action) >= 0) {
        return handler(combinedSession);
      }
      return handler(combinedSession, payload);
    }

    // 6) ROLE-BASED — kiểm tra role.
    if (config.type === 'roles') {
      var allowed = config.roles || [];
      if (allowed.indexOf(combinedSession.Role) < 0) {
        return jsonResponse(false, null, errorResponse('FORBIDDEN', 'Bạn không có quyền thực hiện hành động này'));
      }
      return handler(combinedSession, payload);
    }

    // Fallback — không nên xảy ra.
    return jsonResponse(false, null, errorResponse('UNKNOWN_ACTION', 'Hành động không tồn tại'));
  } catch (err) {
    return jsonResponse(false, null, errorResponse('INTERNAL_ERROR', 'Lỗi hệ thống'));
  }
}