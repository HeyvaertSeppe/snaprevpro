/* Client: shows the remote page full-screen and sends input. No UI of its own. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const canvas = $('#screen');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const overlay = $('#overlay');
  const statusText = $('#status-text');
  const kbd = $('#kbd');

  const MSG = { FRAME: 1, AUDIO: 2, VIDEO: 3, CAM: 0x10, MIC: 0x11 };
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const isTouch = matchMedia('(pointer: coarse)').matches;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  let soundOn = store.get('sound', true);
  let predictOn = store.get('predict', true);
  let statsOn = false;

  let ws = null;
  let retry = 0;
  let vp = { w: 0, h: 0 }; // remote viewport, CSS px
  let ready = false;
  let hasFrame = false;
  let mode = 'video';

  // ------------------------------------------------------------ small UI

  function showOverlay(text) { statusText.textContent = text; overlay.classList.remove('hidden'); }
  function hideOverlay() { overlay.classList.add('hidden'); }

  let toastTimer;
  function toast(text, ms = 2200, onClick) {
    const t = $('#toast');
    t.textContent = text;
    t.onclick = onClick || null;
    t.style.cursor = onClick ? 'pointer' : '';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  let modalOpen = false;
  let closeModal = null;
  function modal({ text, input, defaultValue = '', ok = 'OK', cancel = 'Cancel', noCancel = false }) {
    return new Promise((resolve) => {
      const m = $('#modal');
      const inp = $('#modal-input');
      $('#modal-text').textContent = text;
      inp.hidden = !input;
      inp.value = defaultValue;
      $('#modal-ok').textContent = ok;
      $('#modal-cancel').textContent = cancel;
      $('#modal-cancel').hidden = noCancel;
      m.hidden = false;
      modalOpen = true;
      if (input) setTimeout(() => { inp.focus(); inp.select(); }, 30);
      const done = (accept) => {
        m.hidden = true;
        modalOpen = false;
        $('#modal-ok').onclick = $('#modal-cancel').onclick = null;
        inp.onkeydown = null;
        resolve({ accept, value: inp.value });
      };
      $('#modal-ok').onclick = () => done(true);
      $('#modal-cancel').onclick = () => done(false);
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      closeModal = done;
    });
  }

  // ------------------------------------------------------------ layout

  const dpr = () => window.devicePixelRatio || 1;
  function wanted() {
    return { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight), dsf: dpr() };
  }

  function layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (!vp.w || !vp.h) { canvas.style.width = `${W}px`; canvas.style.height = `${H}px`; return; }
    // Normally vp == window size (1:1). If the server had to clamp it, scale to fit.
    const s = Math.min(1, W / vp.w, H / vp.h);
    canvas.style.width = `${vp.w * s}px`;
    canvas.style.height = `${vp.h * s}px`;
  }

  let resizeTimer;
  function onResize() {
    layout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => sendJSON({ t: 'resize', ...wanted() }), 120);
  }
  window.addEventListener('resize', onResize);

  // ------------------------------------------------------------ video (H.264 via WebCodecs)

  let codec = null;
  let decoder = null;
  let waitKey = true;
  let ts = 0;
  let lastSlow = 0;
  let decodeMs = 0;
  let framesDrawn = 0;
  const decStart = new Map();

  async function detectVideo() {
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) return false;
    for (const c of ['avc1.640033', 'avc1.64002A', 'avc1.4D0033', 'avc1.42E033', 'avc1.42E01F']) {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec: c, optimizeForLatency: true });
        if (r.supported) { codec = c; return true; }
      } catch { /* try next */ }
    }
    return false;
  }

  function resetDecoder() {
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch { /* ignore */ } }
    decoder = null;
    waitKey = true;
  }

  function makeDecoder() {
    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        const started = decStart.get(frame.timestamp);
        if (started !== undefined) {
          decStart.delete(frame.timestamp);
          decodeMs = decodeMs ? decodeMs * 0.9 + (performance.now() - started) * 0.1 : performance.now() - started;
        }
        frame.close();
        framesDrawn++;
        applyPreviewUpdates();
        if (!hasFrame) { hasFrame = true; if (ready) hideOverlay(); }
      },
      error: () => { resetDecoder(); sendJSON({ t: 'keyframe' }); },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  }

  function onVideo(data) {
    const key = (data[1] & 1) === 1;
    if (waitKey && !key) return;
    if (!decoder || decoder.state === 'closed') makeDecoder();
    // Only when decoding really falls behind: ask for a lower frame rate; if it
    // is very far behind, skip ahead to a fresh key frame instead of lagging.
    if (decoder.decodeQueueSize > 3 && decodeMs > 60) {
      const now = performance.now();
      if (now - lastSlow > 5000) { lastSlow = now; sendJSON({ t: 'slow' }); }
    }
    if (!key && decoder.decodeQueueSize > 30) { waitKey = true; sendJSON({ t: 'keyframe' }); return; }
    try {
      ts += 16667;
      decStart.set(ts, performance.now());
      if (decStart.size > 200) decStart.clear();
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: data.subarray(2) }));
      waitKey = false;
    } catch {
      resetDecoder();
      sendJSON({ t: 'keyframe' });
    }
  }

  // ------------------------------------------------------------ JPEG fallback

  let pendingJpeg = null;
  let decodingJpeg = false;
  async function drawJpeg() {
    const jpeg = pendingJpeg;
    pendingJpeg = null;
    if (!jpeg) return;
    decodingJpeg = true;
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      framesDrawn++;
      applyPreviewUpdates();
      if (!hasFrame) { hasFrame = true; if (ready) hideOverlay(); }
    } catch { /* corrupt frame */ }
    decodingJpeg = false;
    if (pendingJpeg) drawJpeg();
  }

  // ------------------------------------------------------------ connection

  function sendJSON(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // Fallback when a proxy blocks WebSockets: same API as a WebSocket, but
  // a long HTTP response carries server→client data and POSTs carry the rest.
  class HttpTransport {
    constructor(query) {
      this.key = query.get('k') || '';
      this.readyState = 0;
      this.queue = [];
      this.queued = 0;
      this.inflight = 0;
      this.id = null;
      this.code = 1006;
      this.ctrl = new AbortController();
      this._run(query);
    }

    get bufferedAmount() { return this.queued + this.inflight; }

    async _run(query) {
      try {
        const res = await fetch(`/stream?${query}`, { cache: 'no-store', credentials: 'same-origin', signal: this.ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf); merged.set(value, buf.length);
          buf = merged;
          let o = 0;
          while (o + 5 <= buf.length) {
            const len = ((buf[o + 1] << 24) >>> 0) + (buf[o + 2] << 16) + (buf[o + 3] << 8) + buf[o + 4];
            if (o + 5 + len > buf.length) break;
            const type = buf[o];
            const payload = buf.slice(o + 5, o + 5 + len);
            o += 5 + len;
            if (type === 0) {
              const text = new TextDecoder().decode(payload);
              const m = JSON.parse(text);
              if (m.t === 'conn') { this.id = m.id; this.readyState = 1; if (this.onopen) this.onopen(); }
              else if (m.t === 'close') this.code = m.code;
              else if (this.onmessage) this.onmessage({ data: text });
            } else if (type === 1 && this.onmessage) {
              this.onmessage({ data: payload.buffer });
            }
          }
          buf = buf.slice(o);
        }
      } catch { /* closed or failed */ }
      this._closed();
    }

    send(data) {
      if (this.readyState !== 1) return;
      const payload = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
      const f = new Uint8Array(5 + payload.length);
      f[0] = typeof data === 'string' ? 0 : 1;
      new DataView(f.buffer).setUint32(1, payload.length);
      f.set(payload, 5);
      this.queue.push(f);
      this.queued += f.length;
      this._flush();
    }

    // One POST in flight at a time; everything sent meanwhile goes in the next one.
    async _flush() {
      if (this.inflight || !this.queue.length || this.readyState !== 1) return;
      const body = new Blob(this.queue);
      this.inflight = this.queued;
      this.queue = [];
      this.queued = 0;
      try {
        const res = await fetch(`/send?id=${this.id}&k=${encodeURIComponent(this.key)}`, { method: 'POST', body, credentials: 'same-origin', cache: 'no-store' });
        if (res.status === 410) this.close();
      } catch { /* the stream will notice */ }
      this.inflight = 0;
      this._flush();
    }

    close() { this.ctrl.abort(); this._closed(); }

    _closed() {
      if (this.readyState === 3) return;
      const opened = this.readyState === 1;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: this.code, opened });
    }
  }

  // Transport choice: WebSocket first; if it can't connect twice (proxy
  // without WebSocket support), use HTTP streaming for this page load.
  let wsFailures = 0;

  function connect() {
    const w = wanted();
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    const keyMeta = document.querySelector('meta[name="rb-key"]');
    const q = new URLSearchParams({ w: w.w, h: w.h, dsf: w.dsf, lang: navigator.language || 'en-US', tz, mode, touch: isTouch ? 1 : 0, k: keyMeta ? keyMeta.content : '' });
    const useHttp = wsFailures >= 2;
    let opened = false;
    if (useHttp) {
      ws = new HttpTransport(q);
    } else {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
      ws.binaryType = 'arraybuffer';
    }
    const thisWs = ws;
    ws.onopen = () => {
      opened = true;
      window.__transport = useHttp ? 'http-stream' : 'websocket';
      retry = 0;
      if (!useHttp) wsFailures = 0;
      sendJSON({ t: 'resize', ...wanted() });
      sendJSON({ t: 'audio', on: soundOn });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') { onJSON(JSON.parse(e.data)); return; }
      const data = new Uint8Array(e.data);
      if (data[0] === MSG.VIDEO) onVideo(data);
      else if (data[0] === MSG.FRAME) { pendingJpeg = data.subarray(1); if (!decodingJpeg) drawJpeg(); }
      else if (data[0] === MSG.AUDIO) playAudio(data.subarray(1));
    };
    ws.onclose = (e) => {
      if (thisWs !== ws) return;
      if (!opened && !useHttp) wsFailures++;
      ready = false;
      resetDecoder();
      stopCamera();
      stopMic();
      if (e.code === 4001) {
        showOverlay('The server is full right now. Retrying in 30 seconds…');
        setTimeout(connect, 30000);
        return;
      }
      if (e.code === 4000) showOverlay('Restarting…');
      else if (!navigator.onLine) showOverlay('No internet connection. Waiting…');
      else if (retry >= 4 && !opened) showOverlay('Can\'t reach the server. Retrying…');
      else showOverlay('Reconnecting…');
      setTimeout(connect, e.code === 4000 ? 800 : (!opened && !useHttp && wsFailures < 2) ? 300 : Math.min(8000, 400 * 2 ** retry++));
    };
  }

  const CURSORS = new Set(['default', 'pointer', 'text', 'move', 'grab', 'grabbing', 'not-allowed', 'wait', 'progress', 'crosshair',
    'help', 'zoom-in', 'zoom-out', 'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
    'n-resize', 's-resize', 'e-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'copy', 'alias',
    'cell', 'vertical-text', 'context-menu', 'all-scroll', 'none']);

  let remoteEditable = false;

  function onJSON(m) {
    switch (m.t) {
      case 'status':
        if (m.state === 'ready') { ready = true; if (hasFrame) hideOverlay(); else showOverlay('Loading…'); }
        else if (m.state === 'starting') showOverlay('Starting…');
        else showOverlay(m.message || m.state);
        break;
      case 'viewport': vp = { w: m.w, h: m.h }; layout(); break;
      case 'video': resetDecoder(); break; // new stream: wait for its key frame
      case 'cursor': canvas.style.cursor = CURSORS.has(m.c) ? m.c : 'default'; break;
      case 'focus':
        remoteEditable = m.editable;
        if (!m.editable) { preds = []; renderPreview(); }
        if (isTouch) {
          if (m.editable) kbd.focus({ preventScroll: true });
          else if (document.activeElement === kbd) kbd.blur();
        }
        break;
      case 'popup': $('#closepopup').hidden = !m.open; break;
      case 'caret': pendingCaret = m.c; if (!preds.length) applyPreviewUpdates(); break;
      case 'ack': pendingAck = Math.max(pendingAck, m.seq); break;
      case 'pong': lastRtt = performance.now() - m.c; serverFps = m.fps; transportName = m.transport; break;
      case 'clip': copyToClipboard(m.text); break;
      case 'open': openExternal(m.url); break;
      case 'cam': if (m.on) startCamera(); else stopCamera(); break;
      case 'mic': if (m.on) startMic(); else stopMic(); break;
      case 'dialog': handleDialog(m); break;
      case 'dialog-closed': if (dialogId === m.id && closeModal) closeModal(false); break;
      case 'filechooser': handleFileChooser(m); break;
      case 'filechooser-closed': if (chooserId === m.id && closeModal) closeModal(false); break;
      case 'download': {
        const a = document.createElement('a');
        a.href = m.url; a.download = m.name || '';
        document.body.appendChild(a); a.click(); a.remove();
        break;
      }
      case 'editable': if (m.on && isTouch) kbd.focus({ preventScroll: true }); break;
      default: break;
    }
  }

  function openExternal(url) {
    if (!/^https?:\/\//i.test(url)) return;
    const w = window.open(url, '_blank', 'noopener');
    if (!w) toast('Tap here to open the link', 6000, () => window.open(url, '_blank', 'noopener'));
  }

  // ------------------------------------------------------------ mouse / touch

  function pos(e) {
    if (!vp.w || !vp.h) vp = { w: wanted().w, h: wanted().h };
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(vp.w - 1, ((e.clientX - r.left) / r.width) * vp.w)),
      y: Math.max(0, Math.min(vp.h - 1, ((e.clientY - r.top) / r.height) * vp.h)),
    };
  }
  const cssScale = () => vp.h / canvas.getBoundingClientRect().height || 1;

  function mods(e) {
    let m = 0;
    if (e.altKey) m |= 1;
    if (e.ctrlKey || (isMac && e.metaKey)) m |= 2; // Cmd on Mac acts as Ctrl remotely (Linux)
    if (e.metaKey && !isMac) m |= 4;
    if (e.shiftKey) m |= 8;
    return m;
  }
  const BTN = ['left', 'middle', 'right', 'back', 'forward'];

  const lastClick = { t: 0, x: 0, y: 0, n: 0, b: -1 };
  function clickCount(p, button) {
    const now = performance.now();
    const near = Math.abs(p.x - lastClick.x) < 6 && Math.abs(p.y - lastClick.y) < 6;
    lastClick.n = now - lastClick.t < 450 && near && lastClick.b === button ? lastClick.n + 1 : 1;
    Object.assign(lastClick, { t: now, x: p.x, y: p.y, b: button });
    return lastClick.n;
  }

  let moveQueued = null;
  function flushMove() { if (moveQueued) sendJSON(moveQueued); moveQueued = null; }

  // touch: tap = click, drag = scroll (with momentum), long-press = right click,
  // three-finger tap = menu
  let touch = null;
  let fingers = 0;
  let fling = null;

  function stopFling() { if (fling) { cancelAnimationFrame(fling.raf); fling = null; } }
  function startFling(p, vx, vy) {
    stopFling();
    let last = performance.now();
    fling = { vx, vy };
    const step = (now) => {
      if (!fling) return;
      const dt = now - last; last = now;
      const decay = Math.pow(0.996, dt);
      fling.vx *= decay; fling.vy *= decay;
      if (Math.abs(fling.vx) < 0.02 && Math.abs(fling.vy) < 0.02) { fling = null; return; }
      sendJSON({ t: 'wheel', ...p, dx: fling.vx * dt, dy: fling.vy * dt, mods: 0 });
      fling.raf = requestAnimationFrame(step);
    };
    fling.raf = requestAnimationFrame(step);
  }

  canvas.addEventListener('pointerdown', (e) => {
    unlockAudio();
    if (e.pointerType === 'touch') {
      e.preventDefault();
      fingers++;
      if (fingers === 3) { if (touch) clearTimeout(touch.timer); touch = null; openMenu(); return; }
      if (touch) { clearTimeout(touch.timer); touch.multi = true; return; }
      stopFling();
      const p = pos(e);
      touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, p, scrolling: false, long: false, samples: [] };
      touch.timer = setTimeout(() => {
        if (!touch || touch.scrolling || touch.multi) return;
        touch.long = true;
        sendJSON({ t: 'mouse', type: 'move', ...touch.p, button: 'none', buttons: 0, clickCount: 0, mods: 0 });
        sendJSON({ t: 'mouse', type: 'down', ...touch.p, button: 'right', buttons: 2, clickCount: 1, mods: 0 });
        sendJSON({ t: 'mouse', type: 'up', ...touch.p, button: 'right', buttons: 0, clickCount: 1, mods: 0 });
      }, 550);
      return;
    }
    e.preventDefault();
    if (preds.length) { preds = []; renderPreview(); }
    // Keep the hidden textarea focused so IME, dead keys, emoji pickers and paste work.
    if (document.activeElement !== kbd) kbd.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    flushMove();
    const p = pos(e);
    sendJSON({ t: 'mouse', type: 'down', ...p, button: BTN[e.button] || 'left', buttons: e.buttons, clickCount: clickCount(p, e.button), mods: mods(e) });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (!touch || e.pointerId !== touch.id || touch.multi) return;
      e.preventDefault();
      if (!touch.scrolling && Math.hypot(e.clientX - touch.sx, e.clientY - touch.sy) > 8) {
        touch.scrolling = true;
        clearTimeout(touch.timer);
      }
      if (touch.scrolling) {
        const s = cssScale();
        const dx = (touch.lx - e.clientX) * s;
        const dy = (touch.ly - e.clientY) * s;
        touch.lx = e.clientX; touch.ly = e.clientY;
        const now = performance.now();
        touch.samples.push({ t: now, dx, dy });
        while (touch.samples.length && now - touch.samples[0].t > 100) touch.samples.shift();
        sendJSON({ t: 'wheel', ...touch.p, dx, dy, mods: 0 });
      }
      return;
    }
    const p = pos(e);
    const b = e.buttons;
    const button = b & 1 ? 'left' : b & 2 ? 'right' : b & 4 ? 'middle' : 'none';
    const first = !moveQueued;
    moveQueued = { t: 'mouse', type: 'move', ...p, button, buttons: b, clickCount: 0, mods: mods(e) };
    if (first) requestAnimationFrame(flushMove);
  });

  const pointerUp = (e) => {
    if (e.pointerType === 'touch') {
      fingers = Math.max(0, fingers - 1);
      if (!touch || e.pointerId !== touch.id) return;
      e.preventDefault();
      clearTimeout(touch.timer);
      if (touch.scrolling && touch.samples.length > 1) {
        // momentum, like native scrolling
        const span = touch.samples[touch.samples.length - 1].t - touch.samples[0].t || 16;
        const sx = touch.samples.reduce((a, s) => a + s.dx, 0);
        const sy = touch.samples.reduce((a, s) => a + s.dy, 0);
        if (Math.hypot(sx, sy) / span > 0.3) startFling(touch.p, sx / span, sy / span);
      } else if (!touch.scrolling && !touch.long && !touch.multi && e.type === 'pointerup') {
        const p = touch.p;
        const n = clickCount(p, 0);
        sendJSON({ t: 'mouse', type: 'move', ...p, button: 'none', buttons: 0, clickCount: 0, mods: 0 });
        sendJSON({ t: 'mouse', type: 'down', ...p, button: 'left', buttons: 1, clickCount: n, mods: 0 });
        sendJSON({ t: 'mouse', type: 'up', ...p, button: 'left', buttons: 0, clickCount: n, mods: 0 });
        // iPhone/iPad only open the keyboard from inside a tap handler: if a text
        // field already has focus remotely, open it now; otherwise ask.
        if (remoteEditable) kbd.focus({ preventScroll: true });
        setTimeout(() => sendJSON({ t: 'editable' }), 200);
      }
      touch = null;
      return;
    }
    if (e.type !== 'pointerup') return;
    flushMove();
    const p = pos(e);
    sendJSON({ t: 'mouse', type: 'up', ...p, button: BTN[e.button] || 'left', buttons: e.buttons, clickCount: lastClick.n || 1, mods: mods(e) });
  };
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? vp.h : 1;
    sendJSON({ t: 'wheel', ...pos(e), dx: e.deltaX * k, dy: e.deltaY * k, mods: mods(e) });
  }, { passive: false });

  // ------------------------------------------------------------ keyboard

  function keyMsg(e, type) {
    return { t: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, location: e.location, repeat: e.repeat, mods: mods(e) };
  }
  const isPrintable = (e) => [...(e.key || '')].length === 1;
  const ignoredKey = (e) => e.isComposing || e.keyCode === 229 || e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified';

  window.addEventListener('keydown', (e) => {
    if (modalOpen) return;
    unlockAudio();
    if (e.ctrlKey && e.altKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); openMenu(); return; }
    if (!$('#menu').hidden) { if (e.key === 'Escape') closeMenu(); return; }
    if (ignoredKey(e)) return;
    const cmd = e.ctrlKey || e.metaKey;
    if (cmd && !e.altKey && (e.key === 'v' || e.key === 'V')) return; // real paste event below
    if (isTouch && e.target === kbd && isPrintable(e) && !cmd) return; // soft keyboard: input events
    if (e.key === 'F11' || e.key === 'F12') return;
    e.preventDefault();
    const msg = keyMsg(e, 'down');
    msg.seq = ++seq;
    sendJSON(msg);
    const altGr = e.ctrlKey && e.altKey;
    if (isPrintable(e) && (!cmd || altGr)) predict(e.key, msg.seq);
    else if (e.key === 'Backspace' && preds.length) { preds.pop(); renderPreview(); }
  });
  window.addEventListener('keyup', (e) => {
    if (modalOpen || !$('#menu').hidden) return;
    if (ignoredKey(e)) return;
    if (isTouch && e.target === kbd && isPrintable(e) && !(e.ctrlKey || e.metaKey)) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) return;
    e.preventDefault();
    sendJSON(keyMsg(e, 'up'));
  });

  window.addEventListener('paste', (e) => {
    if (modalOpen) return;
    e.preventDefault();
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text) sendJSON({ t: 'text', text });
  });

  // Soft keyboards / IME / emoji pickers type into the hidden textarea.
  const SENTINEL = '​​';
  let composing = false;
  function resetKbd() { kbd.value = SENTINEL; kbd.setSelectionRange(SENTINEL.length, SENTINEL.length); }
  function sendKey(key, code, keyCode) {
    sendJSON({ t: 'key', type: 'down', key, code, keyCode, location: 0, repeat: false, mods: 0 });
    sendJSON({ t: 'key', type: 'up', key, code, keyCode, location: 0, repeat: false, mods: 0 });
  }
  function flushKbd() {
    const v = kbd.value;
    if (v.startsWith(SENTINEL)) {
      const parts = v.slice(SENTINEL.length).split('\n');
      parts.forEach((part, i) => {
        if (part) { const n = ++seq; sendJSON({ t: 'text', text: part, seq: n }); predict(part, n); }
        if (i < parts.length - 1) sendKey('Enter', 'Enter', 13);
      });
    } else {
      let removed = SENTINEL.length - v.length;
      if (removed <= 0) removed = 1;
      for (let i = 0; i < removed; i++) { sendKey('Backspace', 'Backspace', 8); if (preds.length) preds.pop(); }
      renderPreview();
    }
    resetKbd();
  }
  kbd.addEventListener('focus', resetKbd);
  kbd.addEventListener('compositionstart', () => { composing = true; });
  kbd.addEventListener('compositionend', () => { composing = false; setTimeout(flushKbd, 0); });
  kbd.addEventListener('input', () => { if (!composing) flushKbd(); });
  resetKbd();

  // ------------------------------------------------------------ instant typing preview
  // Typed letters appear at the remote caret right away (in the field's own
  // font and colour) and are removed once a video frame containing them arrives.

  let seq = 0;
  let preds = []; // [{ seq, text }]
  let caret = null; // { x, y, h, font, ls, color, bg, len } in remote CSS px
  let pendingCaret;
  let pendingAck = 0;
  let anchorLen = null;
  const predictEl = $('#predict');

  function predict(text, n) {
    if (!predictOn || !remoteEditable || !caret) return;
    if (!preds.length) anchorLen = caret.len;
    preds.push({ seq: n, text });
    renderPreview();
  }

  // Called after each drawn video frame, so the preview only disappears once
  // the real text is on screen.
  function applyPreviewUpdates() {
    let changed = false;
    if (pendingAck) {
      const before = preds.length;
      preds = preds.filter((p) => p.seq > pendingAck);
      pendingAck = 0;
      changed = changed || before !== preds.length;
    }
    if (pendingCaret !== undefined) {
      const c = pendingCaret;
      pendingCaret = undefined;
      // letters already in the field (caret moved past them) are no longer predictions
      if (c && preds.length && anchorLen != null && c.len != null && c.len > anchorLen) {
        let drop = c.len - anchorLen;
        while (drop > 0 && preds.length) {
          const first = preds[0];
          if (first.text.length <= drop) { drop -= first.text.length; preds.shift(); } else { first.text = first.text.slice(drop); drop = 0; }
        }
      }
      caret = c;
      anchorLen = c ? c.len : null;
      changed = true;
    }
    if (!preds.length) anchorLen = caret ? caret.len : null;
    if (changed) renderPreview();
  }

  function renderPreview() {
    if (!preds.length || !caret || !predictOn) { predictEl.hidden = true; return; }
    const r = canvas.getBoundingClientRect();
    const k = vp.w ? r.width / vp.w : 1;
    const st = predictEl.style;
    st.left = `${r.left + caret.x * k}px`;
    st.top = `${r.top + caret.y * k}px`;
    st.font = caret.font;
    if (k !== 1) st.fontSize = `${parseFloat(getComputedStyle(predictEl).fontSize) * k}px`;
    st.letterSpacing = caret.ls && caret.ls !== 'normal' ? caret.ls : '';
    st.lineHeight = `${caret.h * k}px`;
    st.height = `${caret.h * k}px`;
    st.color = caret.color;
    st.background = caret.bg;
    predictEl.textContent = preds.map((p) => p.text).join('');
    predictEl.hidden = false;
  }

  // ------------------------------------------------------------ connection info

  let lastRtt = 0;
  let serverFps = 0;
  let transportName = '';
  let lastFrames = 0;
  setInterval(() => {
    if (!statsOn) return;
    sendJSON({ t: 'ping', c: performance.now() });
    const fps = framesDrawn - lastFrames;
    lastFrames = framesDrawn;
    $('#stats').textContent =
      `round trip  ${lastRtt ? Math.round(lastRtt) + ' ms' : '…'}\n` +
      `video       ${fps} fps (server max ${serverFps || '?'})\n` +
      `decode      ${mode === 'video' ? Math.round(decodeMs) + ' ms' : 'JPEG mode'}\n` +
      `picture     ${canvas.width}×${canvas.height}\n` +
      `connection  ${transportName === 'http' ? 'HTTP stream (proxy blocks WebSockets)' : transportName ? 'WebSocket' : '…'}`;
  }, 1000);

  // ------------------------------------------------------------ popups + back button

  $('#closepopup').addEventListener('click', () => sendJSON({ t: 'closepopup' }));
  // The device/browser back button acts inside the remote page instead of leaving the site.
  history.pushState({ rb: 1 }, '');
  window.addEventListener('popstate', () => {
    sendJSON({ t: 'back' });
    history.pushState({ rb: 1 }, '');
  });

  // ------------------------------------------------------------ hidden menu

  function openMenu() {
    $('#menu [data-act="sound"]').textContent = `Sound: ${soundOn ? 'on' : 'off'}`;
    $('#menu [data-act="predict"]').textContent = `Instant typing preview: ${predictOn ? 'on' : 'off'}`;
    $('#menu [data-act="stats"]').textContent = `Connection info: ${statsOn ? 'on' : 'off'}`;
    $('#menu').hidden = false;
  }
  function closeMenu() { $('#menu').hidden = true; }
  if (location.hash === '#menu') { history.replaceState(null, '', location.pathname); setTimeout(openMenu, 500); }

  $('#menu').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    closeMenu();
    if (act === 'predict') {
      predictOn = !predictOn;
      store.set('predict', predictOn);
      if (!predictOn) { preds = []; renderPreview(); }
      toast(`Instant typing preview ${predictOn ? 'on' : 'off'}`);
    } else if (act === 'stats') {
      statsOn = !statsOn;
      $('#stats').hidden = !statsOn;
      if (statsOn) { $('#stats').textContent = 'measuring…'; sendJSON({ t: 'ping', c: performance.now() }); }
    } else if (act === 'sound') {
      soundOn = !soundOn;
      store.set('sound', soundOn);
      sendJSON({ t: 'audio', on: soundOn });
      toast(`Sound ${soundOn ? 'on' : 'off'}`);
    } else if (act === 'restart') {
      const r = await modal({ text: 'Restart your browser? You stay logged in.', ok: 'Restart' });
      if (r.accept) sendJSON({ t: 'restart' });
    } else if (act === 'link') {
      try {
        const res = await fetch('/api/link', { credentials: 'same-origin' });
        const { path } = await res.json();
        const url = location.origin + path;
        const r = await modal({
          text: 'Open this link on another device to use this same session (and stay logged in there).\n\nAnyone with this link can use your account. Do not share it.',
          input: true, defaultValue: url, ok: 'Copy link', cancel: 'Close',
        });
        if (r.accept) copyToClipboard(url);
      } catch { toast('Could not create link'); }
    }
  });

  // ------------------------------------------------------------ clipboard

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast('Tap here to copy the text', 6000, async () => {
        try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy blocked by your browser'); }
      });
    }
  }

  // ------------------------------------------------------------ dialogs / files

  let dialogId = null;
  async function handleDialog(m) {
    dialogId = m.id;
    const r = await modal({ text: m.message || '', input: m.type === 'prompt', defaultValue: m.defaultPrompt, noCancel: m.type === 'alert' });
    if (dialogId === m.id) sendJSON({ t: 'dialog', id: m.id, accept: r.accept || m.type === 'alert', text: r.value });
    dialogId = null;
  }

  let chooserId = null;
  async function handleFileChooser(m) {
    chooserId = m.id;
    const r = await modal({ text: 'Choose a file from your device.', ok: m.multiple ? 'Choose files' : 'Choose file' });
    if (chooserId !== m.id) return;
    if (!r.accept) { sendJSON({ t: 'files', id: m.id, files: [] }); chooserId = null; return; }
    const pick = $('#filepick');
    pick.multiple = !!m.multiple;
    pick.value = '';
    pick.onchange = async () => {
      const files = [...pick.files];
      if (!files.length) { sendJSON({ t: 'files', id: m.id, files: [] }); return; }
      toast(`Uploading ${files.length} file(s)…`, 60000);
      try {
        const ids = [];
        for (const f of files) {
          // 512 KB chunks: passes proxies with small upload limits
          const CHUNK = 512 * 1024;
          const upId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
          const total = Math.max(1, Math.ceil(f.size / CHUNK));
          let result = null;
          for (let i = 0; i < total; i++) {
            const res = await fetch('/upload', {
              method: 'POST', body: f.slice(i * CHUNK, (i + 1) * CHUNK), credentials: 'same-origin',
              headers: { 'X-Filename': encodeURIComponent(f.name), 'X-Upload-Id': upId, 'X-Chunk': String(i), 'X-Last': i === total - 1 ? '1' : '0' },
            });
            if (!res.ok) throw new Error(await res.text());
            result = await res.json();
          }
          ids.push(result.id);
        }
        sendJSON({ t: 'files', id: m.id, files: ids });
        toast('Uploaded');
      } catch (err) {
        toast(`Upload failed: ${err.message}`);
        sendJSON({ t: 'files', id: m.id, files: [] });
      }
      chooserId = null;
    };
    pick.click();
  }

  // ------------------------------------------------------------ sound out

  let actx = null;
  let nextTime = 0;
  function unlockAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC({ latencyHint: 'interactive' });
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  }
  function playAudio(bytes) {
    if (!actx || !soundOn || actx.state !== 'running') return;
    const n = bytes.byteLength >> 1;
    if (!n) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const buf = actx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const now = actx.currentTime;
    if (nextTime < now + 0.02) nextTime = now + 0.06;
    if (nextTime > now + 0.4) return; // too far behind: drop to keep latency low
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(actx.destination);
    src.start(nextTime);
    nextTime += buf.duration;
  }

  // ------------------------------------------------------------ camera in

  let cam = null;
  async function startCamera() {
    if (cam) return;
    cam = { stopped: false };
    const state = cam;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      if (state.stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.stream = stream;
      const video = $('#camvideo');
      video.srcObject = stream;
      await video.play().catch(() => {});
      const c = document.createElement('canvas');
      const cx = c.getContext('2d');
      let busy = false;
      state.timer = setInterval(() => {
        if (busy || !video.videoWidth || !ws || ws.readyState !== 1 || ws.bufferedAmount > 512 * 1024) return;
        const w = Math.min(960, video.videoWidth);
        const h = Math.round((video.videoHeight / video.videoWidth) * w);
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        cx.drawImage(video, 0, 0, w, h);
        busy = true;
        c.toBlob(async (blob) => {
          busy = false;
          if (!blob || state.stopped || !ws || ws.readyState !== 1) return;
          const data = new Uint8Array(await blob.arrayBuffer());
          const msg = new Uint8Array(data.length + 1);
          msg[0] = MSG.CAM;
          msg.set(data, 1);
          ws.send(msg);
        }, 'image/jpeg', 0.75);
      }, 40);
    } catch {
      toast(window.isSecureContext ? 'Camera blocked: allow camera access for this site' : 'Camera needs HTTPS', 5000);
      cam = null;
    }
  }
  function stopCamera() {
    if (!cam) return;
    cam.stopped = true;
    clearInterval(cam.timer);
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    $('#camvideo').srcObject = null;
    cam = null;
  }

  // ------------------------------------------------------------ microphone in

  let mic = null;
  async function startMic() {
    if (mic) return;
    mic = { stopped: false };
    const state = mic;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (state.stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.stream = stream;
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      state.ac = ac;
      const src = ac.createMediaStreamSource(stream);
      const proc = ac.createScriptProcessor(1024, 1, 1);
      const mute = ac.createGain();
      mute.gain.value = 0;
      const ratio = ac.sampleRate / 24000;
      proc.onaudioprocess = (ev) => {
        if (state.stopped || !ws || ws.readyState !== 1) return;
        const input = ev.inputBuffer.getChannelData(0);
        const n = Math.floor(input.length / ratio);
        const out = new Uint8Array(1 + n * 2);
        out[0] = MSG.MIC;
        const view = new DataView(out.buffer);
        for (let i = 0; i < n; i++) {
          const a = Math.floor(i * ratio);
          const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
          let sum = 0;
          for (let j = a; j < b; j++) sum += input[j];
          const s = Math.max(-1, Math.min(1, sum / (b - a)));
          view.setInt16(1 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        ws.send(out);
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ac.destination);
      if (ac.state === 'suspended') ac.resume().catch(() => {});
    } catch {
      toast(window.isSecureContext ? 'Microphone blocked: allow microphone access for this site' : 'Microphone needs HTTPS', 5000);
      mic = null;
    }
  }
  function stopMic() {
    if (!mic) return;
    mic.stopped = true;
    if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
    if (mic.ac) mic.ac.close().catch(() => {});
    mic = null;
  }

  // ------------------------------------------------------------ go

  layout();
  showOverlay('Connecting…');
  detectVideo().then((ok) => {
    mode = ok ? 'video' : 'jpeg';
    connect();
  });
})();
