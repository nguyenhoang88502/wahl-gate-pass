// assets/js/ui.js — Tiện ích giao diện dùng chung cho 3 trang (toast, hộp xác nhận, nhãn,
// định dạng thời gian, nhắc trường còn trống). Không phụ thuộc thư viện ngoài.

export const $ = (id) => document.getElementById(id);

export function show(el) { if (el) el.classList.remove('hidden'); }
export function hide(el) { if (el) el.classList.add('hidden'); }
export function toggle(el, visible) { if (el) el.classList.toggle('hidden', !visible); }

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function errMessage(err) {
  if (err && typeof err.message === 'string' && err.message.trim()) return err.message;
  return 'Có lỗi xảy ra, vui lòng thử lại';
}

// ---------- Nhãn ----------
export const STATUS_LABELS = {
  PENDING_SUP: 'Chờ giám sát',
  PENDING_MGR: 'Chờ trưởng BP',
  PENDING_HR: 'Chờ HR',
  APPROVED: 'Đã duyệt',
  OUT: 'Đang ra ngoài',
  COMPLETED: 'Hoàn tất',
  REJECTED: 'Từ chối'
};

export const REASON_LABELS = {
  PERSONAL: 'Việc riêng',
  ANNUAL_LEAVE: 'Nghỉ phép năm',
  MATERNITY: 'Nghỉ thai sản',
  SICK: 'Nghỉ ốm',
  JOB_ACCIDENT: 'Tai nạn lao động',
  OTHER: 'Khác'
};

export const ROLE_LABELS = {
  admin: 'Quản trị',
  hr: 'Nhân sự (HR)',
  manager: 'Trưởng bộ phận',
  supervisor: 'Giám sát',
  security: 'Bảo vệ'
};

export const USER_STATUS_LABELS = {
  ACTIVE: 'Hoạt động',
  PENDING: 'Chờ kích hoạt',
  LOCKED: 'Đã khoá',
  REJECTED: 'Đã từ chối'
};

export function statusLabel(s) { return STATUS_LABELS[s] || s || ''; }
export function reasonLabel(r) { return REASON_LABELS[r] || r || ''; }
export function roleLabel(r) { return ROLE_LABELS[r] || r || ''; }

export function statusBadge(status) {
  const span = document.createElement('span');
  span.className = 'badge badge--' + String(status || 'none').toLowerCase();
  span.textContent = statusLabel(status) || '—';
  return span;
}

export function statusBadgeHtml(status) {
  return '<span class="badge badge--' + escapeHtml(String(status || 'none').toLowerCase()) + '">' +
    escapeHtml(statusLabel(status) || '—') + '</span>';
}

// ---------- Thời gian ----------
const pad = (n) => String(n).padStart(2, '0');

export function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function formatDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : (ymd || '');
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ---------- Các bước duyệt ----------
/**
 * Dựng danh sách bước duyệt của 1 giấy phép (dùng chung cho tra cứu / HR / bảo vệ).
 * state: 'done' | 'current' | 'rejected' | 'skipped' | 'waiting'
 * names: {username: fullName}
 */
export function approvalSteps(r, names) {
  const nm = (u) => (u ? ((names && names[u]) || u) : '');
  const rejected = r.status === 'REJECTED';
  let rejectedAt = '';
  if (rejected) {
    if (r.supId && !r.supAt) rejectedAt = 'sup';
    else if (r.mgrId && !r.mgrAt) rejectedAt = 'mgr';
    else rejectedAt = 'hr';
  }
  const stopped = { sup: false, mgr: false, hr: false };
  if (rejectedAt === 'sup') { stopped.mgr = true; stopped.hr = true; }
  if (rejectedAt === 'mgr') { stopped.hr = true; }

  const step = (key, title, who, at, pendingStatus, exists) => {
    if (!exists) return { key, title, state: 'skipped', meta: 'Không có — bỏ qua bước này', who: '' };
    if (at) return { key, title, state: 'done', meta: nm(who) + ' · ' + formatDateTime(at), who: nm(who) };
    if (rejectedAt === key) return { key, title, state: 'rejected', meta: 'Từ chối bởi ' + nm(r.rejectedBy) + (r.rejectReason ? ' — ' + r.rejectReason : ''), who: nm(r.rejectedBy) };
    if (stopped[key]) return { key, title, state: 'skipped', meta: 'Dừng do bị từ chối', who: nm(who) };
    if (r.status === pendingStatus) return { key, title, state: 'current', meta: 'Đang chờ ' + (nm(who) || 'duyệt'), who: nm(who) };
    return { key, title, state: 'waiting', meta: who ? 'Sẽ do ' + nm(who) + ' duyệt' : 'Chờ bước trước', who: nm(who) };
  };

  const steps = [
    step('sup', 'Giám sát', r.supId, r.supAt, 'PENDING_SUP', !!r.supId),
    step('mgr', 'Trưởng bộ phận', r.mgrId, r.mgrAt, 'PENDING_MGR', !!r.mgrId),
    step('hr', 'Nhân sự (HR)', r.hrId, r.hrAt, 'PENDING_HR', true)
  ];
  if (rejectedAt === 'hr' && !r.hrAt) steps[2].meta = 'Từ chối bởi ' + nm(r.rejectedBy) + (r.rejectReason ? ' — ' + r.rejectReason : '');
  return steps;
}

