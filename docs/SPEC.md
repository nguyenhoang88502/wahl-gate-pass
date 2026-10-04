# SPEC.md — Giấy phép ra/vào cổng (Wahl Vietnam Gate Pass)

Đây là hợp đồng DUY NHẤT cho toàn bộ dự án. Mọi file (frontend, Apps Script, tests) phải khớp
100% với tên action, tên field, tên cột Sheet, mã trạng thái trong tài liệu này. Khi sinh code
bằng DeepSeek, LUÔN đính kèm file này làm context. Khi Claude review, đối chiếu từng file với
tài liệu này trước tiên.

Biểu mẫu gốc tham chiếu: `HR-F-GEN-0057-01 Giấy phép ra vào cổng.pdf` (hiệu lực 01/10/2022).

---

## 1. Cấu trúc file dự án

```
Wahl GatePass/
├── index.html                  # Trang nhân viên: gửi giấy phép + tra cứu trạng thái
├── security.html                # Dashboard bảo vệ — CÔNG KHAI, không cần đăng nhập, chỉ xem
├── hr.html                      # Đăng nhập/đăng ký + duyệt + quản trị (bộ phận, người dùng, cấu hình, nhật ký)
├── assets/
│   ├── css/style.css
│   ├── js/
│   │   ├── config.js             # API_URL hard-code
│   │   ├── api.js                 # gọi API thật hoặc mock (localStorage), cache, dọn phiên
│   │   ├── ui.js                  # tiện ích UI dùng chung: toast, hộp thoại, nhãn, bước duyệt, nhắc trường trống
│   │   ├── page-index.js / page-security.js / page-hr.js   # logic từng trang
│   │   ├── pdf.js                 # render PDF dùng chung 3 trang
│   │   └── signature-pad.js       # canvas ký tên dùng chung
│   └── img/
│       ├── logo-placeholder.png      # logo nhỏ dùng trong header 3 trang web
│       └── gatepass-form-bg.png      # ảnh nền form gốc HR-F-GEN-0057-01, dùng trong PDF xuất ra
├── apps-script/
│   ├── appsscript.json
│   ├── Code.gs                   # doPost router + doGet
│   ├── Util.gs                   # helpers: response, hash, id, time, sanitize
│   ├── Auth.gs                   # login/logout/me/changePassword/register/token
│   ├── Users.gs                  # user CRUD, kích hoạt, chữ ký
│   ├── Requests.gs                # submit/list/approve/reject/status/pdf-data
│   ├── Departments.gs             # quản lý bộ phận + tự liên kết giám sát/trưởng BP
│   ├── Security.gs                # listToday (public) / recordOut / recordIn
│   └── Setup.gs                   # setup() khởi tạo Sheet/Drive/admin
├── docs/SPEC.md
├── tools/
│   ├── deepseek_worker.mjs
│   └── .env.local                 # KHÔNG commit (trong .gitignore)
├── tests/
│   └── *.test.mjs
├── .gitignore
└── README.md
```

Mọi đường dẫn asset trong HTML dùng dạng tương đối: `assets/css/style.css`, `assets/js/api.js`
(không bắt đầu bằng `/`).

---

## 2. Google Sheet — cấu trúc dữ liệu (database)

Dòng 1 là header. Hàm `setup()` trong `Setup.gs` tự tạo các sheet này nếu chưa tồn tại, theo
đúng thứ tự cột dưới đây (thứ tự cột là hợp đồng — không đổi).

**Giữ đúng kiểu dữ liệu:** Google Sheets tự "đoán kiểu" khi ghi chuỗi (`08:30` → Time,
`2026-10-02` → Date, `00123` → số 123, `=...` → công thức). Mọi lần ghi đi qua
`protectCellValue()` (thêm dấu `'` đầu để Sheets giữ dạng text — đồng thời chặn formula injection),
và mọi lần đọc ra DTO đi qua `cellToText()` để chuẩn hoá các ô cũ đã bị đổi kiểu.

