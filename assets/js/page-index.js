// assets/js/page-index.js — Trang nhân viên: gửi giấy phép + tra cứu trạng thái.
// Không trường nào bắt buộc: trường trống chỉ được tô đỏ để NHẮC, không chặn gửi.
import { callApi, cachedCall, renderMockBanner, clearStaleSessionData } from './api.js';
import { SignaturePad } from './signature-pad.js';
import { renderGatePassPdf } from './pdf.js';
import {
  $, show, hide, toggle, escapeHtml, errMessage, toast, withBusy, todayYmd,
  formatDate, reasonLabel, statusBadgeHtml, renderStepsHtml
} from './ui.js';

const DEPT_OTHER = '__other__';
const DEPT_CACHE_MS = 10 * 60 * 1000;

let departments = [];
let pad = null;
let showAllMissing = false;        // true sau lần bấm "Gửi" đầu tiên
let confirmSendWithMissing = false; // lần bấm thứ 2 khi còn trống -> gửi luôn
const touched = new Set();
let lastSubmitted = null;          // {requestId, emplId} — chỉ giữ trong bộ nhớ của tab
let lastLookup = null;             // {request, signatures, names}

function getReason() {
  const r = document.querySelector("input[name='reason']:checked");
  return r ? r.value : '';
}

function getDept() {
  const sel = $('f-dept');
  if (sel.value === DEPT_OTHER) return $('f-dept-other').value.trim();
  return sel.value;
}

function findDeptInfo(name) {
  const t = String(name || '').toLowerCase();
  return departments.find((d) => d.dept.toLowerCase() === t) || null;
}

// ---------------- Bộ phận & người duyệt ----------------

function renderDeptOptions() {
  const sel = $('f-dept');
  const prev = sel.value;
  sel.innerHTML = '';
  const ph = new Option(departments.length ? '— Chọn bộ phận —' : '— Chưa có bộ phận, chọn "Khác" —', '');
  sel.appendChild(ph);
  departments.forEach((d) => sel.appendChild(new Option(d.dept, d.dept)));
  sel.appendChild(new Option('Khác (tự nhập)…', DEPT_OTHER));
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
}

function fillApprovers(select, options, emptyLabel) {
  const prev = select.value;
  select.innerHTML = '';
  select.appendChild(new Option(emptyLabel, ''));
  options.forEach((o) => select.appendChild(new Option(o.fullName ? o.fullName + ' (' + o.username + ')' : o.username, o.username)));
  if (prev && options.some((o) => o.username === prev)) select.value = prev;
  else if (options.length === 1) select.value = options[0].username; // liên kết sẵn người duyệt duy nhất
}

function onDeptChange() {
  const sel = $('f-dept');
  toggle($('f-dept-other'), sel.value === DEPT_OTHER);
  if (sel.value === DEPT_OTHER) $('f-dept-other').focus();

  const info = findDeptInfo(getDept());
  const sups = info ? info.supervisors : [];
  const mgr = info && info.manager ? [info.manager] : [];
  fillApprovers($('f-supervisor'), sups, sups.length ? '— Không qua giám sát —' : '— Không có —');
  fillApprovers($('f-manager'), mgr, mgr.length ? '— Không chọn —' : '— Không có —');

  const hint = $('f-approver-hint');
  if (!getDept()) {
    hint.textContent = 'Chọn bộ phận để hiện người duyệt. Thứ tự duyệt: Giám sát → Trưởng bộ phận → HR.';
  } else if (!info || (!sups.length && !mgr.length)) {
    hint.textContent = 'Bộ phận này chưa được gán người duyệt — giấy phép sẽ chuyển thẳng tới HR.';
  } else {
    hint.textContent = 'Giấy phép sẽ được duyệt lần lượt: ' +
      [($('f-supervisor').value ? 'Giám sát' : null), ($('f-manager').value ? 'Trưởng bộ phận' : null), 'HR']
        .filter(Boolean).join(' → ') + '.';
  }
  refreshMissing();
}

