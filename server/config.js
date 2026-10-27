'use strict';
// All settings have safe defaults, so the container works without any env vars.
const fs = require('fs');

const env = process.env;

function num(name, def) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function findChrome() {
  if (env.CHROME_BIN) return env.CHROME_BIN;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return 'chromium';
}

module.exports = {
  port: num('PORT', 8080),
  dataDir: env.DATA_DIR || '/data',
  runDir: env.RUN_DIR || '/tmp/rb',
  startUrl: env.START_URL || 'https://web.snapchat.com/',
  // Browser of a user is stopped this many minutes after their last tab closed.
  idleMinutes: num('IDLE_TIMEOUT_MIN', 15),
  // Max simultaneously running browsers (protects RAM).
  maxSessions: num('MAX_SESSIONS', 8),
  // Optional: if set, a new device must enter this code once. Empty = open.
  accessCode: env.ACCESS_CODE || '',
  chromeBin: findChrome(),
  extraChromeFlags: (env.EXTRA_CHROME_FLAGS || '').split(/\s+/).filter(Boolean),
  jpegQuality: Math.min(95, num('JPEG_QUALITY', 70)),
  maxUploadBytes: num('MAX_UPLOAD_MB', 250) * 1024 * 1024,
  // Size of the virtual X screen; the page viewport can be anything up to this.
  screen: { w: 1920, h: 1080 },
  maxViewport: { w: 2560, h: 2560 },
  logLevel: env.LOG_LEVEL || 'info',
};