**Không có trường bắt buộc** cho giấy phép: mọi trường thông tin (họ tên, mã NV, bộ phận, ngày,
giờ, lý do, người duyệt, chữ ký) đều có thể để trống — frontend chỉ tô đỏ để nhắc. Server chỉ từ
chối khi dữ liệu CÓ nhập nhưng sai định dạng (giờ, ngày, enum lý do).

### 2.1 Sheet `Requests`

| # | Cột | Kiểu | Ghi chú |
|---|-----|------|---------|
| 1 | RequestId | string | `GP-YYYYMMDD-NNN` |
| 2 | CreatedAt | ISO string | thời điểm tạo (server) |
| 3 | Date | `YYYY-MM-DD` | ngày xin phép |
| 4 | FullName | string | |
| 5 | EmplId | string | mã nhân viên |
| 6 | Dept | string | khớp `Departments.Dept` |
| 7 | ComeOutPlanned | `HH:mm` | giờ ra dự kiến |
| 8 | ComeInPlanned | `HH:mm` | giờ vào dự kiến (có thể rỗng nếu không quay lại) |
| 9 | Reason | enum | `PERSONAL`\|`ANNUAL_LEAVE`\|`MATERNITY`\|`SICK`\|`JOB_ACCIDENT`\|`OTHER` |
| 10 | ReasonDetail | string | dùng khi Reason=`OTHER` (không bắt buộc) |
| 11 | Status | enum | xem §3 |
| 12 | SupId | string | username supervisor được chọn (có thể rỗng) |
| 13 | MgrId | string | username dept manager |
| 14 | HrId | string | username HR đã duyệt (điền khi duyệt) |
| 15 | ApplicantSigFileId | Drive fileId | chữ ký người xin phép (lưu lúc submit) |
| 16 | SupSigFileId | Drive fileId | chữ ký supervisor lúc duyệt |
| 17 | MgrSigFileId | Drive fileId | chữ ký manager lúc duyệt |
| 18 | HrSigFileId | Drive fileId | chữ ký HR lúc duyệt |
| 19 | SupAt | ISO string | thời điểm supervisor duyệt |
| 20 | MgrAt | ISO string | thời điểm manager duyệt |
| 21 | HrAt | ISO string | thời điểm HR duyệt |
| 22 | RejectedBy | string | username người từ chối (nếu có) |
| 23 | RejectReason | string | lý do từ chối |
| 24 | GuardOutBy | string | username bảo vệ cho ra |
| 25 | GuardOutAt | ISO string | giờ thực tế ra |
| 26 | GuardInBy | string | username bảo vệ cho vào |
| 27 | GuardInAt | ISO string | giờ thực tế vào |
| 28 | GuardSigFileId | Drive fileId | chữ ký bảo vệ (dùng chung cho cả 2 lượt ra/vào, lấy chữ ký mới nhất) |
| 29 | Version | number | tăng dần mỗi lần ghi, dùng chống ghi đè (optimistic lock) |

### 2.2 Sheet `Users`

| # | Cột | Kiểu | Ghi chú |
|---|-----|------|---------|
| 1 | Username | string | duy nhất, không phân biệt hoa thường |
| 2 | FullName | string | |
| 3 | EmplId | string | tuỳ chọn; nếu có thì duy nhất (mỗi mã NV chỉ gắn 1 tài khoản) |
| 4 | Dept | string | |
| 5 | Role | enum rỗng được | ``\|`admin`\|`hr`\|`manager`\|`supervisor`\|`security` |
| 6 | Email | string | |
| 7 | PasswordHash | string | SHA-256 × ≥1000 vòng + salt, KHÔNG BAO GIỜ trả ra client |
| 8 | Salt | string | UUID ngẫu nhiên riêng từng user, KHÔNG BAO GIỜ trả ra client |
| 9 | MustChangePw | boolean | true sau khi admin reset mật khẩu |
| 10 | Status | enum | `PENDING`\|`ACTIVE`\|`LOCKED`\|`REJECTED` |
| 11 | FailedCount | number | số lần đăng nhập sai liên tiếp |
| 12 | LockedUntil | ISO string | rỗng nếu không khóa |
| 13 | SigFileId | Drive fileId | chữ ký số, rỗng nếu chưa upload |
| 14 | CreatedAt | ISO string | |
| 15 | ApprovedBy | string | admin đã kích hoạt |
| 16 | ApprovedAt | ISO string | |

