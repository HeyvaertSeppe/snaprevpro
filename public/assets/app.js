/* Client for the remote browser gateway: draws the streamed screen and sends input. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const canvas = $('#screen');
  const ctx = canvas.getContext('2d', { alpha: false });
  const overlay = $('#overlay');
  const statusText = $('#status-text');
  const kbd = $('#kbd');

  const MSG = { FRAME: 1, AUDIO: 2, CAM: 0x10, MIC: 0x11 };
  const MIN_WIDTH = 1000; // narrower screens get a scaled-down desktop layout
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (isTouch) document.body.classList.add('touch');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const prefs = { hd: store.get('hd', false), sound: store.get('sound', true), nobar: store.get('nobar', false) };

  let ws = null;
  let retry = 0;
  let vp = { w: 0, h: 0 }; // remote viewport in CSS px (confirmed by server)
  let ready = false;

  // ------------------------------------------------------------ UI helpers

  function showOverlay(text) {
    statusText.textContent = text;
    overlay.classList.remove('hidden');
  }
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
  let modalOpen = false;
  let closeModal = null;

  // ------------------------------------------------------------ layout

  function barHeight() { return prefs.nobar ? 0 : $('#bar').offsetHeight; }

  function wanted() {
    const W = window.innerWidth;
    const H = window.innerHeight - barHeight();
    const scale = W < MIN_WIDTH ? MIN_WIDTH / W : 1;
    const dsf = prefs.hd && scale === 1 ? Math.min(2, window.devicePixelRatio || 1) : 1;
    return { w: Math.round(W * scale), h: Math.round(H * scale), dsf };
  }

  function layout() {
    const W = window.innerWidth;
    const H = window.innerHeight - barHeight();
    if (!vp.w || !vp.h) { canvas.style.width = `${W}px`; canvas.style.height = `${H}px`; return; }
    const s = Math.min(W / vp.w, H / vp.h);
    canvas.style.width = `${Math.round(vp.w * s)}px`;
    canvas.style.height = `${Math.round(vp.h * s)}px`;
  }

  let resizeTimer;
  function onResize() {
    layout();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => sendJSON({ t: 'resize', ...wanted() }), 100);
  }
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  function applyPrefs() {
    document.body.classList.toggle('nobar', prefs.nobar);
    $('#showbar').hidden = !prefs.nobar;
    $('#btn-hd').classList.toggle('on', prefs.hd);
    $('#btn-sound').classList.toggle('off', !prefs.sound);
  }

  // ------------------------------------------------------------ connection

  function sendJSON(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    const w = wanted();
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
    const q = new URLSearchParams({ w: w.w, h: w.h, dsf: w.dsf, lang: navigator.language || 'en-US', tz });
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      retry = 0;
      sendJSON({ t: 'resize', ...wanted() });
      sendJSON({ t: 'audio', on: prefs.sound });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onJSON(JSON.parse(e.data));
      else onBinary(new Uint8Array(e.data));
    };
    ws.onclose = (e) => {
      ready = false;
      stopCamera();
      stopMic();
      if (e.code === 4001) {
        showOverlay('The server is full right now. Retrying in 30 seconds…');
        setTimeout(connect, 30000);
        return;
      }
      if (e.code === 1008 || e.code === 1006 && retry > 5 && !navigator.onLine) {
        showOverlay('Offline. Waiting for network…');
      } else {
        showOverlay(e.code === 4000 ? 'Restarting your browser…' : 'Reconnecting…');
      }
      const delay = e.code === 4000 ? 800 : Math.min(10000, 500 * 2 ** retry++);
      setTimeout(connect, delay);
    };
  }

  function onJSON(m) {
    switch (m.t) {
      case 'status':
        if (m.state === 'ready') { ready = true; if (!pendingFrame && !hasFrame) showOverlay('Loading…'); }
        else if (m.state === 'starting') showOverlay('Starting your private browser…');
        else showOverlay(m.message || m.state);
        break;
      case 'viewport':
        vp = { w: m.w, h: m.h };
        layout();
        break;
      case 'tabs': renderTabs(m.list); break;
      case 'clip': copyToClipboard(m.text); break;
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
        toast(`Downloaded ${m.name}`);
        break;
      }
      case 'editable': if (m.on) kbd.focus({ preventScroll: true }); break;
      default: break;
    }
  }

  // ------------------------------------------------------------ screen

  let hasFrame = false;
  let pendingFrame = null;
  let decoding = false;

  function onBinary(data) {
    if (data[0] === MSG.FRAME) {
      pendingFrame = data.subarray(1);
      if (!decoding) drawNext();
    } else if (data[0] === MSG.AUDIO) {
      playAudio(data.subarray(1));
    }
  }

  async function drawNext() {
    const jpeg = pendingFrame;
    pendingFrame = null;
    if (!jpeg) return;
    decoding = true;
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      if (!hasFrame || !overlay.classList.contains('hidden')) { hasFrame = true; if (ready) hideOverlay(); }
    } catch { /* corrupt frame */ }
    decoding = false;
    if (pendingFrame) drawNext();
  }

  // ------------------------------------------------------------ tabs

  function renderTabs(list) {
    const box = $('#tabs');
    box.textContent = '';
    for (const t of list) {
      const el = document.createElement('div');
      el.className = `tab${t.active ? ' active' : ''}`;
      el.title = t.url;
      const label = document.createElement('span');
      label.textContent = t.title || 'Loading…';
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×'; x.title = 'Close tab';
      x.onclick = (e) => { e.stopPropagation(); sendJSON({ t: 'tab', action: 'close', id: t.id }); };
      el.onclick = () => sendJSON({ t: 'tab', action: 'switch', id: t.id });
      el.append(label, x);
      box.appendChild(el);
    }
    const active = list.find((t) => t.active);
    if (active && active.title) document.title = active.title;
  }

  // ------------------------------------------------------------ mouse / touch

  function pos(e) {
    if (!vp.w || !vp.h) vp = { w: wanted().w, h: wanted().h };
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(vp.w, ((e.clientX - r.left) / r.width) * vp.w)),
      y: Math.max(0, Math.min(vp.h, ((e.clientY - r.top) / r.height) * vp.h)),
    };
  }
  const scaleY = () => vp.h / canvas.getBoundingClientRect().height || 1;

  function mods(e) {
    let m = 0;
    if (e.altKey) m |= 1;
    if (e.ctrlKey || (isMac && e.metaKey)) m |= 2; // Cmd on Mac acts as Ctrl remotely (Linux)
    if (e.metaKey && !isMac) m |= 4;
    if (e.shiftKey) m |= 8;
    return m;
  }
  const BTN = ['left', 'middle', 'right', 'back', 'forward'];

  let lastClick = { t: 0, x: 0, y: 0, n: 0, b: -1 };
  function clickCount(p, button) {
    const now = performance.now();
    const near = Math.abs(p.x - lastClick.x) < 6 && Math.abs(p.y - lastClick.y) < 6;
    lastClick.n = now - lastClick.t < 450 && near && lastClick.b === button ? lastClick.n + 1 : 1;
    Object.assign(lastClick, { t: now, x: p.x, y: p.y, b: button });
    return lastClick.n;
  }

  let moveQueued = null;
  function flushMove() {
    if (moveQueued) sendJSON(moveQueued);
    moveQueued = null;
  }

  // touch gestures: tap = click, drag = scroll, long-press = right click
  let touch = null;

  canvas.addEventListener('pointerdown', (e) => {
    unlockAudio();
    if (e.pointerType === 'touch') {
      e.preventDefault();
      if (touch) return; // ignore second finger
      const p = pos(e);
      touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, p, scrolling: false, long: false };
      touch.timer = setTimeout(() => {
        if (!touch || touch.scrolling) return;
        touch.long = true;
        sendJSON({ t: 'mouse', type: 'down', ...touch.p, button: 'right', buttons: 2, clickCount: 1, mods: 0 });
        sendJSON({ t: 'mouse', type: 'up', ...touch.p, button: 'right', buttons: 0, clickCount: 1, mods: 0 });
      }, 550);
      return;
    }
    e.preventDefault();
    // Keep the hidden textarea focused so IME, dead keys, emoji pickers and paste work.
    if (document.activeElement !== kbd) kbd.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    flushMove();
    const p = pos(e);
    sendJSON({ t: 'mouse', type: 'down', ...p, button: BTN[e.button] || 'left', buttons: e.buttons, clickCount: clickCount(p, e.button), mods: mods(e) });
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (!touch || e.pointerId !== touch.id) return;
      e.preventDefault();
      if (!touch.scrolling && Math.hypot(e.clientX - touch.sx, e.clientY - touch.sy) > 10) {
        touch.scrolling = true;
        clearTimeout(touch.timer);
      }
      if (touch.scrolling) {
        const s = scaleY();
        const dx = (touch.lx - e.clientX) * s;
        const dy = (touch.ly - e.clientY) * s;
        touch.lx = e.clientX; touch.ly = e.clientY;
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
      if (!touch || e.pointerId !== touch.id) return;
      e.preventDefault();
      clearTimeout(touch.timer);
      if (!touch.scrolling && !touch.long && e.type === 'pointerup') {
        const p = touch.p;
        const n = clickCount(p, 0);
        sendJSON({ t: 'mouse', type: 'move', ...p, button: 'none', buttons: 0, clickCount: 0, mods: 0 });
        sendJSON({ t: 'mouse', type: 'down', ...p, button: 'left', buttons: 1, clickCount: n, mods: 0 });
        sendJSON({ t: 'mouse', type: 'up', ...p, button: 'left', buttons: 0, clickCount: n, mods: 0 });
        setTimeout(() => sendJSON({ t: 'editable' }), 250);
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

  window.addEventListener('keydown', (e) => {
    if (modalOpen) return;
    unlockAudio();
    if (e.isComposing || e.keyCode === 229 || e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified') return;
    const cmd = e.ctrlKey || e.metaKey;
    // Paste: let the browser fire a real paste event (handled below) with the local clipboard.
    if (cmd && !e.altKey && (e.key === 'v' || e.key === 'V')) return;
    // On touch devices the soft keyboard types through the hidden textarea (input events).
    if (isTouch && e.target === kbd && isPrintable(e) && !cmd) return;
    if (e.key === 'F11' || e.key === 'F12') return;
    e.preventDefault();
    sendJSON(keyMsg(e, 'down'));
  });
  window.addEventListener('keyup', (e) => {
    if (modalOpen) return;
    if (e.key === 'Dead' || e.keyCode === 229 || e.key === 'Process' || e.key === 'Unidentified') return;
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

  // Soft keyboard (phones/tablets): read what was typed into the hidden textarea.
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
      const added = v.slice(SENTINEL.length);
      const parts = added.split('\n');
      parts.forEach((part, i) => {
        if (part) sendJSON({ t: 'text', text: part });
        if (i < parts.length - 1) sendKey('Enter', 'Enter', 13);
      });
    } else {
      let removed = SENTINEL.length - v.length;
      if (removed <= 0) removed = 1;
      for (let i = 0; i < removed; i++) sendKey('Backspace', 'Backspace', 8);
    }
    resetKbd();
  }
  kbd.addEventListener('focus', resetKbd);
  kbd.addEventListener('compositionstart', () => { composing = true; });
  kbd.addEventListener('compositionend', () => { composing = false; setTimeout(flushKbd, 0); });
  kbd.addEventListener('input', () => { if (!composing) flushKbd(); });
  resetKbd();

  // ------------------------------------------------------------ toolbar

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) {
      if (!e.target.closest('#menu')) $('#menu').hidden = true;
      return;
    }
    unlockAudio();
    const act = btn.dataset.act;
    if (act !== 'menu') $('#menu').hidden = true;
    switch (act) {
      case 'back': case 'forward': case 'reload': case 'home':
        sendJSON({ t: 'nav', action: act });
        break;
      case 'keyboard':
        if (document.activeElement === kbd) kbd.blur();
        else kbd.focus({ preventScroll: true });
        break;
      case 'sound':
        prefs.sound = !prefs.sound;
        store.set('sound', prefs.sound);
        sendJSON({ t: 'audio', on: prefs.sound });
        applyPrefs();
        break;
      case 'hd':
        prefs.hd = !prefs.hd;
        store.set('hd', prefs.hd);
        applyPrefs();
        onResize();
        toast(prefs.hd ? 'HD on: sharper text, more bandwidth' : 'HD off');
        break;
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
        break;
      case 'menu':
        $('#menu').hidden = !$('#menu').hidden;
        break;
      case 'hidebar': case 'showbar':
        prefs.nobar = act === 'hidebar';
        store.set('nobar', prefs.nobar);
        applyPrefs();
        onResize();
        break;
      case 'restart': {
        const r = await modal({ text: 'Restart your browser? You stay logged in; open tabs are reloaded.', ok: 'Restart' });
        if (r.accept) sendJSON({ t: 'restart' });
        break;
      }
      case 'link': {
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
        break;
      }
      default: break;
    }
  });

  // ------------------------------------------------------------ clipboard

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to your clipboard');
    } catch {
      // Some browsers only allow clipboard writes during a user gesture.
      toast('Tap here to copy the text', 6000, async () => {
        try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy blocked by your browser'); }
      });
    }
  }

  // ------------------------------------------------------------ dialogs / files

  let dialogId = null;
  async function handleDialog(m) {
    dialogId = m.id;
    const r = await modal({
      text: m.message || '', input: m.type === 'prompt', defaultValue: m.defaultPrompt,
      noCancel: m.type === 'alert',
    });
    if (dialogId === m.id) sendJSON({ t: 'dialog', id: m.id, accept: r.accept || m.type === 'alert', text: r.value });
    dialogId = null;
  }

  let chooserId = null;
  async function handleFileChooser(m) {
    chooserId = m.id;
    const r = await modal({ text: 'The page wants you to pick a file from your device.', ok: m.multiple ? 'Choose files' : 'Choose file' });
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
          const res = await fetch('/upload', { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name) }, credentials: 'same-origin' });
          if (!res.ok) throw new Error(await res.text());
          ids.push((await res.json()).id);
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
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  }
  function playAudio(bytes) {
    if (!actx || !prefs.sound || actx.state !== 'running') return;
    const n = bytes.byteLength >> 1;
    if (!n) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const buf = actx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const now = actx.currentTime;
    if (nextTime < now + 0.02) nextTime = now + 0.08; // (re)start with a small jitter buffer
    if (nextTime > now + 0.5) return; // too far behind: drop to keep latency low
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
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
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
        const w = Math.min(640, video.videoWidth);
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
        }, 'image/jpeg', 0.7);
      }, 66);
      updateLive();
    } catch (err) {
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
    updateLive();
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
      const proc = ac.createScriptProcessor(2048, 1, 1);
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
          // average the samples that fall into this output sample (simple low-pass + decimate)
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
      updateLive();
    } catch (err) {
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
    updateLive();
  }

  function updateLive() {
    const parts = [];
    if (cam) parts.push('● cam');
    if (mic) parts.push('● mic');
    $('#live').textContent = parts.join('  ');
  }

  // ------------------------------------------------------------ go

  applyPrefs();
  layout();
  showOverlay('Connecting…');
  connect();
})();
