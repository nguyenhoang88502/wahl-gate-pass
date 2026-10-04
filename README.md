# Giấy phép ra/vào cổng paperless — Wahl Vietnam

Web app thay thế biểu mẫu giấy **HR-F-GEN-0057-01** (hiệu lực 01/10/2022). Frontend là
HTML/CSS/JS thuần (không build step), database là **Google Sheets**, backend là **Google Apps
Script** deploy dạng Web App, PDF xuất ở client bằng **jsPDF + html2canvas**.

Tài liệu đặc tả đầy đủ: [docs/SPEC.md](docs/SPEC.md).

## Yêu cầu trước khi bắt đầu

- Một tài khoản Google (để tạo Sheet + Apps Script).
- Trình duyệt hiện đại (Chrome/Edge/Firefox bản mới).
- Không cần Node.js để chạy app (chỉ cần nếu muốn chạy `tests/` hoặc `tools/deepseek_worker.mjs`).

## Bước 1 — Tạo Google Sheet

1. Vào [sheets.google.com](https://sheets.google.com), tạo 1 Sheet mới, đặt tên ví dụ
   `GatePass Database`.
2. Mở **Extensions → Apps Script**.

## Bước 2 — Dán code Apps Script

Trong Apps Script editor, tạo lần lượt các file **Script (.gs)** sau (menu `+` → Script) và dán
nguyên văn nội dung từ thư mục `apps-script/` của repo vào từng file cùng tên:

- `Code.gs`
- `Util.gs`
- `Auth.gs`
- `Users.gs`
- `Requests.gs`
- `Departments.gs`
- `Security.gs`
- `Setup.gs`

> Đang nâng cấp từ bản cũ? Dán đè **tất cả** các file trên (bản mới có thêm `Departments.gs` và
> sửa `Util.gs`/`Auth.gs`/`Users.gs`/`Requests.gs`/`Security.gs`/`Code.gs`), rồi deploy
> **New version** (xem Bước 5). Không cần chạy lại `setup()`, dữ liệu cũ giữ nguyên.

Sau đó mở **Project Settings** (biểu tượng bánh răng) → tick **Show "appsscript.json" manifest
file in editor**, mở file `appsscript.json` xuất hiện trong editor, thay nội dung bằng
`apps-script/appsscript.json` của repo.

## Bước 3 — Đặt Script Properties

**Project Settings → Script Properties → Add script property**:

| Key | Value |
|---|---|
| `ADMIN_INITIAL_PASSWORD` | một mật khẩu tạm mạnh do bạn tự chọn (sẽ phải đổi ngay lần đăng nhập đầu) |

## Bước 4 — Chạy `setup()`

1. Trong Apps Script editor, ở dropdown chọn hàm chạy, chọn `setup`.
2. Bấm **Run**.
3. Lần đầu Google sẽ yêu cầu cấp quyền (authorize) — màn hình cảnh báo "ứng dụng chưa xác
   minh" là bình thường vì đây là script của chính bạn: chọn **Advanced → Go to [tên project]
   (unsafe)** rồi **Allow**.
4. Mở **Execution log** để xác nhận các dòng như "Đã tạo sheet Requests", "Đã tạo thư mục
   Drive", "Đã tạo admin đầu tiên" đã chạy thành công.
5. `setup()` an toàn để chạy lại nhiều lần (idempotent) — sẽ không tạo trùng dữ liệu.

## Bước 5 — Deploy Web App

1. **Deploy → New deployment**.
2. Chọn loại **Web app**.
3. **Execute as**: `Me`. **Who has access**: `Anyone`.
4. Bấm **Deploy**, copy URL dạng `https://script.google.com/macros/s/XXXXX/exec`.

> **Quan trọng**: mỗi lần sửa bất kỳ file `.gs` nào sau này, phải vào **Deploy → Manage
> deployments**, bấm biểu tượng bút chì (Edit) ở bản deploy hiện có, đổi **Version** thành
> **New version**, rồi bấm **Deploy** — URL `/exec` giữ nguyên, chỉ code bên trong được cập
> nhật. Nếu tạo "New deployment" mới thay vì "New version", URL sẽ đổi và phải cập nhật lại
> `config.js`.

## Bước 6 — Cấu hình frontend

Mở [assets/js/config.js](assets/js/config.js), thay:

```js
API_URL: 'PASTE_APPS_SCRIPT_WEBAPP_URL_HERE',
```

bằng URL `/exec` vừa copy ở Bước 5.

## Bước 7 — Deploy site tĩnh

Vì toàn bộ frontend là file tĩnh (HTML/CSS/JS thuần, đường dẫn asset tương đối), có thể deploy
lên bất kỳ static hosting nào. Ba lựa chọn nhanh:

### a) Surge

```bash
npm install -g surge
surge
```

Chạy lệnh `surge` trong thư mục gốc dự án, làm theo hướng dẫn trên màn hình để đặt domain
(mặc định Surge gợi ý 1 domain ngẫu nhiên `*.surge.sh`, có thể đổi).

### b) Netlify (drag-and-drop)

Vào [app.netlify.com/drop](https://app.netlify.com/drop), kéo thả toàn bộ thư mục dự án vào
trang web — Netlify tự động deploy và cấp URL.

### c) GitHub Pages

1. Push repo lên GitHub.
2. Vào **Settings → Pages**.
3. Chọn branch (ví dụ `main`) và thư mục gốc (`/`), lưu.
4. Vì asset dùng đường dẫn tương đối (`assets/...`, không phải `/assets/...`), site vẫn chạy
   đúng kể cả khi GitHub Pages phục vụ ở sub-path (`username.github.io/repo-name/`).

### Khác

Có thể dùng bất kỳ server nội bộ nào phục vụ file tĩnh (nginx, Apache, IIS), hoặc chạy nhanh để
test cục bộ:

```bash
python -m http.server 8080
```

rồi mở `http://localhost:8080/index.html`.

## Checklist test sau khi deploy

- [ ] Mở `index.html` — **không** còn thấy banner "MOCK MODE" (xác nhận đã kết nối Apps Script
      thật, không còn dùng URL placeholder).
- [ ] Trên `hr.html`, tab "Đăng ký tài khoản" → đăng ký 1 tài khoản (ví dụ role dự định là HR).
- [ ] Đăng nhập `hr.html` bằng `admin` / mật khẩu tạm đã đặt ở `ADMIN_INITIAL_PASSWORD` → bị bắt
      đổi mật khẩu ngay (MustChangePw) → đổi mật khẩu mới.
- [ ] Tab "Bộ phận & người duyệt" → **+ Thêm bộ phận** cho từng bộ phận (QA, Sản xuất, …).
- [ ] Tab "Người dùng" → **+ Thêm người dùng** cho từng Giám sát / Trưởng bộ phận / HR: chọn vai
      trò + bộ phận → hệ thống **tự gán** họ làm người duyệt của bộ phận đó (không cần sửa Sheet).
      Để trống mật khẩu tạm → hệ thống tự tạo và hiện **1 lần** để bạn gửi cho họ.
      (Hoặc: họ tự đăng ký ở tab "Đăng ký" → admin kích hoạt ở mục "Tài khoản chờ kích hoạt",
      chọn vai trò + bộ phận.)
- [ ] Mỗi người duyệt đăng nhập, đổi mật khẩu lần đầu, rồi **ký chữ ký số** ở tab "Tài khoản"
      (hoặc admin tải ảnh chữ ký lên trong hộp thoại sửa người dùng). Chưa có chữ ký thì chưa
      duyệt được — bảng bộ phận đánh dấu ⚠ người nào còn thiếu.
- [ ] Trên `index.html`, nhân viên gửi 1 giấy phép: chọn bộ phận → giám sát / trưởng BP tự hiện
      đúng người đã gán. Không trường nào bắt buộc — trường trống chỉ tô đỏ để nhắc.
- [ ] Trên `hr.html`, lần lượt đăng nhập supervisor → duyệt, manager → duyệt, hr → duyệt (mục
      "Cần tôi duyệt").
- [ ] Mở `security.html` (**không cần đăng nhập**) — giấy vừa duyệt hiện **ĐƯỢC RA** kèm tên
      người đã duyệt từng bước; tự cập nhật mỗi 15 giây.
- [ ] Quay lại `index.html`, dùng tab "Tra cứu trạng thái" nhập đúng mã giấy phép + mã nhân
      viên, kiểm tra timeline hiển thị đủ các bước, tải PDF.
- [ ] Mở file PDF: kiểm tra các ô chữ ký đã điền (người xin phép, giám sát, trưởng BP, HR), tên
      người ký + thời gian ký hiển thị đúng, bố cục giống form gốc, **không lỗi font tiếng Việt
      có dấu**, gói gọn 1 trang A4. (Ô bảo vệ + giờ ra/vào thực tế để trống — bảo vệ ghi tay.)
- [ ] Thử đăng nhập sai mật khẩu 5 lần liên tiếp trên 1 tài khoản — xác nhận tài khoản bị khóa
      tạm 15 phút.

## Mock Mode (chạy thử offline, chưa cần Apps Script)

Nếu `assets/js/config.js` vẫn giữ nguyên giá trị `PASTE_APPS_SCRIPT_WEBAPP_URL_HERE`, toàn bộ
site tự động chạy ở **MOCK MODE**: mọi action được mô phỏng bằng `localStorage` thay vì gọi Apps
Script thật — hữu ích để xem giao diện / demo luồng nghiệp vụ trước khi có backend thật. Một
banner vàng cố định đầu trang sẽ cảnh báo khi đang ở chế độ này.

Tài khoản mẫu có sẵn trong Mock Mode (tất cả dùng mật khẩu `Test1234`):

| Username | Role |
|---|---|
| `admin` | admin |
| `hr01` | hr |
| `sup01` | supervisor (bộ phận QA) |
| `mgr01` | manager (bộ phận QA) |
| `sup02` | supervisor (bộ phận Sản xuất) |
| `mgr02` | manager (bộ phận Sản xuất, chưa có chữ ký) |

Bảo vệ không cần tài khoản. Mock có sẵn vài giấy phép mẫu hôm nay để xem dashboard bảo vệ.

Có thể xóa toàn bộ dữ liệu mock và bắt đầu lại bằng cách xóa key `gatepass_mock_db_v2` trong
DevTools → Application → Local Storage (hoặc gọi `resetMockData()` từ `assets/js/api.js` qua
Console).

## Chạy test tự động

```bash
node --test tests/*.test.mjs
```

(Trên một số phiên bản/máy, `node --test tests/` với đường dẫn thư mục trần không tự động
quét được file — nếu gặp lỗi `Cannot find module 'tests'`, dùng lệnh glob ở trên hoặc chỉ thẳng
file: `node --test tests/backend.test.mjs`.)

Các test dùng Node.js built-in test runner (`node:test`), tự stub `SpreadsheetApp`, `DriveApp`,
`LockService`, `Utilities`, `PropertiesService`, `ContentService` để chạy thử logic trong các
file `apps-script/*.gs` mà không cần deploy lên Google. Stub `SpreadsheetApp` mô phỏng cả việc
Google Sheets tự đổi kiểu dữ liệu khi ghi (giờ → Time, ngày → Date, `00123` → số) để bắt lỗi
đọc/ghi sai kiểu. `tests/backend.test.mjs` kiểm thử quyền / state machine / bảo mật,
`tests/linking.test.mjs` kiểm thử liên kết bộ phận, không trường bắt buộc, dashboard bảo vệ công
khai, dọn phiên, cache.

## Bảo mật đã áp dụng

- Mật khẩu **không bao giờ** lưu dạng rõ — chỉ lưu `PasswordHash` (SHA-256 lặp ≥1000 vòng) +
  `Salt` ngẫu nhiên riêng từng user; 2 trường này không bao giờ được trả ra ngoài qua API.
- Mọi action (trừ nhóm public) kiểm tra `token` còn hiệu lực + đúng `role` + đúng bộ phận (nếu
  action yêu cầu) ngay phía server (`Code.gs` router + từng handler) — client không được tin
  tưởng để tự quyết định quyền.
- `register` luôn ép `Role=""`, `Status="PENDING"` ở server bất kể client gửi gì lên.
- `LockService.getScriptLock()` bọc quanh mọi thao tác ghi Sheet quan trọng (tạo request mới,
  duyệt/từ chối, cho ra/vào, tạo/sửa user) để tránh race condition khi nhiều người thao tác
  đồng thời.
- Tài khoản bị khóa tạm 15 phút sau 5 lần đăng nhập sai liên tiếp; thông báo lỗi đăng nhập luôn
  chung chung ("Sai tên đăng nhập hoặc mật khẩu"), không tiết lộ username có tồn tại hay không.
- Trường `Version` trên mỗi request dùng để chống ghi đè khi 2 người duyệt/thao tác cùng lúc
  (optimistic locking) — client gửi kèm version đang có, server từ chối nếu đã bị thay đổi.
- **Sheet `Users` chỉ nên chia sẻ quyền truy cập cho admin** — không chia sẻ link Sheet cho nhân
  viên vì chứa `PasswordHash`/`Salt` (dù đã băm, vẫn không nên để lộ).
- Dashboard bảo vệ (`security.html`) công khai nhưng **chỉ đọc** và chỉ hiện tên / mã NV / bộ
  phận / giờ / trạng thái / người duyệt — không lộ lý do, chi tiết lý do hay chữ ký.
- Phiên đăng nhập lưu trong `sessionStorage` (mất khi đóng tab), tự đăng xuất sau 30 phút không
  hoạt động; đăng xuất xoá sạch dữ liệu phiên + cache trên trình duyệt; server dọn phiên hết hạn
  mỗi lần đăng nhập. Khoá tài khoản / đổi vai trò có hiệu lực ngay với phiên đang mở.
- Mọi giá trị ghi vào Sheet được bảo vệ khỏi formula injection (`=...` lưu dạng text).
- `API_URL` trong `config.js` được phép hard-code công khai vì URL Web App vốn công khai theo
  thiết kế của Apps Script — toàn bộ bảo vệ nằm ở việc kiểm tra `token`/role/bộ phận phía Apps
  Script, không nằm ở việc giấu URL.

## Ghi chú về DeepSeek worker (cho người phát triển tiếp dự án)

`tools/deepseek_worker.mjs` dùng để sinh khung code (boilerplate) từ DeepSeek API, dựa trên
`docs/SPEC.md` làm hợp đồng. Cách dùng:

```bash
node tools/deepseek_worker.mjs --task "<mô tả file cần viết>" --out <đường dẫn file> --context docs/SPEC.md,<file liên quan khác>
```

Cần tạo file `tools/.env.local` (đã nằm trong `.gitignore`, **không commit**) chứa:

```
DEEPSEEK_KEY_FILE=<đường dẫn tuyệt đối tới file chứa API key của bạn>
```

Script tự đọc và trim nội dung file key, không bao giờ in ra console/log, không ghi vào repo.
**Không bao giờ** commit file chứa API key thật.

## Giấy phép / Liên hệ

Dự án nội bộ Wahl Vietnam Co., Ltd — không phát hành công khai.