### 2.3 Sheet `Sessions`

| # | Cột | Ghi chú |
|---|-----|---------|
| 1 | Token | UUID ngẫu nhiên |
| 2 | Username | |
| 3 | Role | snapshot role lúc đăng nhập (chỉ để tham khảo — quyền luôn tính theo `Users.Role` hiện tại) |
| 4 | ExpiresAt | ISO string; hr/admin/manager/supervisor = +8h, security = +12h |

Dọn phiên: mỗi lần `login` gọi `purgeSessions()` — xoá phiên hết hạn và chỉ giữ tối đa 3 phiên
mới nhất / user, nên sheet luôn nhỏ. Kết quả xác thực token được cache (CacheService) 120 giây;
khoá / đổi role / từ chối user xoá cache phiên của user đó ngay (`dropUserSessionCache`). User
không còn `ACTIVE` thì mọi phiên hết hiệu lực ngay.

### 2.4 Sheet `Departments`

| # | Cột | Ghi chú |
|---|-----|---------|
| 1 | Dept | tên bộ phận, duy nhất |
| 2 | SupervisorUsernames | chuỗi username cách nhau bởi dấu phẩy, có thể rỗng |
| 3 | ManagerUsername | username trưởng bộ phận (1 người) |

**Liên kết người duyệt — mọi thứ quản lý từ trang admin, không cần sửa tay trên Sheet:**
- Tab "Bộ phận & người duyệt" (`listDepartmentsAdmin`/`saveDepartment`/`deleteDepartment`): tạo,
  đổi tên (đổi tên cập nhật luôn `Users.Dept`), xoá bộ phận; chọn nhiều Giám sát (chỉ tài khoản role
  `supervisor`/`admin`) và 1 Trưởng BP (role `manager`/`admin`).
- Tự liên kết (`syncUserDeptLink`): khi admin tạo / sửa / kích hoạt user có role `supervisor` hoặc
  `manager` kèm `Dept`, user tự được thêm vào bộ phận đó (bộ phận chưa có thì tự tạo). Đổi role /
  đổi bộ phận thì gỡ khỏi liên kết cũ. Trưởng BP chỉ tự ghi đè khi bộ phận chưa có trưởng BP hợp lệ.
- `getDepartments` (public) chỉ trả người duyệt đang `ACTIVE` và đúng role; kết quả cache 5 phút
  (CacheService), xoá cache sau mọi thay đổi Users/Departments.

### 2.5 Sheet `Config`

| # | Cột | Ghi chú |
|---|-----|---------|
| 1 | Key | |
| 2 | Value | |

Key mặc định do `setup()` tạo:
- `MAX_REQUESTS_PER_EMPL_PER_DAY` = `5`
- `MAX_REGISTER_PER_DAY` = `20`
- `MAX_PENDING_USERS` = `50`
- `EMAIL_NOTIFICATIONS_ENABLED` = `false`

### 2.6 Sheet `AuditLog`

| # | Cột | Ghi chú |
|---|-----|---------|
| 1 | Time | ISO string |
| 2 | Actor | username hoặc `SYSTEM` |
| 3 | Action | tên action |
| 4 | TargetId | RequestId/Username liên quan |
| 5 | Detail | chuỗi mô tả ngắn, KHÔNG chứa mật khẩu/hash |

### 2.7 Script Properties (PropertiesService)

- `SIGNATURES_FOLDER_ID` — id thư mục Drive lưu ảnh chữ ký (tạo bởi `setup()`)
- `ADMIN_INITIAL_PASSWORD` — mật khẩu tạm cho admin đầu tiên, đọc 1 lần trong `setup()`

---

## 3. State machine (Requests.Status)

```
PENDING_SUP → PENDING_MGR → PENDING_HR → APPROVED → OUT → COMPLETED
     │              │            │
     └──────────────┴────────────┴──→ REJECTED (kèm RejectedBy + RejectReason, dừng hẳn)
```

