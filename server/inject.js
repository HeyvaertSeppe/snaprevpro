'use strict';
// Runs inside every page of the remote browser before the site's own scripts
// (Page.addScriptToEvaluateOnNewDocument). It:
//  - turns getUserMedia({video}) into a camera track fed with frames from the
//    visitor's real webcam (sent over the WebSocket, drawn onto a canvas)
//  - lets getUserMedia({audio}) use the per-user PulseAudio "Microphone"
//    device, and tells the gateway when to start/stop the visitor's mic
//  - forwards copied text to the visitor's clipboard
//  - suppresses the native right-click menu (it would be invisible remotely)
// Messages for the gateway are queued in window.__rbQ and polled by the gateway.

function injected() {
  const KEY = Symbol.for('rb.installed');
  if (window[KEY]) return;
  Object.defineProperty(window, KEY, { value: true });

  // Outgoing messages are queued here; the gateway collects them with
  // Runtime.evaluate (no Runtime.enable / bindings, which sites can detect).
  const queue = [];
  Object.defineProperty(window, '__rbQ', { value: queue, enumerable: false });
  const signal = (msg) => { if (queue.length < 100) queue.push(msg); };

  // ---- clipboard: remote copy -> visitor's clipboard ----
  const selectionText = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|email|password)?$/i.test(a.type || '')))) {
      try { return a.value.substring(a.selectionStart, a.selectionEnd); } catch (e) { /* ignore */ }
    }
    return String(window.getSelection ? window.getSelection() : '');
  };
  const onCopy = (e) => {
    let text = '';
    try { text = e.clipboardData ? e.clipboardData.getData('text/plain') : ''; } catch (err) { /* ignore */ }
    if (!text) text = selectionText();
    if (text) signal({ t: 'clip', text });
  };
  window.addEventListener('copy', onCopy);
  window.addEventListener('cut', onCopy);
  try {
    const cb = navigator.clipboard;
    if (cb && cb.writeText) {
      const realWrite = cb.writeText.bind(cb);
      cb.writeText = function writeText(text) {
        signal({ t: 'clip', text: String(text) });
        return realWrite(text).catch(() => undefined);
      };
    }
  } catch (e) { /* ignore */ }

  // ---- cursor shape + text-field focus, so the visitor's device can show the
  // right mouse cursor locally and open the on-screen keyboard ----
  const isEditable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|file|image|range|color|hidden)$/i.test(el.type || '')));
  let lastCursor = '';
  window.addEventListener('mousemove', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    let c = 'default';
    try { c = getComputedStyle(el).cursor || 'auto'; } catch (err) { /* ignore */ }
    if (c.includes('url(')) c = c.split(',').pop().trim();
    if (c === 'auto') c = isEditable(el) ? 'text' : (el.closest && el.closest('a[href]') ? 'pointer' : 'default');
    if (c !== lastCursor) { lastCursor = c; signal({ t: 'cursor', c }); }
  }, { capture: true, passive: true });
  let lastFocus = null;
  const focusChanged = () => setTimeout(() => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    const ed = isEditable(a);
    if (ed !== lastFocus) { lastFocus = ed; signal({ t: 'focus', editable: ed }); }
  }, 0);
  window.addEventListener('focusin', focusChanged, true);
  window.addEventListener('focusout', focusChanged, true);

  // ---- context menu: a native menu would be invisible, so block it when the site didn't ----
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- camera / microphone ----
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const realGUM = md.getUserMedia.bind(md);
  const realEnum = md.enumerateDevices.bind(md);
  const CAM_ID = 'rb-camera';
  const CAM_LABEL = 'Camera (your device)';

  let canvas = null;
  let ctx = null;
  const camTracks = new Set();
  const micTracks = new Set();

  const ensureCanvas = () => {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 640, 480);
  };

  let decoding = false;
  let lastDraw = 0;
  // Keep the camera track producing frames (repaint the last image) even when
  // the visitor's webcam is slow, still starting, or unavailable.
  setInterval(() => {
    if (!canvas || !camTracks.size || Date.now() - lastDraw < 200) return;
    ctx.drawImage(canvas, 0, 0);
    lastDraw = Date.now();
  }, 100);
  Object.defineProperty(window, '__rbFrame', {
    enumerable: false,
    value: (b64) => {
      if (!canvas || decoding) return;
      decoding = true;
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((bmp) => {
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          lastDraw = Date.now();
          bmp.close();
        }).catch(() => {}).finally(() => { decoding = false; });
      } catch (e) {
        decoding = false;
      }
    },
  });

  const release = (set, track, kind) => {
    if (set.delete(track) && set.size === 0) signal({ t: kind, on: false });
  };

  const makeCamTrack = () => {
    ensureCanvas();
    const track = canvas.captureStream(30).getVideoTracks()[0];
    const realStop = track.stop.bind(track);
    Object.defineProperty(track, 'label', { value: CAM_LABEL });
    track.stop = () => { realStop(); release(camTracks, track, 'cam'); };
    track.clone = () => makeCamTrack();
    track.getSettings = () => ({
      deviceId: CAM_ID, groupId: 'rb', width: canvas.width, height: canvas.height,
      frameRate: 30, aspectRatio: canvas.width / canvas.height, facingMode: 'user', resizeMode: 'none',
    });
    track.getCapabilities = () => ({
      deviceId: CAM_ID, groupId: 'rb', width: { min: 1, max: 1280 }, height: { min: 1, max: 720 },
      frameRate: { min: 1, max: 30 }, aspectRatio: { min: 0.001, max: 1280 },
      facingMode: ['user'], resizeMode: ['none', 'crop-and-scale'],
    });
    track.getConstraints = () => ({});
    track.applyConstraints = () => Promise.resolve();
    camTracks.add(track);
    if (camTracks.size === 1) signal({ t: 'cam', on: true });
    return track;
  };

  const wrapMic = (track) => {
    const realStop = track.stop.bind(track);
    track.stop = () => { realStop(); release(micTracks, track, 'mic'); };
    track.addEventListener('ended', () => release(micTracks, track, 'mic'));
    micTracks.add(track);
    return track;
  };

  md.getUserMedia = async function getUserMedia(constraints) {
    const c = constraints || {};
    if (!c.audio && !c.video) return realGUM(c);
    const tracks = [];
    if (c.audio) {
      if (micTracks.size === 0) signal({ t: 'mic', on: true });
      let s;
      try {
        s = await realGUM({ audio: c.audio });
      } catch (e) {
        if (micTracks.size === 0) signal({ t: 'mic', on: false });
        throw e;
      }
      s.getAudioTracks().forEach((t) => tracks.push(wrapMic(t)));
    }
    if (c.video) tracks.push(makeCamTrack());
    return new MediaStream(tracks);
  };

  md.enumerateDevices = async function enumerateDevices() {
    const list = await realEnum();
    const out = list.filter((d) => d.kind !== 'videoinput' && !/^Monitor of /i.test(d.label));
    const cam = {
      deviceId: CAM_ID, groupId: 'rb', kind: 'videoinput', label: CAM_LABEL,
      toJSON() { return { deviceId: CAM_ID, groupId: 'rb', kind: 'videoinput', label: CAM_LABEL }; },
    };
    try { Object.setPrototypeOf(cam, MediaDeviceInfo.prototype); } catch (e) { /* ignore */ }
    out.push(cam);
    return out;
  };
}

module.exports = `(${injected.toString()})();`;
