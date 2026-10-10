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
  private listening?: Promise<void>;
  /** The port to listen on when it is free: the last pi-gna's, whose pis keep calling it after a restart. */
  private preferred = 0;
  url = "";

  route(path: string, route: Route): void {
    this.routes.set(path, route);
  }

  /** Listen on `port` if it is free (before `start`). */
  prefer(port: number): void {
    this.preferred = port;
  }

  get port(): number {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  /** Listens once: pi-gna starts it before the window, and every pi spawn waits for it (SessionHost) to read `url`. */
  start(): Promise<void> {
    return (this.listening ??= this.listen());
  }

  private async listen(): Promise<void> {
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
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    await (this.preferred ? listen(this.preferred) : Promise.reject(new Error("no port"))).catch(() => listen(0));
    if (this.preferred && (server.address() as AddressInfo).port !== this.preferred) log.warn("bridge", `port ${this.preferred} is taken: the chats from before the restart lose their pi-gna tools`);
    this.server = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    log.info("bridge", `agent bridge on ${this.url}`);
  }

  register(handle: string): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, handle);
    return token;
  }

  /** The token the chat's pi was started with, for the next pi-gna to accept it (`adopt`). */
  tokenOf(handle: string): string | undefined {
    for (const [token, owner] of this.tokens) if (owner === handle) return token;
    return undefined;
  }

  /** Accept a token the last pi-gna issued, for a chat handed over to this one. */
  adopt(token: string, handle: string): void {
    this.tokens.set(token, handle);
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
