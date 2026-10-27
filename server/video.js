'use strict';
// Low-latency H.264 stream of one region of an X display:
//   ffmpeg x11grab → libx264 (zerolatency, no B-frames) → Annex-B on stdout
// The byte stream is cut into access units (one per video frame) using the
// AUD NAL units x264 inserts, and each frame is emitted as soon as it is
// complete, so the client can decode it immediately with WebCodecs.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const config = require('./config');
const log = require('./log');

// find the next Annex-B start code (00 00 01 or 00 00 00 01) at or after `from`
function nextStart(buf, from) {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return { pos: i, len: 3 };
      if (buf[i + 2] === 0 && buf[i + 3] === 1) return { pos: i, len: 4 };
    }
  }
  return null;
}

function isKeyFrame(au) {
  let s = nextStart(au, 0);
  while (s) {
    const type = au[s.pos + s.len] & 0x1f;
    if (type === 5) return true; // IDR slice
    if (type === 1) return false; // non-IDR slice
    s = nextStart(au, s.pos + s.len);
  }
  return false;
}

// position of the next AUD (NAL type 9) start code at or after `from`
function nextAud(buf, from) {
  let s = nextStart(buf, from);
  while (s) {
    if ((buf[s.pos + s.len] & 0x1f) === 9) return s.pos;
    s = nextStart(buf, s.pos + s.len);
  }
  return -1;
}

class X11H264 extends EventEmitter {
  constructor({ display, x, y, w, h, fps }) {
    super();
    this.opts = { display, x, y, w, h, fps: fps || config.fps };
    this.pending = Buffer.alloc(0);
    this.quietTimer = null;
    this.stopped = false;
  }

  start() {
    const { display, x, y, w, h } = this.opts;
    const fps = String(this.opts.fps);
    const args = [
      '-loglevel', 'error', '-nostdin',
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', fps, '-video_size', `${w}x${h}`,
      '-i', `:${display}.0+${x},${y}`,
      '-c:v', 'libx264', '-preset', config.x264Preset, '-tune', 'zerolatency',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-crf', String(config.crf), '-maxrate', `${config.maxBitrateMbit}M`, '-bufsize', `${Math.max(1, Math.round(config.maxBitrateMbit / 4))}M`,
      '-g', String(this.opts.fps * 3), '-bf', '0', '-threads', String(config.encoderThreads),
      '-x264-params', 'aud=1:repeat-headers=1',
      '-flush_packets', '1', '-f', 'h264', 'pipe:1',
    ];
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => log.error('ffmpeg:', e.message));
    this.proc.stderr.on('data', (d) => log.debug('[ffmpeg]', d.toString().trim().slice(0, 300)));
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.on('exit', (code) => {
      clearTimeout(this.quietTimer);
      if (!this.stopped) {
        log.warn(`ffmpeg exited (${code})`);
        this.emit('exit', code);
      }
    });
  }

  _emit(au) {
    if (au.length) this.emit('frame', au, isKeyFrame(au));
  }

  _onData(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    // Everything before the next frame's AUD is one complete frame.
    // (search past this frame's own 4-byte start code + AUD)
    let cut = nextAud(this.pending, 5);
    while (cut > 0) {
      this._emit(this.pending.subarray(0, cut));
      this.pending = this.pending.subarray(cut);
      cut = nextAud(this.pending, 5);
    }
    // ffmpeg flushes after every frame: when the pipe goes quiet the frame is done.
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      const au = this.pending;
      this.pending = Buffer.alloc(0);
      this._emit(au);
    }, 4);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.quietTimer);
    if (this.proc) this.proc.kill('SIGKILL');
  }
}

module.exports = { X11H264 };