Quy tắc:
- Bước không có người duyệt thì bỏ qua: không có `SupId` → bắt đầu ở `PENDING_MGR`; không có cả
  `MgrId` → bắt đầu ở `PENDING_HR`; giám sát duyệt mà không có `MgrId` → chuyển thẳng `PENDING_HR`.
- `SupId`/`MgrId` gửi lên phải là tài khoản `ACTIVE` đúng role (`supervisor`/`manager`, hoặc
  `admin`); nếu không, server bỏ trống bước đó (tránh giấy phép bị "kẹt" ở người không có quyền).
- Chuyển `APPROVED → OUT` / `OUT → COMPLETED` chỉ do `recordOut` / `recordIn` (role `security`,
  `hr`, `admin`). Trang bảo vệ công khai KHÔNG gọi 2 action này (chỉ hiển thị); giờ ra/vào thực tế
  bảo vệ ghi tay trên giấy in nếu cần.
- Nếu giấy có lý do không quay lại trong ngày (ví dụ Reason=`SICK` không có `ComeInPlanned`),
  HR/admin có thể đóng trực tiếp bằng action `approve` ở bước HR chuyển thẳng trạng thái cuối
  cùng — KHÔNG, giữ nguyên quy tắc đơn giản: COMPLETED chỉ được set bởi `recordIn`. Nếu nhân
  viên không quay lại trong ngày, request ở trạng thái `OUT` vĩnh viễn cho đến khi bảo vệ xác
  nhận vào hoặc admin chỉnh tay trên Sheet — không có action tự động đóng cuối ngày trong v1.
- `REJECTED` có thể xảy ra ở bất kỳ bước nào trước `APPROVED` (từ `PENDING_SUP`, `PENDING_MGR`,
  hoặc `PENDING_HR`), bởi đúng role của bước đó (hoặc `admin`/`hr` có quyền từ chối ở mọi bước
  đang chờ HR trở về trước — xem bảng role ở §4).
- Server CHỈ chấp nhận request chuyển đúng 1 bước kế tiếp trong state machine ở trên; mọi
  chuyển trạng thái khác (ví dụ APPROVED → PENDING_MGR, hoặc duyệt khi đã REJECTED) phải bị từ
  chối với lỗi `INVALID_TRANSITION`.

---

## 4. Vai trò & quyền theo action

| Action | Role được gọi | Kiểm tra thêm |
|---|---|---|
| getDepartments | public | — |
| getApproverOptions | public | trả về supervisor/manager theo Dept, chỉ `{username, fullName}` |
| submitRequest | public | honeypot rỗng, rate-limit theo EmplId/ngày (giấy không ghi mã NV gộp 1 nhóm, hạn mức ×10); không trường bắt buộc |
| getRequestStatus | public | phải khớp RequestId **và** EmplId (không phân biệt hoa thường) |
| register | public | honeypot rỗng, rate-limit đăng ký/ngày, tối đa 50 PENDING; chỉ cần username + mật khẩu |
| login | public | dọn phiên hết hạn |
| listToday | public | dashboard bảo vệ: DTO rút gọn, KHÔNG có lý do / chi tiết lý do / lý do từ chối / chữ ký |
| logout | đã đăng nhập | — |
| me | đã đăng nhập | — |
| changePassword | đã đăng nhập | cần mật khẩu cũ đúng |
| uploadMySignature | đã đăng nhập | ≤1MB, PNG/JPEG |
| getMySignature | đã đăng nhập | chữ ký của chính mình (data URL) |
| listRequests | hr, admin, manager, supervisor | manager/supervisor thấy request gán đích danh cho mình (`SupId`/`MgrId`) hoặc thuộc bộ phận mình được liên kết (`Users.Dept` + mọi bộ phận có tên mình trong `Departments`); hr/admin thấy toàn bộ |
| approve | hr, admin, manager, supervisor | chỉ được duyệt đúng bước ứng với role: supervisor duyệt khi `Status=PENDING_SUP` và mình nằm trong `SupId` của request; manager duyệt khi `Status=PENDING_MGR` và cùng `Dept`; hr/admin duyệt khi `Status=PENDING_HR`; admin được override duyệt bất kỳ bước nào (dùng cho xử lý sự cố, vẫn ghi AuditLog) |
| reject | hr, admin, manager, supervisor | cùng điều kiện bước như approve; bắt buộc `RejectReason` không rỗng |
| getRequestPdfData | hr, admin, manager, supervisor, security (chỉ request liên quan vai trò bảo vệ), applicant qua `getRequestStatus` dùng endpoint public riêng | trả chữ ký dạng base64 data URL |
| listUsers | admin | — |
| listPendingUsers | admin | Status=PENDING |
| activateUser | admin | server set Role (+ Dept nếu gửi) theo payload, Status=ACTIVE, tự liên kết bộ phận |
| rejectUser | admin | Status=REJECTED |
| createUser | admin | chỉ cần username; tự liên kết bộ phận; mật khẩu tạm do hệ thống sinh trả về 1 lần |
| updateUser | admin | các trường thông tin có thể để trống; không tự khoá / tự gỡ role của chính mình; tự liên kết lại bộ phận |
| resetPassword | admin | set MustChangePw=true; mật khẩu tạm do hệ thống sinh trả về 1 lần |
| uploadUserSignature | admin | cho user bất kỳ |
| setConfig / getConfig | admin | — |
| listAuditLog | admin | — |
| listDepartmentsAdmin / saveDepartment / deleteDepartment | admin | xem §2.4 |
| recordOut | security, hr, admin | chỉ khi `Status=APPROVED` |
| recordIn | security, hr, admin | chỉ khi `Status=OUT` |