async function loadDepartments() {
  try {
    await cachedCall('getDepartments', {}, DEPT_CACHE_MS, (data) => {
      departments = (data && data.departments) || [];
      renderDeptOptions();
      onDeptChange();
    });
  } catch (err) {
    if (!departments.length) {
      departments = [];
      renderDeptOptions();
      toast('Không tải được danh sách bộ phận: ' + errMessage(err), 'error');
    }
  }
}

// ---------------- Nhắc trường còn trống ----------------

function fieldDefs() {
  const info = findDeptInfo(getDept());
  return [
    { key: 'fullName', label: 'Họ tên', empty: () => !$('f-fullname').value.trim() },
    { key: 'emplId', label: 'Mã NV', empty: () => !$('f-emplid').value.trim() },
    { key: 'dept', label: 'Bộ phận', empty: () => !getDept() },
    { key: 'date', label: 'Ngày', empty: () => !$('f-date').value },
    { key: 'comeOut', label: 'Giờ ra', empty: () => !$('f-come-out').value },
    { key: 'comeIn', label: 'Giờ vào', empty: () => !$('f-come-in').value },
    { key: 'reason', label: 'Lý do', empty: () => !getReason() },
    { key: 'reasonDetail', label: 'Chi tiết lý do', empty: () => getReason() === 'OTHER' && !$('f-reason-detail').value.trim() },
    // Trưởng BP chỉ nhắc khi bộ phận CÓ trưởng BP để chọn.
    { key: 'mgr', label: 'Trưởng bộ phận', empty: () => !!(info && info.manager) && !$('f-manager').value },
    { key: 'signature', label: 'Chữ ký', empty: () => !pad || pad.isEmpty() }
  ];
}

function refreshMissing() {
  const missing = [];
  fieldDefs().forEach((f) => {
    const el = document.querySelector('[data-key="' + f.key + '"]');
    const empty = f.empty();
    if (empty) missing.push(f.label);
    if (el) el.classList.toggle('is-missing', empty && (showAllMissing || touched.has(f.key)));
  });

  // Cảnh báo mềm (không chặn): ngày đã qua, giờ vào trước giờ ra.
  const date = $('f-date').value;
  toggle($('f-date-warn'), !!date && date < todayYmd());
  const out = $('f-come-out').value;
  const inn = $('f-come-in').value;
  toggle($('f-time-warn'), !!out && !!inn && inn <= out);

  const sum = $('missing-summary');
  if (showAllMissing || touched.size > 0) {
    show(sum);
    sum.classList.toggle('is-ok', missing.length === 0);
    sum.textContent = missing.length
      ? 'Còn ' + missing.length + ' mục trống: ' + missing.join(', ') + '. Bạn vẫn có thể gửi.'
      : '✓ Đã điền đủ thông tin';
  } else {
    hide(sum);
  }
  if (!missing.length) confirmSendWithMissing = false;
  $('btn-submit').textContent = confirmSendWithMissing ? 'Vẫn gửi (thiếu ' + missing.length + ' mục)' : 'Gửi giấy phép';
  return missing;
}

function wireTouched() {
  const map = {
    'f-fullname': 'fullName', 'f-emplid': 'emplId', 'f-dept': 'dept', 'f-dept-other': 'dept', 'f-date': 'date',
    'f-come-out': 'comeOut', 'f-come-in': 'comeIn', 'f-reason-detail': 'reasonDetail', 'f-manager': 'mgr', 'f-supervisor': 'sup'
  };
  Object.keys(map).forEach((id) => {
    const el = $(id);
    el.addEventListener('blur', () => { touched.add(map[id]); refreshMissing(); });
    el.addEventListener('input', refreshMissing);
    el.addEventListener('change', refreshMissing);
  });
  $('f-supervisor').addEventListener('change', onDeptChange);
  $('f-manager').addEventListener('change', onDeptChange);
  document.querySelectorAll("input[name='reason']").forEach((r) => r.addEventListener('change', () => {
    touched.add('reason');
    const isOther = getReason() === 'OTHER';
    toggle($('f-reason-detail-row'), isOther);
    if (isOther) $('f-reason-detail').focus();
    else $('f-reason-detail').value = '';
    refreshMissing();
  }));
}

