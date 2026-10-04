/**
 * SignaturePad — canvas ký tên dùng chung cho 3 trang (index/security/hr).
 * Hỗ trợ chuột + cảm ứng, tự scale theo devicePixelRatio để nét vẽ rõ trên Retina.
 * Không dùng thư viện ngoài.
 *
 * @example
 *   const pad = new SignaturePad(document.getElementById('sig'));
 *   pad.isEmpty();           // true nếu chưa vẽ gì
 *   pad.toDataUrl(300);      // data URL PNG đã nén, hoặc null nếu trống
 *   pad.clear();
 *   pad.setEnabled(false);   // khóa khi đang submit
 */
export class SignaturePad {
  /**
   * @param {HTMLCanvasElement} canvasEl
   */
  constructor(canvasEl) {
    if (!canvasEl || typeof canvasEl.getContext !== 'function') {
      throw new Error('SignaturePad: cần một phần tử <canvas> hợp lệ');
    }
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.enabled = true;
    this._hasDrawn = false;
    this._drawing = false;
    this._lastX = 0;
    this._lastY = 0;
    /** Callback (tuỳ chọn) gọi sau mỗi nét vẽ / khi xoá — để UI cập nhật trạng thái "đã ký". */
    this.onChange = null;

    this._configureContext();
    this._resizeCanvas();

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);

    this._attachEvents();
    this._attachResizeObserver();
  }

  /**
   * Xóa toàn bộ nét vẽ trên canvas.
   */
  clear() {
    const { width, height } = this.canvas;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.restore();
    this._hasDrawn = false;
    this._drawing = false;
    this._emitChange();
  }

  _emitChange() {
    if (typeof this.onChange === 'function') {
      try { this.onChange(this.isEmpty()); } catch (err) { /* bỏ qua */ }
    }
  }

  /**
   * @returns {boolean} true nếu chưa có nét vẽ nào.
   */
  isEmpty() {
    return this._hasDrawn === false;
  }

  /**
   * Bật/tắt khả năng vẽ (ví dụ khóa khi form đang submit).
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this._drawing = false;
    }
  }

  /**
   * Xuất nội dung canvas thành PNG data URL, thu nhỏ để không vượt quá maxWidthPx.
   * @param {number} [maxWidthPx=300]
   * @returns {string|null} data URL hoặc null nếu canvas trống.
   */
  toDataUrl(maxWidthPx = 300) {
    if (this.isEmpty()) return null;

    const srcW = this.canvas.width;
    const srcH = this.canvas.height;
    if (srcW === 0 || srcH === 0) return null;

    const limit = Number(maxWidthPx) > 0 ? Number(maxWidthPx) : 300;
    const scale = srcW > limit ? limit / srcW : 1;
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    const temp = document.createElement('canvas');
    temp.width = dstW;
    temp.height = dstH;
    const tctx = temp.getContext('2d');
    // Nền trắng để ảnh PNG không trong suốt hoàn toàn khi in.
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, dstW, dstH);
    tctx.drawImage(this.canvas, 0, 0, srcW, srcH, 0, 0, dstW, dstH);

    return temp.toDataURL('image/png');
  }

  // ---------- internal ----------

  _configureContext() {
    const ctx = this.ctx;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1a1a1a';
    ctx.fillStyle = '#1a1a1a';
  }

  _resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 300));
    const cssH = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 150));
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    // Reset transform rồi scale để toạ độ vẽ theo CSS pixel.
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this._configureContext();
  }

  _attachEvents() {
    const c = this.canvas;
    c.addEventListener('mousedown', this._onMouseDown);
    c.addEventListener('mousemove', this._onMouseMove);
    c.addEventListener('mouseup', this._onMouseUp);
    c.addEventListener('mouseleave', this._onMouseLeave);

    c.addEventListener('touchstart', this._onTouchStart, { passive: false });
    c.addEventListener('touchmove', this._onTouchMove, { passive: false });
    c.addEventListener('touchend', this._onTouchEnd, { passive: false });
    c.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
  }

  _attachResizeObserver() {
    // Khi đổi kích thước (xoay màn hình, hiện tab đang ẩn...) giữ lại nét đã ký:
    // chụp nội dung cũ, đổi kích thước canvas rồi vẽ lại co giãn theo kích thước mới.
    const handler = () => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const newW = Math.round(Math.max(1, rect.width) * dpr);
      const newH = Math.round(Math.max(1, rect.height) * dpr);
      if (rect.width < 1 || (newW === this.canvas.width && newH === this.canvas.height)) return;
      let snapshot = null;
      if (this._hasDrawn && this.canvas.width > 0 && this.canvas.height > 0) {
        snapshot = document.createElement('canvas');
        snapshot.width = this.canvas.width;
        snapshot.height = this.canvas.height;
        snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
      }
      this._resizeCanvas();
      if (snapshot) {
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0, this.canvas.width, this.canvas.height);
        this.ctx.restore();
      }
    };
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(handler);
      this._resizeObserver.observe(this.canvas);
    } else {
      this._onWindowResize = handler;
      window.addEventListener('resize', this._onWindowResize);
    }
  }

  _getPosFromMouse(evt) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    };
  }

  _getPosFromTouch(touch) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    };
  }

  _beginStroke(x, y) {
    this._drawing = true;
    this._lastX = x;
    this._lastY = y;
    // Vẽ một điểm nhỏ để tap cũng để lại dấu.
    this.ctx.beginPath();
    this.ctx.arc(x, y, this.ctx.lineWidth / 2, 0, Math.PI * 2);
    this.ctx.fill();
    this._hasDrawn = true;
  }

  _extendStroke(x, y) {
    if (!this._drawing) return;
    this.ctx.beginPath();
    this.ctx.moveTo(this._lastX, this._lastY);
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    this._lastX = x;
    this._lastY = y;
    this._hasDrawn = true;
  }

  _endStroke() {
    const wasDrawing = this._drawing;
    this._drawing = false;
    if (wasDrawing) this._emitChange();
  }

  // ---------- mouse handlers ----------

  _onMouseDown(evt) {
    if (!this.enabled) return;
    evt.preventDefault();
    const { x, y } = this._getPosFromMouse(evt);
    this._beginStroke(x, y);
  }

  _onMouseMove(evt) {
    if (!this.enabled || !this._drawing) return;
    const { x, y } = this._getPosFromMouse(evt);
    this._extendStroke(x, y);
  }

  _onMouseUp() {
    this._endStroke();
  }

  _onMouseLeave() {
    this._endStroke();
  }

  // ---------- touch handlers ----------

  _onTouchStart(evt) {
    if (!this.enabled) return;
    evt.preventDefault();
    const touch = evt.touches && evt.touches[0];
    if (!touch) return;
    const { x, y } = this._getPosFromTouch(touch);
    this._beginStroke(x, y);
  }

  _onTouchMove(evt) {
    if (!this.enabled || !this._drawing) return;
    evt.preventDefault();
    const touch = evt.touches && evt.touches[0];
    if (!touch) return;
    const { x, y } = this._getPosFromTouch(touch);
    this._extendStroke(x, y);
  }

  _onTouchEnd(evt) {
    if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
    this._endStroke();
  }
}
