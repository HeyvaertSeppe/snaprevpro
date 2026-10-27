'use strict';
// Gateway: one domain, one URL. Every device gets a signed, long-lived cookie
// (rb_uid). The cookie maps to a private browser profile on disk and a private
// Chromium instance that is started on demand and stopped when idle.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');
const log = require('./log');
const pulse = require('./pulse');
const { Session, userDir, uploadDir } = require('./session');
const httpstream = require('./httpstream');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'rb_uid';
const sessions = new Map(); // uid -> Session

// ------------------------------------------------------------------ identity

let secret;
function loadSecret() {
  const file = path.join(config.dataDir, 'secret.key');
  try {
    secret = fs.readFileSync(file);
    if (secret.length >= 32) return;
  } catch { /* first run */ }
  secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  log.info('generated new cookie signing key');
}

const sign = (uid) => crypto.createHmac('sha256', secret).update(uid).digest('hex').slice(0, 32);
const tokenFor = (uid) => `${uid}.${sign(uid)}`;
// Per-device key embedded in the page; the live connection presents it.
// Other websites can't read our page, so a valid key proves the request
// comes from this site even when a proxy rewrites Host/Origin.
const pageKey = (uid) => crypto.createHmac('sha256', secret).update(`page:${uid}`).digest('hex').slice(0, 24);