// ---------------- Gửi ----------------

function resetForm() {
  $('submit-form').reset();
  $('f-date').value = todayYmd();
  hide($('f-dept-other'));
  hide($('f-reason-detail-row'));
  if (pad) pad.clear();
  touched.clear();
  showAllMissing = false;
  confirmSendWithMissing = false;
  onDeptChange();
  refreshMissing();
}

async function onSubmit(evt) {
  evt.preventDefault();
  hide($('submit-error'));
  showAllMissing = true;
  const missing = refreshMissing();

  if (missing.length && !confirmSendWithMissing) {
    // Lần đầu: chỉ nhắc (tô đỏ + cuộn tới mục đầu tiên). Bấm lần nữa để gửi luôn.
    confirmSendWithMissing = true;
    refreshMissing();
    const first = document.querySelector('.is-missing');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Còn ' + missing.length + ' mục trống — bấm "Vẫn gửi" nếu muốn gửi luôn', 'warning');
    return;
  }

  const payload = {
    fullName: $('f-fullname').value.trim(),
    emplId: $('f-emplid').value.trim(),
    dept: getDept(),
    date: $('f-date').value,
    comeOutPlanned: $('f-come-out').value,
    comeInPlanned: $('f-come-in').value,
    reason: getReason(),
    reasonDetail: getReason() === 'OTHER' ? $('f-reason-detail').value.trim() : '',
    supId: $('f-supervisor').value,
    mgrId: $('f-manager').value,
    applicantSignature: pad && !pad.isEmpty() ? pad.toDataUrl(300) : '',
    honeypot: $('f-honeypot').value
  };

  await withBusy($('btn-submit'), async () => {
    pad.setEnabled(false);
    try {
      const data = await callApi('submitRequest', payload);
      lastSubmitted = { requestId: data.requestId, emplId: payload.emplId };
      $('success-id').textContent = data.requestId;
      $('success-next').textContent = payload.emplId
        ? 'Tra cứu bằng mã giấy phép + mã nhân viên ' + payload.emplId + '.'
        : 'Lưu ý: bạn chưa nhập mã nhân viên nên không tra cứu được trực tuyến — hãy báo HR mã giấy phép này.';
      toggle($('btn-goto-lookup'), !!payload.emplId);
      hide($('submit-form'));
      show($('submit-success'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      resetForm(); // xoá thông tin vừa nhập khỏi trang (không lưu lại)
    } catch (err) {
      const box = $('submit-error');
      box.textContent = errMessage(err);
      show(box);
    } finally {
      pad.setEnabled(true);
    }
  });
}

// ---------------- Tra cứu ----------------

function renderLookup(data) {
  const r = data.request;
  const names = data.names || {};
  $('lookup-id').textContent = r.requestId;
  $('lookup-name').textContent = r.fullName || '(chưa ghi họ tên)';
  $('lookup-status').innerHTML = statusBadgeHtml(r.status);
  const kv = [
    ['Mã NV', r.emplId], ['Bộ phận', r.dept], ['Ngày', formatDate(r.date)],
    ['Giờ ra / vào', [r.comeOutPlanned, r.comeInPlanned].filter(Boolean).join(' → ')],
    ['Lý do', reasonLabel(r.reason) + (r.reasonDetail ? ' — ' + r.reasonDetail : '')]
  ];
  $('lookup-info').innerHTML = kv.map(([k, v]) =>
    '<dt>' + escapeHtml(k) + '</dt><dd class="' + (v ? '' : 'empty') + '">' + escapeHtml(v || 'chưa ghi') + '</dd>').join('');
  $('lookup-timeline').innerHTML = renderStepsHtml(r, names);
  const ready = ['APPROVED', 'OUT', 'COMPLETED'].indexOf(r.status) >= 0;
  toggle($('btn-lookup-pdf'), ready);
  toggle($('lookup-pdf-hint'), !ready && r.status !== 'REJECTED');
  show($('lookup-result'));
}

async function doLookup() {
  hide($('lookup-error'));
  const requestId = $('l-requestid').value.trim().toUpperCase();
  const emplId = $('l-emplid').value.trim();
  document.querySelector('[data-key="lRequestId"]').classList.toggle('is-missing', !requestId);
  document.querySelector('[data-key="lEmplId"]').classList.toggle('is-missing', !emplId);
  if (!requestId || !emplId) return;

  await withBusy($('btn-lookup'), async () => {
    try {
      const data = await callApi('getRequestStatus', { requestId, emplId });
      lastLookup = data;
      renderLookup(data);
    } catch (err) {
      lastLookup = null;
      hide($('lookup-result'));
      const box = $('lookup-error');
      box.textContent = err && err.code === 'NOT_FOUND'
        ? 'Không tìm thấy giấy phép. Kiểm tra lại mã giấy phép và mã nhân viên.'
        : errMessage(err);
      show(box);
    }
  });
}

async function onLookupPdf() {
  if (!lastLookup) return;
  await withBusy($('btn-lookup-pdf'), async () => {
    try {
      await renderGatePassPdf(lastLookup.request, lastLookup.signatures || {}, { approverNames: lastLookup.names || {} });
      toast('Đã tải PDF', 'success');
    } catch (err) {
      toast(errMessage(err), 'error');
    }
  });
}

// ---------------- Tabs ----------------

function activateTab(which) {
  const submit = which === 'submit';
  $('tab-btn-submit').classList.toggle('active', submit);
  $('tab-btn-lookup').classList.toggle('active', !submit);
  $('tab-btn-submit').setAttribute('aria-selected', String(submit));
  $('tab-btn-lookup').setAttribute('aria-selected', String(!submit));
  toggle($('tab-submit'), submit);
  toggle($('tab-lookup'), !submit);
}

export async function initIndexPage() {
  clearStaleSessionData();
  renderMockBanner();

  $('tab-btn-submit').addEventListener('click', () => activateTab('submit'));
  $('tab-btn-lookup').addEventListener('click', () => activateTab('lookup'));

  pad = new SignaturePad($('sig-canvas'));
  pad.onChange = (empty) => {
    toggle($('sig-hint'), empty);
    $('sig-status').textContent = empty ? 'Chưa ký' : '✓ Đã ký';
    $('sig-status').classList.toggle('is-ok', !empty);
    if (!empty) touched.add('signature');
    refreshMissing();
  };
  $('btn-sig-clear').addEventListener('click', () => pad.clear());

  $('f-date').value = todayYmd();
  $('f-dept').addEventListener('change', onDeptChange);
  $('f-dept-other').addEventListener('input', onDeptChange);
  wireTouched();
  $('submit-form').addEventListener('submit', onSubmit);

  $('btn-copy-id').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('success-id').textContent);
      toast('Đã sao chép mã giấy phép', 'success');
    } catch (err) {
      toast('Không sao chép được — hãy ghi lại mã', 'warning');
    }
  });
  $('btn-new-request').addEventListener('click', () => {
    hide($('submit-success'));
    show($('submit-form'));
    window.scrollTo({ top: 0 });
  });
  $('btn-goto-lookup').addEventListener('click', () => {
    if (lastSubmitted) {
      $('l-requestid').value = lastSubmitted.requestId;
      $('l-emplid').value = lastSubmitted.emplId;
    }
    activateTab('lookup');
    doLookup();
  });

  $('lookup-form').addEventListener('submit', (e) => { e.preventDefault(); doLookup(); });
  $('btn-lookup-refresh').addEventListener('click', doLookup);
  $('btn-lookup-pdf').addEventListener('click', onLookupPdf);

  refreshMissing();
  await loadDepartments();
}
