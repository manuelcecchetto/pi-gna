import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { acceptKey, acceptWebSocket, frame, MAX_MESSAGE, type WebSocketConnection } from "./websocket";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A server whose connections echo each message back upper-cased; resolves with its ws:// URL and the connections. */
async function echoServer(): Promise<{ url: string; connections: WebSocketConnection[] }> {
  const connections: WebSocketConnection[] = [];
  server = createServer((_request, response) => response.end());
  server.on("upgrade", (request, socket, head) => {
    const connection = acceptWebSocket(request, socket, head);
    if (!connection) return;
    connections.push(connection);
    connection.onMessage((text) => connection.send(text.toUpperCase()));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, connections };
}

const open = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error("connect failed"));
  });

const nextMessage = (socket: WebSocket) => new Promise<string>((resolve) => (socket.onmessage = (event) => resolve(String(event.data))));
const closed = (socket: WebSocket) => new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)));

describe("acceptWebSocket", () => {
  it("computes the RFC 6455 accept key", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("exchanges text messages of every length encoding with a real client", async () => {
    const { url } = await echoServer();
    const socket = await open(url);
    for (const size of [5, 200, 70_000]) {
      const text = "é".repeat(size);
      const reply = nextMessage(socket);
      socket.send(text);
      expect(await reply).toBe(text.toUpperCase());
    }
    socket.close();
  });

  it("closes on a binary message", async () => {
    const { url } = await echoServer();
    const socket = await open(url);
    const code = closed(socket);
    socket.send(new Uint8Array([1, 2, 3]));
    expect(await code).toBe(1003);
  });

  it("reports the end of the connection once when the client closes", async () => {
    const { url, connections } = await echoServer();
    const socket = await open(url);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let ends = 0;
    const ended = new Promise<void>((resolve) =>
      connections[0]!.onClose(() => {
        ends++;
        resolve();
      }),
    );
    socket.close();
    await ended;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ends).toBe(1);
  });

  it("frames a server message with the 64-bit length past 65535 bytes", () => {
    const big = frame(1, Buffer.alloc(70_000));
    expect(big[1]).toBe(127);
    expect(Number(big.readBigUInt64BE(2))).toBe(70_000);
    expect(MAX_MESSAGE).toBeGreaterThan(70_000);
  });
});
