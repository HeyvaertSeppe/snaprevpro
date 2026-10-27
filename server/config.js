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
  // Video stream (H.264). Higher FPS / lower CRF = smoother / sharper but more CPU + bandwidth.
  fps: Math.min(60, num('FPS', 60)),
  crf: Math.min(40, num('VIDEO_CRF', 20)),
  maxBitrateMbit: num('VIDEO_MAX_MBIT', 12),
  x264Preset: env.X264_PRESET || 'superfast',
  encoderThreads: num('ENCODER_THREADS', 4),
  // JPEG fallback for old browsers without WebCodecs
  jpegQuality: Math.min(95, num('JPEG_QUALITY', 80)),
  // Links to other sites opened in a new tab are opened on the visitor's own device instead.
  allowedDomains: (env.ALLOWED_DOMAINS || 'snapchat.com,snap.com,snapkit.com,sc-cdn.net,sc-static.net,snapads.com')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  maxUploadBytes: num('MAX_UPLOAD_MB', 250) * 1024 * 1024,
  // Size of the virtual X screen (memory is only used for the part that is drawn).
  // Upper limit; each user's screen is sized to their device. The page is
  // rendered in its top-left corner at the visitor's exact size.
  screen: { w: 3840, h: 3072 },
  logLevel: env.LOG_LEVEL || 'info',
};
