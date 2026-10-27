'use strict';
// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe
// (fd 3 = commands to Chromium, fd 4 = messages from Chromium, NUL-separated JSON).
// Using the pipe means no debugging port is ever exposed, not even on localhost.
const { EventEmitter } = require('events');

class CDP extends EventEmitter {
  constructor(toChrome, fromChrome) {
    super();
    this.setMaxListeners(100);
    this.out = toChrome;
    this.nextId = 1;
    this.pending = new Map();
    this.parts = [];
    this.closed = false;
    fromChrome.on('data', (chunk) => this._onData(chunk));
    fromChrome.on('close', () => this._onClose());
    fromChrome.on('error', () => this._onClose());
    toChrome.on('error', () => this._onClose());
  }

  _onData(chunk) {
    let start = 0;
    let i = chunk.indexOf(0);
    while (i !== -1) {
      this.parts.push(chunk.subarray(start, i));
      const text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      start = i + 1;
      this._dispatch(text);
      i = chunk.indexOf(0, start);
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
  }

  _dispatch(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result || {});
      return;
    }
    this.emit(msg.method, msg.params || {}, msg.sessionId);
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.emit('close');
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.out.write(JSON.stringify(msg) + '\0');
    });
  }
}

module.exports = CDP;
