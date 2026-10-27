'use strict';
// Fallback transport for when a proxy in front of the gateway doesn't pass
// WebSocket upgrades (e.g. an Nginx location without the Upgrade headers).
//   server → client: one long-running HTTP response (GET /stream), framed
//   client → server: small POST requests (POST /send?id=…), framed
// Frame = 1 byte type (0 text, 1 binary, 2 padding/ping) + 4 byte length + payload.
// The object looks like a `ws` WebSocket to the rest of the server.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const conns = new Map(); // id -> HttpStreamConn

function frame(type, payload) {
  const h = Buffer.allocUnsafe(5);
  h[0] = type;
  h.writeUInt32BE(payload.length, 1);
  return [h, payload];
}

class HttpStreamConn extends EventEmitter {
  constructor(res, uid) {
    super();
    this.id = crypto.randomBytes(16).toString('hex');
    this.uid = uid;
    this.res = res;
    this.readyState = 1;
    conns.set(this.id, this);
    res.on('close', () => this._closed(1006));
    res.on('error', () => this._closed(1006));
    // Padding first: pushes the response headers + first bytes through proxy buffers.
    this._write(2, Buffer.alloc(2048));
    this._write(0, Buffer.from(JSON.stringify({ t: 'conn', id: this.id })));
    // keep the connection alive through proxies (Cloudflare closes idle ones after 100 s)
    this.keepAlive = setInterval(() => this._write(2, Buffer.alloc(0)), 15000);
  }

  get bufferedAmount() {
    return (this.res.writableLength || 0) + ((this.res.socket && this.res.socket.writableLength) || 0);
  }

  _write(type, payload) {
    if (this.readyState !== 1) return;
    for (const b of frame(type, payload)) this.res.write(b);
  }

  send(data) {
    if (typeof data === 'string') this._write(0, Buffer.from(data));
    else this._write(1, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  // Deliver a POSTed body (one or more frames) as 'message' events.
  receive(body) {
    let o = 0;
    while (o + 5 <= body.length) {
      const type = body[o];
      const len = body.readUInt32BE(o + 1);
      if (o + 5 + len > body.length) break;
      const payload = body.subarray(o + 5, o + 5 + len);
      o += 5 + len;
      if (type === 0) this.emit('message', payload, false);
      else if (type === 1) this.emit('message', payload, true);
    }
  }

  close(code = 1000) {
    if (this.readyState !== 1) return;
    this._write(0, Buffer.from(JSON.stringify({ t: 'close', code })));
    this.res.end();
    this._closed(code);
  }

  terminate() { this.close(1006); }

  ping() {}

  _closed(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearInterval(this.keepAlive);
    conns.delete(this.id);
    this.emit('close', code);
  }
}

function get(id, uid) {
  const c = conns.get(String(id || ''));
  return c && c.uid === uid ? c : null;
}

module.exports = { HttpStreamConn, get };
