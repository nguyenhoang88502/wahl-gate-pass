// assets/js/pdf.js
// ES module thuần chạy trên trình duyệt.
// Phụ thuộc CDN đã nạp sẵn ở <script> của từng trang HTML:
//   - window.jspdf.jsPDF
//   - window.html2canvas
// KHÔNG import npm. KHÔNG phụ thuộc assets/css/style.css.
//
// CÁCH TIẾP CẬN: thay vì tái tạo lại bố cục form bằng HTML/CSS, file này dùng
// CHÍNH ảnh scan của form gốc (assets/img/gatepass-form-bg.png, xuất trực tiếp
// từ HR-F-GEN-0057-01 Giấy phép ra vào cổng.pdf ở 200dpi) làm nền, rồi CHỈ đè
// (overlay) dữ liệu động lên đúng toạ độ từng ô trống — đảm bảo PDF xuất ra
// giống hệt bố cục/màu sắc/phông chữ của form giấy gốc, không "làm lại form mới".
//
// Toạ độ overlay bên dưới được đo trực tiếp từ dữ liệu vector (text words +
// table grid lines) của file PDF gốc bằng PyMuPDF, quy đổi từ pt (1/72 inch)
// sang mm (1pt = 0.352778mm), rồi đặt bằng CSS "mm" trên 1 container đúng
// kích thước A4 (210mm x 297mm) — khớp chính xác với ảnh nền.
//
// Ghi chú font tiếng Việt: vì dùng html2canvas chụp từ DOM HTML thật, font sẽ do
// trình duyệt render (font hệ thống). KHÔNG cần nhúng font riêng cho jsPDF.

const PDF_PAGE_W_MM = 210;
const PDF_PAGE_H_MM = 297;
// Tương đối tới trang HTML gọi (index.html/security.html/hr.html đều ở thư mục gốc),
// KHÔNG dùng '../' vì sẽ lệch nếu site được deploy ở sub-path (xem SPEC §0 TECH STACK).
const FORM_BG_SRC = 'assets/img/gatepass-form-bg.png';

const APPROVED_STATUSES = ['APPROVED', 'OUT', 'COMPLETED'];

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// formatDateTimeVN: ISO string -> 'DD/MM/YYYY HH:mm' (giờ local trình duyệt).
function formatDateTimeVN(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return (
    pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  );
}

