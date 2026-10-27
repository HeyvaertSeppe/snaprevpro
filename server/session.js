'use strict';
// One Session = one user's isolated browser:
//   Xvfb display  +  PulseAudio sink/source  +  Chromium (own persistent profile)
// The active tab is streamed to every connected client with CDP screencast
// (JPEG frames); input from clients is replayed with CDP Input.* commands.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const CDP = require('./cdp');
const INJECT = require('./inject');
const pulse = require('./pulse');
const config = require('./config');
const log = require('./log');

const MSG = { FRAME: 1, AUDIO: 2, CAM: 0x10, MIC: 0x11 };

const usedDisplays = new Set();
function allocDisplay() {
  for (let n = 100; n < 1000; n++) {
    if (!usedDisplays.has(n)) {
      usedDisplays.add(n);
      return n;
    }
  }
  throw new Error('no free display');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

function userDir(uid) {
  return path.join(config.dataDir, 'users', uid);
}
function uploadDir(uid) {
  return path.join(config.runDir, 'uploads', uid);
}

function chromeFlags(s) {
  return [
    // Chromium's own sandbox needs privileges a normal container doesn't have.
    // Isolation between users comes from separate processes, profiles and displays.
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--password-store=basic',
    '--use-mock-keychain',
    '--hide-crash-restore-bubble',
    '--noerrdialogs',
    `--window-position=0,0`,
    `--window-size=${config.screen.w},${config.screen.h}`,
    '--force-device-scale-factor=1',
    `--lang=${s.lang}`,
    `--accept-lang=${s.acceptLang}`,
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    // keep the page fully "alive" even though nobody looks at the X display
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // software WebGL (no GPU in the container), GPU work kept in the browser process
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--in-process-gpu',
    // memory savers
    '--renderer-process-limit=3',
    '--disable-site-isolation-trials',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-domain-reliability',
    '--no-pings',
    '--metrics-recording-only',
    '--no-zygote',
    '--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,' +
      'AutofillServerCommunication,InterestFeedContentSuggestions,HardwareMediaKeyHandling,' +
      'BackForwardCache,IsolateOrigins,site-per-process,PrivacySandboxSettings4,' +
      'CalculateNativeWinOcclusion,GlobalMediaControls,SpareRendererForSitePerProcess,' +
      'AudioServiceOutOfProcess',
    '--enable-features=NetworkServiceInProcess2',
    ...config.extraChromeFlags,
  ];
}

// Make sure Chromium starts cleanly from a profile left by a crash or container kill.
function prepareProfile(profileDir, acceptLang) {
  fs.mkdirSync(profileDir, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(profileDir, f)); } catch { /* not there */ }
  }
  const prefDir = path.join(profileDir, 'Default');
  const prefFile = path.join(prefDir, 'Preferences');
  fs.mkdirSync(prefDir, { recursive: true });
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8')); } catch { /* new profile */ }
  const fresh = !prefs.profile;
  prefs.profile = { ...(prefs.profile || {}), exit_type: 'Normal', exited_cleanly: true, password_manager_enabled: false };
  prefs.credentials_enable_service = false;
  prefs.translate = { ...(prefs.translate || {}), enabled: false };
  prefs.browser = { ...(prefs.browser || {}), has_seen_welcome_page: true, check_default_browser: false };
  // never restore old tabs: every start opens the start URL in a single tab
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };
  if (fresh) prefs.intl = { ...(prefs.intl || {}), accept_languages: acceptLang };
  fs.writeFileSync(prefFile, JSON.stringify(prefs));
  fs.rmSync(path.join(prefDir, 'Sessions'), { recursive: true, force: true });
}

