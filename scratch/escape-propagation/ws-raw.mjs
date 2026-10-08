// ws-raw.mjs —— 极简 WebSocket 客户端（RFC 6455），走 node:net。
// 为什么不用内置 WebSocket：undici 的实现不让改握手请求头，
// 而 Chrome DevTools 的 WebSocket 端点会因 Origin 不匹配直接拒绝升级（403）。
// 这里自己握手，可以完全不带 Origin。
import net from "node:net";
import crypto from "node:crypto";

export function connect(url) {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : 80;
  const key = crypto.randomBytes(16).toString("base64");
  const expected = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");

  const socket = net.connect(port, u.hostname);
  const handlers = { open: [], message: [], close: [], error: [] };
  const emit = (name, arg) => handlers[name].forEach((f) => f(arg));
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;

  function frame(text, opcode) {
    const payload = Buffer.from(text, "utf8");
    const op = opcode === undefined ? 0x1 : opcode;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | op; header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
  }

  function parse() {
    while (buffer.length >= 2) {
      const b0 = buffer[0], b1 = buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (buffer.length < off + 4) return; mask = buffer.subarray(off, off + 4); off += 4; }
      if (buffer.length < off + len) return;
      let payload = Buffer.from(buffer.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(off + len);
      if (opcode === 0x1) emit("message", payload.toString("utf8"));
      else if (opcode === 0x8) {
        emit("close", { code: payload.length >= 2 ? payload.readUInt16BE(0) : null });
        socket.end();
        return;
      }
      else if (opcode === 0x9) {
        // ★ 关键：Chrome DevTools 的 WS 会发 ping；不回 pong 它会在 ~400ms 后直接 RST。
        socket.write(frame(payload.toString("latin1"), 0xa));
      }
      else if (opcode === 0xa) { /* pong，忽略 */ }
    }
  }

  socket.on("connect", () => {
    const req = [
      "GET " + (u.pathname || "/") + " HTTP/1.1",
      "Host: " + u.hostname + ":" + port,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " + key,
      "Sec-WebSocket-Version: 13",
      "", "",
    ].join("\r\n");
    socket.write(req);
  });

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshakeDone) {
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const head = buffer.subarray(0, idx).toString("latin1");
      buffer = buffer.subarray(idx + 4);
      const status = head.split("\r\n")[0];
      const m = /Sec-WebSocket-Accept:\s*(\S+)/i.exec(head);
      if (!/101/.test(status) || !m || m[1] !== expected) {
        emit("error", new Error("握手失败: " + status + " accept=" + (m ? m[1] : "none")));
        socket.destroy();
        return;
      }
      handshakeDone = true;
      emit("open", { status });
      parse();
      return;
    }
    parse();
  });

  socket.on("error", (e) => emit("error", e));
  socket.on("close", () => emit("close", {}));

  return {
    on(name, fn) { handlers[name].push(fn); return this; },
    send(text) { socket.write(frame(text)); },
    close() { try { socket.end(); } catch {} },
  };
}