export function renderStepsHtml(r, names) {
  const icon = { done: '✓', current: '…', rejected: '✕', skipped: '–', waiting: '' };
  const items = [{ state: 'done', title: 'Gửi giấy phép', meta: (r.fullName || 'Nhân viên') + (r.createdAt ? ' · ' + formatDateTime(r.createdAt) : '') }]
    .concat(approvalSteps(r, names));
  if (r.guardOutAt) items.push({ state: 'done', title: 'Đã ra cổng', meta: formatDateTime(r.guardOutAt) });
  if (r.guardInAt) items.push({ state: 'done', title: 'Đã vào lại', meta: formatDateTime(r.guardInAt) });
  return '<ol class="steps">' + items.map((s, i) =>
    '<li class="step step--' + s.state + '"><span class="step__dot">' + (icon[s.state] || (i + 1)) + '</span>' +
    '<div><div class="step__title">' + escapeHtml(s.title) + '</div>' +
    '<div class="step__meta">' + escapeHtml(s.meta || '') + '</div></div></li>'
  ).join('') + '</ol>';
}

// ---------- Toast ----------
function toastHost() {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/** type: 'success' | 'error' | 'info' | 'warning' */
export function toast(message, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast toast--' + type;
  el.textContent = message;
  toastHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  setTimeout(() => {
    el.classList.remove('toast--in');
    setTimeout(() => el.remove(), 250);
  }, type === 'error' ? Math.max(ms, 5000) : ms);
}

// ---------- Hộp thoại ----------
/**
 * Hộp thoại tuỳ biến (thay alert/confirm/prompt của trình duyệt).
 * opts: {title, message, html, confirmText, cancelText, danger, input: {label, placeholder, required, multiline}}
 * Trả về Promise<false | true | string>.
 */
export function dialog(opts) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay dialog';
    const inputHtml = opts.input
      ? '<label class="field"><span class="field__label">' + escapeHtml(opts.input.label || '') + '</span>' +
        (opts.input.multiline
          ? '<textarea class="dialog__input" rows="3" placeholder="' + escapeHtml(opts.input.placeholder || '') + '"></textarea>'
          : '<input class="dialog__input" type="text" placeholder="' + escapeHtml(opts.input.placeholder || '') + '">') +
        '<span class="field__hint field__hint--error hidden">Vui lòng nhập nội dung</span></label>'
      : '';
    overlay.innerHTML =
      '<div class="modal modal--sm" role="dialog" aria-modal="true">' +
      '<div class="modal-header"><h3>' + escapeHtml(opts.title || 'Xác nhận') + '</h3></div>' +
      '<div class="modal-body">' +
      (opts.html || (opts.message ? '<p>' + escapeHtml(opts.message) + '</p>' : '')) + inputHtml +
      '</div>' +
      '<div class="modal-footer">' +
      (opts.cancelText === null ? '' : '<button type="button" class="btn btn-ghost" data-act="cancel">' + escapeHtml(opts.cancelText || 'Huỷ') + '</button>') +
      '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok">' + escapeHtml(opts.confirmText || 'Đồng ý') + '</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.dialog__input');
    const okBtn = overlay.querySelector('[data-act="ok"]');
    (input || okBtn).focus();

    function close(val) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }
    function ok() {
      if (input) {
        const v = input.value.trim();
        if (opts.input.required && !v) {
          input.classList.add('is-missing');
          show(overlay.querySelector('.field__hint--error'));
          input.focus();
          return;
        }
        close(v);
      } else {
        close(true);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && !(input && input.tagName === 'TEXTAREA')) ok();
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'ok') ok(); else close(false);
    });
  });
}

export const confirmDialog = (message, opts = {}) => dialog(Object.assign({ message }, opts));

// ---------- Nút đang xử lý ----------
/** Chạy fn trong khi nút hiển thị trạng thái đang xử lý (chống bấm 2 lần). */
export async function withBusy(btn, fn) {
  if (btn && btn.disabled) return undefined;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    return await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

// ---------- Nhắc trường còn trống (không bắt buộc) ----------
/**
 * Tô đỏ các trường đang trống để NHẮC người dùng — không chặn gửi.
 * fields: [{el, isEmpty?: () => boolean, container?: Element}]
 * Trả về số trường còn trống.
 */
export function markMissing(fields) {
  let count = 0;
  fields.forEach((f) => {
    if (!f || !f.el) return;
    const empty = f.isEmpty ? f.isEmpty() : !String(f.el.value || '').trim();
    const target = f.container || f.el.closest('.field') || f.el;
    target.classList.toggle('is-missing', empty);
    if (empty) count++;
  });
  return count;
}

/** Gắn sự kiện để trạng thái "còn trống" cập nhật ngay khi người dùng nhập. */
export function liveMissing(fields, onChange) {
  const run = () => {
    const n = markMissing(fields);
    if (onChange) onChange(n);
  };
  fields.forEach((f) => {
    if (!f || !f.el) return;
    const evts = f.events || ['input', 'change'];
    evts.forEach((ev) => f.el.addEventListener(ev, run));
  });
  return run;
}