Mọi action (trừ nhóm `public`) phải: (1) có `token` hợp lệ trong `Sessions` và chưa hết hạn,
(2) role của session nằm trong danh sách cho phép, (3) nếu action có ràng buộc bộ phận/bước thì
kiểm tra thêm trước khi ghi. Vi phạm bất kỳ điều nào trả lỗi (xem §6) — không throw raw exception.

---

## 5. API — Google Apps Script Web App

- Chỉ `doPost(e)`. Body là JSON string, Content-Type `text/plain;charset=utf-8` (tránh preflight
  CORS). `doGet(e)` trả `{ok:true}` để kiểm tra Web App còn sống.
- Request: `{ "action": "<tên action>", "token": "<uuid|null>", "payload": { ... } }`
- Response thành công: `{ "ok": true, "data": { ... } }`
- Response lỗi: `{ "ok": false, "error": { "code": "<MÃ_LỖI>", "message": "<thông báo tiếng Việt>" } }`

Mã lỗi chuẩn hoá (dùng xuyên suốt Code.gs và được api.js/mock hiểu):
`UNKNOWN_ACTION`, `BAD_REQUEST`, `UNAUTHENTICATED`, `SESSION_EXPIRED`, `FORBIDDEN`,
`NOT_FOUND`, `INVALID_TRANSITION`, `LOCKED_ACCOUNT`, `RATE_LIMITED`, `CONFLICT_VERSION`,
`VALIDATION_ERROR`, `INTERNAL_ERROR`.

### 5.1 Cấu trúc dữ liệu dùng chung

**RequestDTO** (dùng trong list/status/pdf-data response, map 1-1 với cột Sheet §2.1 nhưng
dùng camelCase và KHÔNG bao giờ chứa field nội bộ nào ngoài bảng dưới):

```json
{
  "requestId": "GP-20260115-001",
  "createdAt": "2026-01-15T01:30:00.000Z",
  "date": "2026-01-15",
  "fullName": "Nguyễn Văn A",
  "emplId": "NV001",
  "dept": "QA",
  "comeOutPlanned": "08:00",
  "comeInPlanned": "11:30",
  "reason": "PERSONAL",
  "reasonDetail": "",
  "status": "PENDING_MGR",
  "supId": "sup01",
  "mgrId": "mgr01",
  "hrId": "",
  "supAt": "", "mgrAt": "", "hrAt": "",
  "rejectedBy": "", "rejectReason": "",
  "guardOutBy": "", "guardOutAt": "", "guardInBy": "", "guardInAt": "",
  "version": 1
}
```
(Không có field nào chứa FileId trực tiếp; ảnh chữ ký chỉ trả qua `getRequestPdfData` dạng
`signatures: { applicant, supervisor, manager, hr, security }` — mỗi key là data URL base64 hoặc
`null`.)