// formatTimeHHmm: ISO string -> 'HH:mm' (giờ local). Rỗng/không parse -> ''.
function formatTimeHHmm(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// Tách 'YYYY-MM-DD' thành {day, month, year} để điền vào chỗ trống trên form.
function splitDateParts(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return { day: '', month: '', year: '' };
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { day: '', month: '', year: '' };
  return { year: m[1], month: m[2], day: m[3] };
}

/** 1 ô overlay định vị tuyệt đối theo mm, khớp toạ độ đo từ PDF gốc. */
function box(leftMm, topMm, widthMm, heightMm, innerHtml, extraStyle) {
  const style =
    'position:absolute;left:' + leftMm + 'mm;top:' + topMm + 'mm;' +
    'width:' + widthMm + 'mm;height:' + heightMm + 'mm;' +
    'display:flex;align-items:center;' + (extraStyle || '');
  return '<div style="' + style + '">' + innerHtml + '</div>';
}

function textBox(leftMm, topMm, widthMm, heightMm, text, fontSizePt, opts) {
  opts = opts || {};
  const justify = opts.center ? 'justify-content:center;text-align:center;' : '';
  const bold = opts.bold ? 'font-weight:bold;' : '';
  const style =
    'font-size:' + fontSizePt + 'pt;line-height:1.1;overflow:hidden;white-space:nowrap;' +
    bold + justify;
  return box(leftMm, topMm, widthMm, heightMm, '<span>' + escapeHtml(text) + '</span>', style);
}

/** Dấu X đánh vào ô checkbox "( )" tại toạ độ tâm (cxMm, cyMm). */
function checkMark(cxMm, cyMm) {
  const size = 4; // mm
  return box(
    cxMm - size / 2, cyMm - size / 2, size, size,
    '<span style="font-weight:bold;font-size:9pt;">X</span>',
    'justify-content:center;text-align:center;'
  );
}

/** Ô chữ ký: ảnh (nếu có) + tên người ký + thời gian ký, đặt giữa cột. */
function signatureBox(centerXMm, topMm, colWidthMm, heightMm, sigDataUrl, nameLine, timeLine) {
  const w = Math.min(colWidthMm - 4, 26);
  const left = centerXMm - w / 2;
  let inner = '';
  if (sigDataUrl) {
    inner += '<img src="' + sigDataUrl + '" style="max-width:' + w + 'mm;max-height:' + (heightMm * 0.6) + 'mm;display:block;margin:0 auto;" />';
  }
  const nameHtml = nameLine
    ? '<div style="font-size:7.5pt;text-align:center;white-space:nowrap;">' + escapeHtml(nameLine) + '</div>'
    : '';
  const timeHtml = timeLine
    ? '<div style="font-size:6.5pt;text-align:center;color:#444;white-space:nowrap;">' + escapeHtml(timeLine) + '</div>'
    : '';
  return box(
    centerXMm - colWidthMm / 2, topMm, colWidthMm, heightMm,
    '<div style="width:100%;">' + inner + nameHtml + timeHtml + '</div>',
    'flex-direction:column;justify-content:center;align-items:center;'
  );
}

/**
 * Xây dựng toàn bộ lớp overlay (dữ liệu động) đè lên ảnh nền form gốc.
 * Toạ độ đo trực tiếp từ PDF gốc (xem ghi chú đầu file).
 */
function buildOverlayHtml(requestDTO, signaturesMap, options) {
  const r = requestDTO || {};
  const sig = signaturesMap || {};
  const approverNames = (options && options.approverNames) || {};
  const nameOrUsername = (username) => (username ? (approverNames[username] || username) : '');

  const dateParts = splitDateParts(r.date);
  const reasonChecks = {
    PERSONAL: [45.6, 116.4],
    ANNUAL_LEAVE: [93.1, 115.6],
    MATERNITY: [156.8, 116.4],
    SICK: [45.6, 125.4],
    JOB_ACCIDENT: [93.3, 125.2],
    OTHER: [45.7, 134.0],
  };

  let html = '';

  // ---- Ngày/tháng/năm ----
  html += textBox(26.8, 69.1, 15.2, 4.5, dateParts.day, 10, { center: true });
  html += textBox(61.4, 69.1, 14.5, 4.5, dateParts.month, 10, { center: true });
  html += textBox(92.4, 69.1, 11.6, 4.5, dateParts.year ? dateParts.year.slice(-2) : '', 10, { center: true });

  // ---- Họ tên / Mã NV / Bộ phận ----
  html += textBox(41.5, 77.9, 47.5, 13.6, r.fullName, 9.5, { center: true, bold: true });
  html += textBox(120.8, 77.9, 31.6, 13.6, r.emplId, 9.5, { center: true, bold: true });
  html += textBox(184.5, 77.9, 17.2, 13.6, r.dept, 9.5, { center: true, bold: true });

  // ---- Giờ vào / Giờ ra dự kiến ----
  // Lưu ý: form gốc liệt kê "Giờ vào/Come in" TRƯỚC "Giờ ra/Come out" — Giờ vào = giờ quay
  // lại (ComeInPlanned), Giờ ra = giờ xuất phát (ComeOutPlanned), khớp đúng tên trường SPEC.
  html += textBox(88.0, 96.3, 8.7, 4.3, r.comeInPlanned, 9, { center: true });
  html += textBox(165.1, 96.3, 14.5, 4.3, r.comeOutPlanned, 9, { center: true });

  // ---- Lý do (checkbox) ----
  const checkPos = reasonChecks[r.reason];
  if (checkPos) {
    html += checkMark(checkPos[0], checkPos[1]);
  }
  if (r.reason === 'OTHER' && r.reasonDetail) {
    html += textBox(44.1, 135.3, 155.2, 4.5, r.reasonDetail, 8.5, {});
  }

  // ---- Hàng chữ ký duyệt (Applicant / Supervisor / Dept Manager / HR&Admin / Security) ----
  const sigRowTop = 155.3;
  const sigRowH = 22.8;
  html += signatureBox(26.3, sigRowTop, 30.3, sigRowH, sig.applicant, r.fullName, '');
  html += signatureBox(65.3, sigRowTop, 47.6, sigRowH, sig.supervisor, nameOrUsername(r.supId), formatDateTimeVN(r.supAt));
  html += signatureBox(104.9, sigRowTop, 31.75, sigRowH, sig.manager, nameOrUsername(r.mgrId), formatDateTimeVN(r.mgrAt));
  html += signatureBox(136.6, sigRowTop, 31.6, sigRowH, sig.hr, nameOrUsername(r.hrId), formatDateTimeVN(r.hrAt));
  html += signatureBox(177.1, sigRowTop, 49.0, sigRowH, sig.security, nameOrUsername(r.guardOutBy || r.guardInBy), '');

  // ---- Thời gian thực tế (bảo vệ ghi nhận) ----
  // Cùng thứ tự với khối "dự kiến": dòng "Giờ vào/Come in" = giờ quay lại thật (guardInAt),
  // dòng "Giờ ra/Come out" = giờ rời đi thật (guardOutAt).
  html += textBox(79.9, 191.1, 8.7, 4.3, formatTimeHHmm(r.guardInAt), 9, { center: true });
  html += textBox(77.2, 200.0, 14.4, 4.3, formatTimeHHmm(r.guardOutAt), 9, { center: true });

  // ---- Chữ ký bảo vệ (phần "For security guard only") ----
  if (sig.security) {
    html += signatureBox(
      117.5, 187.4, 42, 21.9,
      sig.security, nameOrUsername(r.guardOutBy || r.guardInBy), ''
    );
  }

  // ---- Người xin phép ký xác nhận tại cổng (dùng lại chữ ký lúc đăng ký) ----
  html += signatureBox(177.1, 187.4, 49.0, 21.9, sig.applicant, r.fullName, '');

  // ---- Watermark DRAFT nếu chưa duyệt đủ ----
  const isDraft = (options && options.draft === true) || APPROVED_STATUSES.indexOf(r.status) === -1;
  if (isDraft) {
    html +=
      '<div style="position:absolute;left:0;top:120mm;width:210mm;text-align:center;' +
      'transform:rotate(-30deg);font-size:40pt;font-weight:bold;color:rgba(200,0,0,0.28);' +
      'letter-spacing:4px;">CHƯA DUYỆT / DRAFT</div>';
  }

  return html;
}

/**
 * Dựng trang A4 (ảnh form gốc + lớp dữ liệu) dưới dạng phần tử DOM, CHƯA gắn vào trang.
 * Dùng cho xuất PDF và để kiểm tra trực quan vị trí từng trường (test Playwright).
 */
export function buildGatePassElement(requestDTO, signaturesMap, options) {
  const container = document.createElement('div');
  container.className = 'gatepass-page';
  container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.style.width = PDF_PAGE_W_MM + 'mm';
  container.style.height = PDF_PAGE_H_MM + 'mm';
  container.style.background = '#ffffff';
  container.style.fontFamily = "'Segoe UI', Roboto, 'Noto Sans', Arial, sans-serif";
  container.style.color = '#000000';

  const bgImg = document.createElement('img');
  bgImg.src = FORM_BG_SRC;
  bgImg.style.position = 'absolute';
  bgImg.style.left = '0';
  bgImg.style.top = '0';
  bgImg.style.width = PDF_PAGE_W_MM + 'mm';
  bgImg.style.height = PDF_PAGE_H_MM + 'mm';
  bgImg.style.display = 'block';
  container.appendChild(bgImg);

  const overlay = document.createElement('div');
  overlay.innerHTML = buildOverlayHtml(requestDTO, signaturesMap, options);
  container.appendChild(overlay);
  return container;
}

/**
 * Xuất PDF A4 (form gốc đã điền) và tải về máy.
 * options: { draft?: boolean, approverNames?: {username: fullName} }
 */
export async function renderGatePassPdf(requestDTO, signaturesMap, options) {
  if (!requestDTO) throw new Error('renderGatePassPdf: thiếu requestDTO');
  if (!window.jspdf || !window.jspdf.jsPDF || !window.html2canvas) {
    throw new Error('Thư viện tạo PDF chưa tải xong, vui lòng thử lại sau vài giây');
  }

  const container = buildGatePassElement(requestDTO, signaturesMap, options);
  // Đặt ngoài màn hình để html2canvas chụp được mà người dùng không thấy.
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '0';
  document.body.appendChild(container);

  try {
    // Đợi ảnh nền (và ảnh chữ ký, nếu có) tải xong trước khi chụp, tránh canvas trống.
    const imgs = container.querySelectorAll('img');
    await Promise.all(
      Array.prototype.map.call(imgs, (img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      })
    );

    const canvas = await window.html2canvas(container, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    const doc = new window.jspdf.jsPDF('p', 'mm', 'a4');
    doc.addImage(imgData, 'JPEG', 0, 0, PDF_PAGE_W_MM, PDF_PAGE_H_MM);

    const fileName = 'GatePass_' + (requestDTO.requestId || 'unknown') + '_' + (requestDTO.emplId || '') + '.pdf';
    doc.save(fileName);
  } finally {
    document.body.removeChild(container);
  }
}