function verifyToken(token) {
  const m = /^([a-f0-9]{32})\.([a-f0-9]{32})$/.exec(token || '');
  if (!m) return null;
  const a = Buffer.from(m[2]);
  const b = Buffer.from(sign(m[1]));
  return crypto.timingSafeEqual(a, b) ? m[1] : null;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const userFromReq = (req) => verifyToken(parseCookies(req)[COOKIE]);

function isHttps(req) {
  if (req.socket.encrypted) return true;
  if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return /"scheme":"https"/.test(String(req.headers['cf-visitor'] || '')); // Cloudflare
}

function cookieHeader(req, uid) {
  return `${COOKIE}=${tokenFor(uid)}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}

function newUser() {
  const uid = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(userDir(uid), { recursive: true });
  log.info(`new device registered: ${uid.slice(0, 8)}`);
  return uid;
}

// ------------------------------------------------------------------ HTTP

const SECURITY_HEADERS = {
  'Permissions-Policy': 'camera=(self), microphone=(self), clipboard-read=(self), clipboard-write=(self), fullscreen=(self), autoplay=(self)',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

// index.html with ?v=<hash> on the app files, so browsers/CDNs (Cloudflare)
// never mix an old app.js with a new server after an update.
let indexHtml = null;
function getIndexHtml() {
  if (indexHtml) return indexHtml;
  const ver = (name) => crypto.createHash('sha1').update(fs.readFileSync(path.join(PUBLIC, 'assets', name))).digest('hex').slice(0, 10);
  indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace('/assets/app.js', `/assets/app.js?v=${ver('app.js')}`)
    .replace('/assets/style.css', `/assets/style.css?v=${ver('style.css')}`);
  return indexHtml;
}

function serveFile(res, file, extra = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...extra });
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function loginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome</title><link rel="stylesheet" href="/assets/style.css"></head>
<body class="login"><form method="post" action="/login" class="card">
<h1>Welcome</h1><p>Enter the access code once. This device will be remembered.</p>
${error ? '<p class="err">Wrong code, try again.</p>' : ''}
<input name="code" type="password" autocomplete="current-password" autofocus required placeholder="Access code">
<button type="submit">Continue</button></form></body></html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, JSON.stringify({ ok: true, sessions: sessions.size }), { 'Content-Type': 'application/json' });

  if (p.startsWith('/assets/')) {
    const name = path.basename(p);
    return serveFile(res, path.join(PUBLIC, 'assets', name));
  }

  if (p === '/' || p === '/index.html') {
    let uid = userFromReq(req);
    const headers = {};
    if (!uid) {
      if (config.accessCode) return send(res, 200, loginPage(false), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      uid = newUser();
      headers['Set-Cookie'] = cookieHeader(req, uid);
    }
    const html = getIndexHtml().replace('<head>', `<head>\n  <meta name="rb-key" content="${pageKey(uid)}">`);
    return send(res, 200, html, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  if (p === '/login' && req.method === 'POST' && config.accessCode) {
    const body = (await readBody(req, 4096).catch(() => Buffer.alloc(0))).toString();
    const code = new URLSearchParams(body).get('code') || '';
    const a = crypto.createHash('sha256').update(code).digest();
    const b = crypto.createHash('sha256').update(config.accessCode).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      await new Promise((r) => setTimeout(r, 800));
      return send(res, 401, loginPage(true), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const uid = userFromReq(req) || newUser();
    return send(res, 303, '', { Location: '/', 'Set-Cookie': cookieHeader(req, uid) });
  }

  // Move your session to another device: open /claim/<token> there.
  if (p.startsWith('/claim/')) {
    const uid = verifyToken(p.slice(7));
    if (!uid) return send(res, 404, 'Invalid link');
    return send(res, 303, '', { Location: '/', 'Set-Cookie': cookieHeader(req, uid), 'Cache-Control': 'no-store' });
  }

  // /ws reached here = a proxy dropped the WebSocket "Upgrade" header.
  if (p === '/ws') {
    warnOnce('ws-no-upgrade', 'A request for /ws arrived without WebSocket upgrade headers: the reverse proxy is not forwarding WebSockets. Clients fall back to HTTP streaming (works, slightly slower). See nginx/ in the README to fix the proxy.');
    return send(res, 426, 'WebSocket upgrade required', { Upgrade: 'websocket' });
  }

  const uid = userFromReq(req);
  if (!uid) return send(res, 401, 'Not signed in');

  // HTTP streaming fallback (see httpstream.js)
  if (p === '/stream' && req.method === 'GET') {
    if (!originOk(req, uid)) return send(res, 403, 'Forbidden');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no', // tell Nginx not to buffer this response
    });
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    const conn = new httpstream.HttpStreamConn(res, uid);
    openClient(conn, uid, url.searchParams);
    return undefined;
  }
  if (p === '/send' && req.method === 'POST') {
    if (!originOk(req, uid)) return send(res, 403, 'Forbidden');
    const conn = httpstream.get(url.searchParams.get('id'), uid);
    const body = await readBody(req, 8 * 1024 * 1024).catch(() => null);
    if (!conn) return send(res, 410, 'Gone');
    if (body) conn.receive(body);
    return send(res, 204, '');
  }

  if (p === '/api/link') {
    return send(res, 200, JSON.stringify({ path: `/claim/${tokenFor(uid)}` }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  }

  if (p === '/upload' && req.method === 'POST') {
    const dir = uploadDir(uid);
    fs.mkdirSync(dir, { recursive: true });
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch { /* keep default */ }
    name = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(-120) || 'file';
    // Big files arrive in chunks (X-Upload-Id / X-Chunk / X-Last) so they pass
    // proxies with small body limits (Nginx default 1 MB, Cloudflare 100 MB).
    const upId = /^[a-f0-9]{8,32}$/.test(String(req.headers['x-upload-id'] || '')) ? req.headers['x-upload-id'] : crypto.randomBytes(6).toString('hex');
    const chunk = Number(req.headers['x-chunk'] || 0) | 0;
    const last = req.headers['x-last'] === undefined || req.headers['x-last'] === '1';
    const id = `${upId}-${name}`;
    const file = path.join(dir, id);
    let already = 0;
    if (chunk > 0) { try { already = fs.statSync(file).size; } catch { return send(res, 409, 'Upload out of order'); } }
    const out = fs.createWriteStream(file, { flags: chunk > 0 ? 'a' : 'w' });
    let size = already;
    let failed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxUploadBytes && !failed) {
        failed = true;
        out.destroy();
        fs.rm(file, { force: true }, () => {});
        send(res, 413, 'File too large');
        req.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => { if (!failed) send(res, 200, JSON.stringify(last ? { id } : { ok: true }), { 'Content-Type': 'application/json' }); });
    out.on('error', () => { if (!failed) { failed = true; send(res, 500, 'Upload failed'); } });
    return undefined;
  }

  const dl = /^\/download\/([A-Za-z0-9-]{8,64})$/.exec(p);
  if (dl) {
    const dir = path.join(userDir(uid), 'downloads');
    const file = path.join(dir, dl[1]);
    let name = 'download';
    try { name = fs.readFileSync(`${file}.name`, 'utf8'); } catch { /* default */ }
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return send(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(file).pipe(res);
  }

  return send(res, 404, 'Not found');
}

// ------------------------------------------------------------------ sessions

function getSession(uid, hints) {
  let s = sessions.get(uid);
  if (s && !s.closing) return s;
  const live = [...sessions.values()].filter((x) => !x.closing);
  if (live.length >= config.maxSessions) {
    // free the least recently used browser that nobody is looking at
    const idle = live.filter((x) => x.clients.size === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) return null;
    idle.close('making room');
  }
  s = new Session(uid, hints);
  sessions.set(uid, s);
  s.on('closed', () => { if (sessions.get(uid) === s) sessions.delete(uid); });
  s.start();
  return s;
}

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(msg);
}

// Cross-site protection: the page's origin must be this site. Proxies and
// tunnels (Nginx, Cloudflare) may change the Host/port, so compare host names
// against every host header they might set.
function originOk(req, uid) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  if (uid) {
    const k = new URL(req.url, 'http://x').searchParams.get('k') || '';
    const want = pageKey(uid);
    if (k.length === want.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return true;
  }
  let host = '';
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  const candidates = [req.headers.host, req.headers['x-forwarded-host'], req.headers['x-original-host']]
    .filter(Boolean).flatMap((h) => String(h).split(','))
    .map((h) => h.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
  if (candidates.includes(host)) return true;
  // Behind a tunnel/proxy that rewrites Host (e.g. a Cloudflare tunnel pointed at
  // an IP address) the names differ. The browser itself says whether the
  // request comes from this same site; page scripts cannot fake this header.
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'same-origin' || site === 'same-site') {
    warnOnce('host-mismatch', `Note: the proxy does not pass the original Host header (got "${req.headers.host}", site is "${host}"). This works, but "proxy_set_header Host $host;" (Nginx) or "HTTP Host Header" (Cloudflare tunnel) is cleaner.`);
    return true;
  }
  warnOnce(`origin-${host}`, `Refused a connection from origin "${origin}" (Host: ${req.headers.host}, X-Forwarded-Host: ${req.headers['x-forwarded-host'] || '-'}). Make the proxy pass the original Host header ("proxy_set_header Host $host;" in Nginx).`);
  return false;
}

// Attach a client (WebSocket or HTTP stream) to the user's browser session.
function openClient(conn, uid, q) {
  const session = getSession(uid, { w: q.get('w'), h: q.get('h'), dsf: q.get('dsf'), lang: q.get('lang'), tz: q.get('tz'), touch: q.get('touch') });
  if (!session) {
    conn.send(JSON.stringify({ t: 'status', state: 'busy', message: 'The server is full right now. Please try again in a few minutes.' }));
    conn.close(4001, 'busy');
    return;
  }
  session.attach(conn, q.get('mode'));
}

// ------------------------------------------------------------------ boot

async function main() {
  fs.mkdirSync(path.join(config.dataDir, 'users'), { recursive: true });
  fs.rmSync(config.runDir, { recursive: true, force: true });
  fs.mkdirSync(config.runDir, { recursive: true });
  loadSecret();
  await pulse.start().catch((e) => log.warn('pulse:', e.message));

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error('http error:', e.message);
      if (!res.headersSent) send(res, 500, 'Internal error');
    });
  });
  server.keepAliveTimeout = 65000;

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const uid = url.pathname === '/ws' ? userFromReq(req) : null;
    if (!uid || !originOk(req, uid)) {
      if (url.pathname === '/ws' && !uid) warnOnce('ws-nocookie', 'Refused a WebSocket without a valid device cookie (the proxy may be stripping the Cookie header).');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      openClient(ws, uid, url.searchParams);
    });
  });

  // keep connections alive through proxies
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000).unref();

  server.listen(config.port, '0.0.0.0', () => {
    log.info(`gateway listening on :${config.port} → ${config.startUrl} (chromium: ${config.chromeBin})`);
  });

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: saving all browser profiles and shutting down`);
    server.close();
    await Promise.allSettled([...sessions.values()].map((s) => s.close('shutdown')));
    pulse.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