**UserDTO** (không bao giờ có PasswordHash/Salt):
```json
{
  "username": "mgr01", "fullName": "Trần Thị B", "emplId": "NV002", "dept": "QA",
  "role": "manager", "email": "b@wahl.com", "status": "ACTIVE",
  "mustChangePw": false, "hasSignature": true, "createdAt": "..."
}
```

**ApproverOption**: `{ "username": "sup01", "fullName": "Lê Văn C" }`

### 5.2 Danh sách action chi tiết (payload → data)

- `getDepartments` → `{}` → `{ departments: [{dept, supervisors:[ApproverOption], manager:ApproverOption}] }`
- `getApproverOptions` payload `{dept}` → `{ supervisors:[ApproverOption], manager:ApproverOption|null }`
- `submitRequest` payload `{fullName, emplId, dept, date, comeOutPlanned, comeInPlanned, reason, reasonDetail, supId, mgrId, applicantSignature(base64), honeypot}` → `{ requestId }`
- `getRequestStatus` payload `{requestId, emplId}` → `{ request: RequestDTO, timeline: [{step, by, at, action}], signatures: {applicant,supervisor,manager,hr,security}|null, names: {username: fullName} }`
  (signatures chỉ khác `null` khi `request.status` thuộc `APPROVED`/`OUT`/`COMPLETED` — cho phép trang
  công khai index.html tự xuất PDF đầy đủ chữ ký mà không cần đăng nhập qua `getRequestPdfData`.)
- `register` payload `{fullName, emplId, dept, email, username, password, confirmPassword, honeypot}` → `{ message }`
- `login` payload `{username, password}` → `{ token, user: UserDTO }`
- `logout` payload `{}` → `{}`
- `me` payload `{}` → `{ user: UserDTO }`
- `changePassword` payload `{oldPassword, newPassword}` → `{}`
- `uploadMySignature` payload `{imageBase64}` → `{}`
- `getMySignature` payload `{}` → `{ dataUrl: string|null }`
- `listRequests` payload `{dateFrom?, dateTo?, dept?, status?}` → `{ requests: [RequestDTO], names: {username: fullName} }`
- `approve` payload `{requestId, version}` → `{ request: RequestDTO }`
- `reject` payload `{requestId, version, reason}` → `{ request: RequestDTO }`
- `getRequestPdfData` payload `{requestId}` → `{ request: RequestDTO, signatures: {...}, names: {...} }`
- `listUsers` payload `{}` → `{ users: [UserDTO] }`
- `listPendingUsers` payload `{}` → `{ users: [UserDTO] }`
- `activateUser` payload `{username, role, dept?}` → `{}`
- `rejectUser` payload `{username}` → `{}`
- `createUser` payload `{username, fullName?, emplId?, dept?, role?, email?, tempPassword?}` → `{ tempPassword? }` (chỉ khi hệ thống tự sinh)
- `updateUser` payload `{username, fullName?, emplId?, dept?, role?, email?, status?}` → `{}`
- `resetPassword` payload `{username, tempPassword?}` → `{ tempPassword? }` (chỉ khi hệ thống tự sinh)
- `uploadUserSignature` payload `{username, imageBase64}` → `{}`
- `setConfig` payload `{key, value}` → `{}`
- `getConfig` payload `{}` → `{ config: {key: value} }`
- `listAuditLog` payload `{dateFrom?, dateTo?}` → `{ logs: [...] }`
- `listDepartmentsAdmin` payload `{}` → `{ departments: [{dept, supervisorUsernames:[string], managerUsername, memberCount}] }`
- `saveDepartment` payload `{dept, originalDept?, supervisorUsernames:[string], managerUsername}` → `{}` (không có `originalDept` = tạo mới)
- `deleteDepartment` payload `{dept}` → `{}`
- `listToday` (public) payload `{date?}` → `{ date, requests: [{requestId, date, fullName, emplId, dept, comeOutPlanned, comeInPlanned, status, supId, supAt, mgrId, mgrAt, hrId, hrAt, rejectedBy, guardOutAt, guardInAt}], names, serverTime }`
- `recordOut` payload `{requestId, version}` → `{ request: RequestDTO }`
- `recordIn` payload `{requestId, version}` → `{ request: RequestDTO }`

