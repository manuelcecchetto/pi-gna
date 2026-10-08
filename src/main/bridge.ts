// Localhost bridge for the pi extensions pi-gna loads (browser_* and kanban_* tools). Each pi process gets its
// own token, and the token (never the request body) decides which session is acting.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "./log";

const MAX_BODY = 1024 * 1024;

/** Handles one POST for the session `handle`; throw bridgeError for a status other than 400. */
export type Route = (handle: string, body: unknown) => Promise<unknown>;

export const bridgeError = (status: number, message: string) => Object.assign(new Error(message), { status });

export class AgentBridge {
  private server?: Server;
  private readonly tokens = new Map<string, string>();
  private readonly routes = new Map<string, Route>();
  url = "";

  route(path: string, route: Route): void {
    this.routes.set(path, route);
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request).then(
        (body) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        },
        (error: Error & { status?: number }) => {
          response.writeHead(error.status ?? 400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error.message }));
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    log.info("bridge", `agent bridge on ${this.url}`);
  }

  register(handle: string): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, handle);
    return token;
  }

  /** A spare pi's token goes to the chat that adopts it (SessionHost): its tools then act for that chat. */
  rename(from: string, to: string): void {
    for (const [token, owner] of this.tokens) if (owner === from) this.tokens.set(token, to);
  }

  unregister(handle: string): void {
    for (const [token, owner] of this.tokens) if (owner === handle) this.tokens.delete(token);
  }

  stop(): void {
    this.server?.close();
  }

  private async handle(request: IncomingMessage): Promise<unknown> {
    // Reject anything not addressed to the loopback bridge (DNS rebinding) or without a session token.
    if (request.headers.host !== this.url.slice("http://".length)) throw bridgeError(403, "bad host");
    const handle = this.tokens.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!handle) throw bridgeError(401, "unauthorized");
    const route = request.method === "POST" ? this.routes.get(request.url ?? "") : undefined;
    if (!route) throw bridgeError(404, "not found");

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw bridgeError(413, "request too large");
      chunks.push(chunk as Buffer);
    }
    return route(handle, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
}
