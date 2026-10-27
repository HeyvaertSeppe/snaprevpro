'use strict';
// One PulseAudio daemon for the whole container. Every user gets:
//  - a null sink (their browser's speakers); we record its monitor and stream it out
//  - a pipe source (their browser's microphone); we write the visitor's mic PCM into it
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');

const pulseDir = path.join(config.runDir, 'pulse');
const socket = path.join(pulseDir, 'native');
const env = {
  ...process.env,
  PULSE_SERVER: `unix:${socket}`,
  PULSE_RUNTIME_PATH: pulseDir,
  PULSE_STATE_PATH: path.join(pulseDir, 'state'),
};

let available = false;
let daemon = null;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function start() {
  fs.mkdirSync(path.join(pulseDir, 'state'), { recursive: true });
  daemon = spawn(
    'pulseaudio',
    [
      '--daemonize=no',
      '--use-pid-file=no',
      '--exit-idle-time=-1',
      '--disallow-exit=yes',
      '--disable-shm=yes',
      '--log-target=stderr',
      '--log-level=error',
      '-n',
      '-L', `module-native-protocol-unix socket=${socket} auth-anonymous=1`,
      '-L', 'module-null-sink sink_name=rb_default',
    ],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  daemon.on('error', (e) => log.warn('pulseaudio not available:', e.message));
  daemon.stderr.on('data', (d) => log.debug('[pulse]', d.toString().trim()));
  daemon.on('exit', (code) => {
    available = false;
    log.warn(`pulseaudio exited (${code}); sound disabled`);
  });
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(socket)) {
      available = true;
      log.info('PulseAudio ready');
      return true;
    }
    await wait(100);
  }
  log.warn('PulseAudio did not start; continuing without sound/microphone');
  return false;
}

function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { env, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function createDevices(n) {
  if (!available) return null;
  const sink = `rb_out_${n}`;
  const source = `rb_mic_${n}`;
  const fifo = path.join(pulseDir, `mic_${n}.fifo`);
  try { fs.unlinkSync(fifo); } catch { /* not there */ }
  const modules = [];
  try {
    modules.push(await pactl(['load-module', 'module-null-sink', `sink_name=${sink}`,
      'sink_properties=device.description=Speakers']));
    modules.push(await pactl(['load-module', 'module-pipe-source', `source_name=${source}`,
      `file=${fifo}`, 'format=s16le', 'rate=24000', 'channels=1',
      'source_properties=device.description=Microphone']));
    return { sink, source, fifo, modules };
  } catch (e) {
    log.warn('could not create audio devices:', e.message);
    await removeDevices({ modules, fifo });
    return null;
  }
}

async function removeDevices(dev) {
  if (!dev) return;
  for (const m of dev.modules.reverse()) {
    await pactl(['unload-module', m]).catch(() => {});
  }
  try { fs.unlinkSync(dev.fifo); } catch { /* gone */ }
}

function stop() {
  if (daemon) daemon.kill('SIGTERM');
}

module.exports = {
  start,
  stop,
  createDevices,
  removeDevices,
  env,
  get available() { return available; },
};