---

## 6. CSS variables (assets/css/style.css, định nghĩa ở `:root`)

```css
--color-primary: #1f5fbf;
--color-primary-dark: #174a96;
--color-dark: #1c2430;
--color-gray: #5b6575;
--color-gray-light: #dde2ea;
--color-bg: #f3f5f9;
--color-white: #ffffff;
--color-success: #16803c;
--color-danger: #d1352b;
--color-warning: #c77700;
--font-family: 'Segoe UI', 'Be Vietnam Pro', Roboto, 'Noto Sans', Arial, sans-serif;
--radius: 10px;
--shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
--space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 32px;
/* + các biến phụ: --color-*-soft, --color-line, --radius-lg, --shadow-lg, --header-h */
```

Nhắc trường còn trống: thêm class `is-missing` vào `.field` (hoặc `.choice-group`, `.sig-box`) →
viền + nhãn đỏ và hiện `.field__missing`. Không bao giờ chặn gửi vì trường trống. Trang nhân viên:
lần bấm "Gửi" đầu tiên chỉ tô đỏ + cuộn tới mục trống; bấm "Vẫn gửi" lần nữa để gửi luôn.
Bảng `.data-table` tự chuyển dạng thẻ trên màn hình < 640px (nhãn cột qua `data-label`).

---

## 7. assets/js/api.js — danh sách hàm export bắt buộc

```js
export const MOCK_MODE;              // boolean, true nếu config.API_URL === placeholder
export async function callApi(action, payload);  // gọi thật (fetch) hoặc mock, tự đính kèm token từ sessionStorage
export function getToken();
export function setToken(token);
export function clearToken();
export async function cachedCall(action, payload, ttlMs, onData); // cache localStorage stale-while-revalidate (chỉ dữ liệu công khai)
export function invalidateCache(action);
export function clearStaleSessionData();  // gọi khi tải mỗi trang: xoá khoá cũ + cache hết hạn
export function clearAllSessionData();    // gọi khi đăng xuất / hết phiên
export function renderMockBanner();
export function resetMockData();
```
Token nằm trong `sessionStorage` (tự mất khi đóng tab). Trang quản lý tự đăng xuất sau 30 phút
không hoạt động. `fetch` có timeout 30 giây.

Mock mode dùng `localStorage` key `gatepass_mock_db_v2` chứa `{requests:[], users:[], sessions:[],
departments:[{dept, supervisorUsernames:[...], managerUsername}], config:{}, auditLog:[]}`,
implement đúng state machine §3, quyền §4 và liên kết bộ phận §2.4 trong JS thuần để test UI
offline (tài khoản demo `admin`/`hr01`/`sup01`/`mgr01`/`sup02`/`mgr02`, mật khẩu `Test1234`).
Khi `MOCK_MODE === true`, mọi trang chèn banner `.mock-banner` đầu trang.

## 8. assets/js/pdf.js — danh sách hàm export bắt buộc

```js
export async function renderGatePassPdf(requestDTO, signaturesMap, options);
export function buildGatePassElement(requestDTO, signaturesMap, options); // trang A4 dạng DOM (xem trước / test vị trí trường)
// options: { draft?: boolean, approverNames?: {username: fullName} }  (approverNames = `names` từ API)
//   draft=true (hoặc requestDTO.status chưa đạt APPROVED trở lên) vẽ watermark
//   "CHƯA DUYỆT / DRAFT".
```

