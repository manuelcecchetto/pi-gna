// A WebSocket server connection (RFC 6455) over a socket node:http handed to an "upgrade" listener. Text messages
// only, which is all a CDP client sends (src/main/browser/cdp-endpoint.ts); no extensions, so no compression.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest message a client may send; CDP commands are small (a file upload names paths, it does not carry bytes). */
export const MAX_MESSAGE = 16 * 1024 * 1024;

const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface WebSocketConnection {
  send(text: string): void;
  /** Close with a status code; the socket ends after the close frame. */
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  /** Called once, when the connection ends for any reason. */
  onClose(listener: () => void): void;
}

/** The Sec-WebSocket-Accept value for a client's key. */
export const acceptKey = (key: string) => createHash("sha1").update(key + GUID).digest("base64");

/** One frame: FIN set, server frames unmasked. */
export function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (length < 126) head[1] = length;
  else if (length < 65536) {
    head[1] = 126;
    head.writeUInt16BE(length, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Finish the handshake, or answer 400 and return undefined when the request is not a WebSocket upgrade. */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | undefined {
  const key = request.headers["sec-websocket-key"];
  if (request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13" || typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return undefined;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  return connection(socket, head);
}

function connection(socket: Duplex, head: Buffer): WebSocketConnection {
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  /** Fragments of the message being received, while its last frame has not come. */
  let fragments: Buffer[] | undefined;
  let fragmentSize = 0;
  let closing = false;
  let ended = false;

  const write = (data: Buffer) => {
    if (!socket.destroyed && socket.writable) socket.write(data);
  };
  const close = (code = 1000, reason = "") => {
    if (closing) return;
    closing = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    write(frame(OP.close, payload));
    socket.end();
  };
  const end = () => {
    if (ended) return;
    ended = true;
    for (const listener of closeListeners) listener();
  };

  const deliver = (payload: Buffer) => {
    let text: string;
    try {
      text = decoder.decode(payload);
    } catch {
      return close(1007, "invalid UTF-8");
    }
    for (const listener of messageListeners) listener(text);
  };

  /** Parse every whole frame in the buffer; returns when the next frame is incomplete. */
  const parse = () => {
    while (!closing && buffer.length >= 2) {
      const fin = (buffer[0]! & 0x80) !== 0;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return close(1009, "message too big");
        length = Number(big);
        offset = 10;
      }
      // A client must mask every frame (RFC 6455 s.5.1).
      if (!masked) return close(1002, "unmasked frame");
      if (length > MAX_MESSAGE) return close(1009, "message too big");
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      buffer = buffer.subarray(offset + 4 + length);

      if (opcode >= 8) {
        // Control frames are never fragmented and carry at most 125 bytes.
        if (!fin || length > 125) return close(1002, "bad control frame");
        if (opcode === OP.ping) write(frame(OP.pong, payload));
        else if (opcode === OP.close) return close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
        else if (opcode !== OP.pong) return close(1002, "unknown opcode");
        continue;
      }
      if (opcode === OP.binary) return close(1003, "text messages only");
      if (opcode === OP.text) {
        if (fragments) return close(1002, "new message inside a fragmented one");
        if (fin) {
          deliver(payload);
          continue;
        }
        fragments = [payload];
        fragmentSize = payload.length;
      } else if (opcode === OP.continuation) {
        if (!fragments) return close(1002, "continuation without a message");
        fragments.push(payload);
        fragmentSize += payload.length;
        if (fragmentSize > MAX_MESSAGE) return close(1009, "message too big");
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = undefined;
          fragmentSize = 0;
          deliver(whole);
        }
      } else return close(1002, "unknown opcode");
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    parse();
  });
  socket.on("close", end);
  socket.on("end", end);
  socket.on("error", () => socket.destroy());
  // Frames that came with the handshake are parsed once the caller had a chance to listen.
  if (buffer.length) queueMicrotask(parse);

  return {
    send: (text) => {
      if (!closing) write(frame(OP.text, Buffer.from(text, "utf8")));
    },
    close,
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
  };
}