function cleanOldDownloads(dir) {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

class Session extends EventEmitter {
  constructor(uid, hints = {}) {
    super();
    this.uid = uid;
    this.state = 'starting';
    this.clients = new Set();
    this.pages = new Map(); // targetId -> { sid, title, url, order }
    this.sessToTarget = new Map(); // CDP sessionId -> targetId
    this.order = 0;
    this.active = null; // targetId
    this.lastFrame = null;
    this.lastUsed = Date.now();
    this.idleTimer = null;
    this.viewport = { w: 1280, h: 800, dsf: 1 };
    if (hints.w && hints.h) this.setViewportValues(hints);
    this.tz = /^[A-Za-z_+\-/0-9]{1,64}$/.test(hints.tz || '') ? hints.tz : '';
    const lang = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(hints.lang || '') ? hints.lang : 'en-US';
    this.lang = lang;
    this.acceptLang = lang.includes('-') ? `${lang},${lang.split('-')[0]},en` : `${lang},en`;
    this.dialog = null;
    this.chooser = null;
    this.downloads = new Map();
    this.camSid = null;
    this.camBusy = false;
    this.micOn = false;
    this.micFd = null;
    this.lastMicData = 0;
    this.closing = null;
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    try {
      await this._start();
      this.state = 'ready';
      this.broadcastJSON({ t: 'status', state: 'ready' });
      this.broadcastJSON({ t: 'viewport', w: this.viewport.w, h: this.viewport.h });
      this._sendTabs();
      log.info(`[${this.short}] browser ready (display :${this.display})`);
    } catch (e) {
      log.error(`[${this.short}] failed to start:`, e.message);
      this.broadcastJSON({ t: 'status', state: 'error', message: 'The browser could not be started.' });
      this.close('start failed');
    }
  }

  get short() {
    return this.uid.slice(0, 8);
  }

  async _start() {
    const dir = userDir(this.uid);
    this.profileDir = path.join(dir, 'profile');
    this.downloadDir = path.join(dir, 'downloads');
    fs.mkdirSync(this.downloadDir, { recursive: true });
    fs.mkdirSync(uploadDir(this.uid), { recursive: true });
    cleanOldDownloads(this.downloadDir);
    prepareProfile(this.profileDir, this.acceptLang);

    // 1. virtual display
    this.display = allocDisplay();
    for (const f of [`/tmp/.X${this.display}-lock`, `/tmp/.X11-unix/X${this.display}`]) {
      try { fs.unlinkSync(f); } catch { /* not there */ }
    }
    this.xvfb = spawn('Xvfb', [
      `:${this.display}`, '-screen', '0', `${config.screen.w}x${config.screen.h}x24`,
      '-nolisten', 'tcp', '-dpi', '96', '-noreset',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    this.xvfb.on('error', (e) => log.error('Xvfb:', e.message));
    this.xvfb.on('exit', () => { if (!this.closing) this.close('Xvfb exited'); });
    for (let i = 0; ; i++) {
      if (fs.existsSync(`/tmp/.X11-unix/X${this.display}`)) break;
      if (i > 100 || this.closing) throw new Error('Xvfb did not start');
      await wait(50);
    }

    // 2. audio devices
    this.audio = await pulse.createDevices(this.display);
    if (this.closing) throw new Error('closed during start');

    // 3. Chromium
    const env = { ...process.env, DISPLAY: `:${this.display}` };
    if (this.audio) {
      Object.assign(env, pulse.env, { PULSE_SINK: this.audio.sink, PULSE_SOURCE: this.audio.source });
    }
    if (this.tz) env.TZ = this.tz;
    this.proc = spawn(config.chromeBin, [
      ...chromeFlags(this),
      `--user-data-dir=${this.profileDir}`,
      '--remote-debugging-pipe',
      'about:blank',
    ], { env, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => log.error(`[${this.short}] chromium:`, e.message));
    this.proc.stdout.on('data', () => {});
    this.proc.stderr.on('data', (d) => log.debug(`[${this.short}] chromium:`, d.toString().trim().slice(0, 300)));
    this.proc.on('exit', (code, sig) => {
      if (!this.closing) {
        log.warn(`[${this.short}] chromium exited unexpectedly (${code ?? sig})`);
        this.broadcastJSON({ t: 'status', state: 'crashed', message: 'The browser stopped. Restarting…' });
        this.close('chromium exited');
      }
    });

    this.cdp = new CDP(this.proc.stdio[3], this.proc.stdio[4]);
    this._wireEvents();
    await this.cdp.send('Browser.getVersion', {}, undefined, 20000);
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.cdp.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'page', exclude: false }, { exclude: true }],
    });
    await this.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', downloadPath: this.downloadDir, eventsEnabled: true,
    }).catch((e) => log.debug('download behavior:', e.message));
    await this.cdp.send('Browser.grantPermissions', {
      permissions: ['audioCapture', 'videoCapture', 'notifications', 'clipboardReadWrite',
        'clipboardSanitizedWrite', 'durableStorage', 'backgroundSync'],
    }).catch((e) => log.debug('grantPermissions:', e.message));

    // pages that existed before auto-attach was on (the initial about:blank tab)
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    for (const info of targetInfos) {
      if (info.type === 'page' && !this.pages.has(info.targetId)) {
        await this.cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => {});
      }
    }

    // 4. audio out stream + message polling
    if (this.audio) this._startAudioCapture();
    this.pollTimer = setInterval(() => this._poll(), 250);
  }

  _startAudioCapture() {
    this.parec = spawn('parec', [
      '-d', `${this.audio.sink}.monitor`, '--raw', '--format=s16le', '--rate=24000',
      '--channels=1', '--latency-msec=60',
    ], { env: pulse.env, stdio: ['ignore', 'pipe', 'ignore'] });
    this.parec.on('error', () => {});
    let silentFor = 0;
    this.parec.stdout.on('data', (chunk) => {
      if (!this.clients.size) return;
      // skip pure silence (most of the time) to save bandwidth
      let silent = true;
      for (let i = 0; i < chunk.length - 1; i += 64) {
        const v = chunk.readInt16LE(i);
        if (v > 8 || v < -8) { silent = false; break; }
      }
      if (silent) {
        silentFor += chunk.length;
        if (silentFor > 24000 * 2) return; // >1s of silence: stop sending
      } else {
        silentFor = 0;
      }
      const buf = Buffer.allocUnsafe(chunk.length + 1);
      buf[0] = MSG.AUDIO;
      chunk.copy(buf, 1);
      for (const c of this.clients) {
        if (c.audio && c.ws.readyState === 1 && c.ws.bufferedAmount < 512 * 1024) c.ws.send(buf);
      }
    });
  }

  close(reason = '') {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      log.info(`[${this.short}] closing browser${reason ? ` (${reason})` : ''}`);
      this.state = 'closed';
      clearTimeout(this.idleTimer);
      clearInterval(this.micTimer);
      clearInterval(this.pollTimer);
      this.emit('closed');
      if (this.parec) this.parec.kill('SIGKILL');
      if (this.micFd !== null) { try { fs.closeSync(this.micFd); } catch { /* ignore */ } this.micFd = null; }
      // Ask Chromium to quit normally so cookies / IndexedDB are flushed to disk.
      if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
        const exited = new Promise((r) => this.proc.once('exit', r));
        if (this.cdp && !this.cdp.closed) this.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
        else this.proc.kill('SIGTERM');
        const ok = await Promise.race([exited.then(() => true), wait(8000).then(() => false)]);
        if (!ok) {
          this.proc.kill('SIGKILL');
          await Promise.race([exited, wait(2000)]);
        }
      }
      if (this.xvfb) this.xvfb.kill('SIGTERM');
      await pulse.removeDevices(this.audio);
      if (this.display) usedDisplays.delete(this.display);
      fs.rmSync(uploadDir(this.uid), { recursive: true, force: true });
      for (const c of this.clients) {
        try { c.ws.close(4000, 'session closed'); } catch { /* ignore */ }
      }
      this.clients.clear();
    })();
    return this.closing;
  }

  // ---------------------------------------------------------------- clients

  attach(ws) {
    const client = { ws, audio: true };
    this.clients.add(client);
    this.lastUsed = Date.now();
    clearTimeout(this.idleTimer);
    this.sendJSON(client, { t: 'status', state: this.state });
    if (this.state === 'ready') {
      this.sendJSON(client, { t: 'viewport', w: this.viewport.w, h: this.viewport.h });
      this._sendTabs();
      if (this.lastFrame) ws.send(this.lastFrame);
      this._restartScreencast();
      if (this.micOn) this.sendJSON(client, { t: 'mic', on: true });
      if (this.camSid) this.sendJSON(client, { t: 'cam', on: true });
      if (this.dialog) this.sendJSON(client, this.dialog.msg);
      if (this.chooser) this.sendJSON(client, this.chooser.msg);
    }
    ws.on('message', (data, isBinary) => {
      this.lastUsed = Date.now();
      if (isBinary) this._onBinary(data);
      else {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        this._onMessage(client, msg).catch((e) => log.debug(`[${this.short}] ${msg.t}:`, e.message));
      }
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.lastUsed = Date.now();
      if (this.clients.size === 0 && !this.closing) {
        this.idleTimer = setTimeout(() => this.close('idle'), config.idleMinutes * 60 * 1000);
      }
    });
  }

  sendJSON(client, obj) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
  }

  broadcastJSON(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(s);
  }

  // ---------------------------------------------------------------- CDP events

  _wireEvents() {
    const cdp = this.cdp;
    cdp.on('close', () => { if (!this.closing) this.close('CDP closed'); });

    cdp.on('Target.attachedToTarget', (p) => {
      const info = p.targetInfo;
      if (info.type !== 'page') {
        if (p.waitingForDebugger) cdp.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
        return;
      }
      if (this.pages.has(info.targetId)) {
        // duplicate attach (auto-attach + manual); keep the first session
        cdp.send('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
        return;
      }
      this._setupPage(p.sessionId, info, p.waitingForDebugger);
    });

    cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
      const page = this.pages.get(targetInfo.targetId);
      if (!page) return;
      page.title = targetInfo.title;
      page.url = targetInfo.url;
      this._sendTabs();
    });

    const gone = (targetId) => {
      const page = this.pages.get(targetId);
      if (!page) return;
      this.pages.delete(targetId);
      this.sessToTarget.delete(page.sid);
      if (this.camSid === page.sid) this._setCam(null);
      if (this.active === targetId) {
        this.active = null;
        const next = [...this.pages.entries()].sort((a, b) => b[1].order - a[1].order)[0];
        if (next) this._activate(next[0]);
        else if (!this.closing) this.cdp.send('Target.createTarget', { url: config.startUrl }).catch(() => {});
      }
      this._sendTabs();
    };
    cdp.on('Target.targetDestroyed', ({ targetId }) => gone(targetId));
    cdp.on('Target.detachedFromTarget', ({ sessionId, targetId }) => {
      const id = targetId || this.sessToTarget.get(sessionId);
      const page = this.pages.get(id);
      if (page && page.sid === sessionId) gone(id);
    });

    cdp.on('Page.screencastFrame', (p, sid) => this._onFrame(p, sid));

    cdp.on('Page.javascriptDialogOpening', (p, sid) => {
      if (p.type === 'beforeunload' || !this.clients.size) {
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
        return;
      }
      const id = Math.random().toString(36).slice(2);
      this.dialog = { id, sid, msg: { t: 'dialog', id, type: p.type, message: p.message, defaultPrompt: p.defaultPrompt || '' } };
      this.broadcastJSON(this.dialog.msg);
    });
    cdp.on('Page.javascriptDialogClosed', (_p, sid) => {
      if (this.dialog && this.dialog.sid === sid) {
        this.broadcastJSON({ t: 'dialog-closed', id: this.dialog.id });
        this.dialog = null;
      }
    });

    cdp.on('Page.fileChooserOpened', (p, sid) => {
      const id = Math.random().toString(36).slice(2);
      this.chooser = { id, sid, backendNodeId: p.backendNodeId, msg: { t: 'filechooser', id, multiple: p.mode === 'selectMultiple' } };
      this.broadcastJSON(this.chooser.msg);
    });

    cdp.on('Inspector.targetCrashed', (_p, sid) => {
      const page = this.pages.get(this.sessToTarget.get(sid));
      if (!page || Date.now() - page.since < 5000) return;
      log.warn(`[${this.short}] tab crashed, reloading`);
      page.since = Date.now();
      if (page) cdp.send('Page.navigate', { url: page.url && page.url.startsWith('http') ? page.url : config.startUrl }, sid).catch(() => {});
    });

    cdp.on('Browser.downloadWillBegin', (p) => {
      this.downloads.set(p.guid, p.suggestedFilename || 'download');
    });
    cdp.on('Browser.downloadProgress', (p) => {
      if (p.state !== 'completed') return;
      const name = this.downloads.get(p.guid) || 'download';
      this.downloads.delete(p.guid);
      try { fs.writeFileSync(path.join(this.downloadDir, `${p.guid}.name`), name); } catch { /* ignore */ }
      this.broadcastJSON({ t: 'download', url: `/download/${p.guid}`, name });
    });
  }

  // Collect messages queued by the injected script (see inject.js).
  async _poll() {
    if (this.polling || this.state !== 'ready' || !this.clients.size) return;
    const sids = new Set();
    const page = this.active && this.pages.get(this.active);
    if (page) sids.add(page.sid);
    if (this.camSid) sids.add(this.camSid);
    this.polling = true;
    try {
      for (const sid of sids) {
        const r = await this.cdp.send('Runtime.evaluate', {
          expression: '(()=>{const q=window.__rbQ;return q&&q.length?JSON.stringify(q.splice(0)):""})()',
          returnByValue: true,
        }, sid, 3000).catch(() => null);
        const text = r && r.result && r.result.value;
        if (!text) continue;
        let list = [];
        try { list = JSON.parse(text); } catch { /* ignore */ }
        for (const m of list) {
          if (m.t === 'clip' && typeof m.text === 'string') this.broadcastJSON({ t: 'clip', text: m.text.slice(0, 1e6) });
          else if (m.t === 'cam') this._setCam(m.on ? sid : null);
          else if (m.t === 'mic') this._setMic(!!m.on);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async _setupPage(sid, info, waiting) {
    const targetId = info.targetId;
    log.debug(`[${this.short}] tab attached ${targetId.slice(0, 8)} ${info.url} opener=${info.openerId || '-'} waiting=${waiting}`);
    this.pages.set(targetId, { sid, title: info.title, url: info.url, order: ++this.order, since: Date.now() });
    this.sessToTarget.set(sid, targetId);
    const s = (m, p) => this.cdp.send(m, p, sid).catch((e) => log.debug(`[${this.short}] ${m}:`, e.message));
    await Promise.all([
      s('Page.enable'),
      s('Inspector.enable'),
      s('Page.addScriptToEvaluateOnNewDocument', { source: INJECT, runImmediately: true }),
      s('Page.setInterceptFileChooserDialog', { enabled: true }),
      s('Emulation.setFocusEmulationEnabled', { enabled: true }),
      this.tz ? s('Emulation.setTimezoneOverride', { timezoneId: this.tz }) : null,
      this._applyMetrics(sid),
    ]);
    if (waiting) await s('Runtime.runIfWaitingForDebugger');
    // the very first tab starts at about:blank so our script is in place before Snapchat loads
    if (!this.navigatedHome && (!info.url || info.url === 'about:blank')) {
      this.navigatedHome = true;
      s('Page.navigate', { url: config.startUrl });
    }
    this._activate(targetId);
  }

  // ---------------------------------------------------------------- screen

  _applyMetrics(sid) {
    const { w, h, dsf } = this.viewport;
    return this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: dsf, mobile: false, screenWidth: w, screenHeight: h,
    }, sid).catch(() => {});
  }

  async _activate(targetId) {
    const page = this.pages.get(targetId);
    if (!page) return;
    const prev = this.active && this.pages.get(this.active);
    if (prev && prev.sid !== page.sid) this.cdp.send('Page.stopScreencast', {}, prev.sid).catch(() => {});
    this.active = targetId;
    page.order = ++this.order;
    await this.cdp.send('Page.bringToFront', {}, page.sid).catch(() => {});
    await this._applyMetrics(page.sid);
    await this._restartScreencast();
    this._sendTabs();
  }

  async _restartScreencast() {
    const page = this.active && this.pages.get(this.active);
    if (!page) return;
    const { w, h, dsf } = this.viewport;
    await this.cdp.send('Page.stopScreencast', {}, page.sid).catch(() => {});
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: config.jpegQuality, maxWidth: Math.round(w * dsf), maxHeight: Math.round(h * dsf), everyNthFrame: 1,
    }, page.sid).catch((e) => log.debug('screencast:', e.message));
  }

  _onFrame(p, sid) {
    const ack = () => this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => {});
    const page = this.active && this.pages.get(this.active);
    if (!page || page.sid !== sid) { ack(); return; }
    const jpeg = Buffer.from(p.data, 'base64');
    const buf = Buffer.allocUnsafe(jpeg.length + 1);
    buf[0] = MSG.FRAME;
    jpeg.copy(buf, 1);
    this.lastFrame = buf;
    for (const c of this.clients) {
      if (c.ws.readyState === 1 && c.ws.bufferedAmount < 2 * 1024 * 1024) c.ws.send(buf);
    }
    // Back-pressure: only ask for the next frame when clients have caught up.
    const start = Date.now();
    const tryAck = () => {
      const behind = [...this.clients].some((c) => c.ws.readyState === 1 && c.ws.bufferedAmount > 256 * 1024);
      if (!behind || Date.now() - start > 1500) ack();
      else setTimeout(tryAck, 25);
    };
    tryAck();
  }

  setViewportValues({ w, h, dsf }) {
    this.viewport = {
      w: clamp(w, 320, config.maxViewport.w),
      h: clamp(h, 240, config.maxViewport.h),
      dsf: Math.min(2, Math.max(1, Number(dsf) || 1)),
    };
  }

  _sendTabs() {
    const list = [...this.pages.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, p]) => ({ id, title: p.title || p.url || 'New tab', url: p.url || '', active: id === this.active }));
    this.broadcastJSON({ t: 'tabs', list });
  }

  // ---------------------------------------------------------------- camera / mic

  _setCam(sid) {
    this.camSid = sid;
    this.broadcastJSON({ t: 'cam', on: !!sid });
  }

  _setMic(on) {
    if (on === this.micOn) return;
    this.micOn = on;
    this.broadcastJSON({ t: 'mic', on });
    clearInterval(this.micTimer);
    if (!on || !this.audio) return;
    if (this.micFd === null) {
      try {
        this.micFd = fs.openSync(this.audio.fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      } catch (e) {
        log.warn('mic fifo:', e.message);
        return;
      }
    }
    // Feed silence while the visitor's mic isn't sending, so the browser's
    // microphone device never stalls.
    const silence = Buffer.alloc(960); // 20 ms @ 24 kHz mono s16
    this.micTimer = setInterval(() => {
      if (Date.now() - this.lastMicData > 300) this._writeMic(silence);
    }, 20);
  }

  _writeMic(buf) {
    if (this.micFd === null) return;
    try { fs.writeSync(this.micFd, buf); } catch { /* pipe full: drop */ }
  }

  _onBinary(data) {
    if (!data.length) return;
    const type = data[0];
    if (type === MSG.MIC) {
      if (!this.micOn) return;
      this.lastMicData = Date.now();
      this._writeMic(data.subarray(1));
    } else if (type === MSG.CAM) {
      if (!this.camSid || this.camBusy) return;
      this.camBusy = true;
      const b64 = data.subarray(1).toString('base64');
      this.cdp.send('Runtime.evaluate', {
        expression: `window.__rbFrame&&window.__rbFrame("${b64}")`, returnByValue: true,
      }, this.camSid, 5000).catch(() => {}).finally(() => { this.camBusy = false; });
    }
  }

  // ---------------------------------------------------------------- input

  async _onMessage(client, m) {
    if (this.state !== 'ready') {
      if (m.t === 'resize') this.setViewportValues(m);
      return;
    }
    const page = this.active && this.pages.get(this.active);
    const sid = page && page.sid;
    const send = (method, params) => this.cdp.send(method, params, sid, 10000);

    switch (m.t) {
      case 'mouse':
        if (!sid) return;
        await send('Input.dispatchMouseEvent', {
          type: m.type === 'down' ? 'mousePressed' : m.type === 'up' ? 'mouseReleased' : 'mouseMoved',
          x: +m.x || 0, y: +m.y || 0,
          button: ['left', 'middle', 'right', 'back', 'forward', 'none'].includes(m.button) ? m.button : 'none',
          buttons: m.buttons | 0, clickCount: m.clickCount | 0, modifiers: m.mods | 0,
        });
        break;
      case 'wheel':
        if (!sid) return;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: +m.x || 0, y: +m.y || 0, deltaX: +m.dx || 0, deltaY: +m.dy || 0, modifiers: m.mods | 0,
        });
        break;
      case 'key': {
        if (!sid) return;
        const key = String(m.key || '');
        const mods = m.mods | 0;
        const ctrlOrMeta = (mods & 2 && !(mods & 1)) || mods & 4; // AltGr = Ctrl+Alt still types text
        let text = '';
        if (key === 'Enter') text = '\r';
        else if ([...key].length === 1 && !ctrlOrMeta) text = key;
        const base = {
          key, code: String(m.code || ''), windowsVirtualKeyCode: m.keyCode | 0, nativeVirtualKeyCode: m.keyCode | 0,
          modifiers: mods, location: m.location | 0, isKeypad: m.location === 3,
        };
        if (m.type === 'down') {
          await send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, autoRepeat: !!m.repeat });
        } else {
          await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
        }
        break;
      }
      case 'text':
        if (!sid || typeof m.text !== 'string' || !m.text) return;
        await send('Input.insertText', { text: m.text.slice(0, 100000) });
        break;
      case 'resize':
        this.setViewportValues(m);
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(async () => {
          const p = this.active && this.pages.get(this.active);
          if (p) await this._applyMetrics(p.sid);
          await this._restartScreencast();
          this.broadcastJSON({ t: 'viewport', w: this.viewport.w, h: this.viewport.h });
        }, 120);
        break;
      case 'nav':
        if (!sid) return;
        if (m.action === 'reload') await send('Page.reload', {});
        else if (m.action === 'home') await send('Page.navigate', { url: config.startUrl });
        else if (m.action === 'back' || m.action === 'forward') {
          const h = await send('Page.getNavigationHistory', {});
          const entry = h.entries[h.currentIndex + (m.action === 'back' ? -1 : 1)];
          if (entry) await send('Page.navigateToHistoryEntry', { entryId: entry.id });
        }
        break;
      case 'tab':
        if (!this.pages.has(m.id)) return;
        if (m.action === 'switch') await this._activate(m.id);
        else if (m.action === 'close') await this.cdp.send('Target.closeTarget', { targetId: m.id });
        break;
      case 'dialog':
        if (!this.dialog || this.dialog.id !== m.id) return;
        await this.cdp.send('Page.handleJavaScriptDialog', {
          accept: !!m.accept, promptText: typeof m.text === 'string' ? m.text : undefined,
        }, this.dialog.sid);
        break;
      case 'files': {
        if (!this.chooser || this.chooser.id !== m.id) return;
        const { sid: csid, backendNodeId } = this.chooser;
        this.chooser = null;
        this.broadcastJSON({ t: 'filechooser-closed', id: m.id });
        const dir = uploadDir(this.uid);
        const files = (Array.isArray(m.files) ? m.files : [])
          .map((f) => path.join(dir, path.basename(String(f))))
          .filter((f) => fs.existsSync(f));
        if (files.length) await this.cdp.send('DOM.setFileInputFiles', { files, backendNodeId }, csid);
        break;
      }
      case 'editable': {
        if (!sid) return;
        const r = await send('Runtime.evaluate', {
          expression: '(()=>{let a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;' +
            'return !!a&&(a.isContentEditable||a.tagName==="TEXTAREA"||(a.tagName==="INPUT"&&!/^(button|checkbox|radio|submit|reset|file|image|range|color)$/i.test(a.type)))})()',
          returnByValue: true,
        });
        this.sendJSON(client, { t: 'editable', on: !!(r.result && r.result.value) });
        break;
      }
      case 'audio':
        client.audio = !!m.on;
        break;
      case 'restart':
        this.broadcastJSON({ t: 'status', state: 'restarting', message: 'Restarting your browser…' });
        await this.close('restart requested');
        break;
      default:
        break;
    }
  }
}

module.exports = { Session, userDir, uploadDir };