**Cách tiếp cận (quan trọng — không tái tạo lại form bằng HTML/CSS):** `assets/img/gatepass-form-bg.png`
là ảnh xuất trực tiếp từ chính file `HR-F-GEN-0057-01 Giấy phép ra vào cổng.pdf` gốc (200dpi,
PyMuPDF `page.get_pixmap`), dùng làm **ảnh nền cố định** cho mọi PDF xuất ra. `pdf.js` chỉ build
1 container A4 (210mm×297mm) chứa ảnh nền này + các `<div>` overlay định vị tuyệt đối (CSS `mm`)
đè đúng toạ độ từng ô trống/checkbox/chữ ký — toạ độ được đo trực tiếp từ dữ liệu vector (text
words + bảng kẻ) của PDF gốc bằng PyMuPDF rồi quy đổi pt→mm, không phải ước lượng bằng mắt. Sau
đó dùng html2canvas chụp container → nhúng vào jsPDF 1 trang → lưu file tên
`GatePass_<requestId>_<emplId>.pdf`. Cách này đảm bảo PDF xuất ra giống hệt bố cục/phông/màu
form giấy gốc thay vì một bản dựng lại có thể lệch chi tiết.

## 9. assets/js/signature-pad.js — danh sách hàm export bắt buộc

```js
export class SignaturePad {
  constructor(canvasEl);
  clear();
  isEmpty();
  toDataUrl(maxWidthPx = 300); // PNG, resize canvas tạm để nén trước khi export
  setEnabled(enabled);
  onChange;                    // callback(isEmpty) sau mỗi nét vẽ / khi xoá
}
```
Đổi kích thước canvas (xoay màn hình, hiện tab đang ẩn) giữ nguyên nét đã ký.

---

## 10. Ghi chú bảo mật bắt buộc (Code.gs/Auth.gs/Users.gs/Requests.gs/Security.gs)

- Băm mật khẩu: `Utilities.computeDigest(DigestAlgorithm.SHA_256, password + salt)` lặp ≥1000
  vòng (hash lại digest nhiều lần), salt = `Utilities.getUuid()` riêng mỗi user.
- Không bao giờ trả `PasswordHash`/`Salt` ra ngoài — luôn map qua UserDTO trước khi trả.
- `register`: ép `Role=""`, `Status="PENDING"` ở server bất kể payload client gửi gì.
- `LockService.getScriptLock()` bọc quanh mọi thao tác ghi Sheet (tạo RequestId mới, duyệt,
  cho ra/vào, tạo user, đổi mật khẩu).
- Khóa tài khoản 15 phút sau 5 lần sai mật khẩu liên tiếp (`FailedCount`, `LockedUntil`).
- Thông báo lỗi đăng nhập luôn là "Sai tên đăng nhập hoặc mật khẩu" (không tiết lộ username tồn
  tại hay không).
- `Version` trên Requests tăng mỗi lần ghi; `approve`/`reject`/`recordOut`/`recordIn` nhận kèm
  `version` client đang có, nếu khác version hiện tại trên Sheet → lỗi `CONFLICT_VERSION`.
- `RequestId` đánh số theo RequestId đã cấp trong ngày (không theo cột Date — giấy xin cho ngày
  khác hôm nay không làm trùng mã).
- Mật khẩu tạm do hệ thống sinh chỉ trả về cho admin đúng 1 lần (HTTPS), không lưu rõ, không log.
- Dashboard bảo vệ công khai chỉ lộ tên / mã NV / bộ phận / giờ / trạng thái / tên người duyệt —
  không có lý do, chi tiết lý do, lý do từ chối, chữ ký.
- Không đặt dữ liệu cá nhân (mã NV…) lên URL.
- Ghi dòng Sheet bằng 1 lần `setValues` cho cả dòng (`updateRowByIndex`) thay vì từng ô — nhanh hơn
  nhiều trên Apps Script.

---

## 11. Thứ tự DeepSeek sinh file (Pha 1)

1. `apps-script/appsscript.json`, `apps-script/Util.gs`, `apps-script/Setup.gs`
2. `apps-script/Auth.gs`, `apps-script/Users.gs`
3. `apps-script/Requests.gs`, `apps-script/Security.gs`
4. `apps-script/Code.gs` (router, cần biết hết các action ở trên)
5. `assets/js/config.js`, `assets/js/api.js` (gồm mock)
6. `assets/js/signature-pad.js`
7. `assets/js/pdf.js`
8. `hr.html`
9. `index.html`
10. `security.html`
11. `assets/css/style.css`
12. `README.md`

Mỗi file DeepSeek sinh xong được Claude đọc lại và đối chiếu SPEC.md này trước khi chạy bước kế
tiếp phụ thuộc vào nó.
