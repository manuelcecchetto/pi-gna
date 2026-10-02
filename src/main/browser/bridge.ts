// Localhost bridge for the pi browser extension. Each pi process gets its own token, and the
// token (never the request body) decides which session is acting.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentAction } from "../../shared/browser";
import { log } from "../log";
import type { BrowserAgent } from "./agent";

const MAX_BODY = 1024 * 1024;
const ACTIONS = new Set(["open", "snapshot", "click", "type", "press", "screenshot", "evaluate", "console", "back", "state"]);

export class AgentBridge {
  private server?: Server;
  private readonly tokens = new Map<string, string>();
  url = "";

  constructor(private readonly agent: () => BrowserAgent | undefined) {}

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
    log.info("browser", `agent bridge on ${this.url}`);
  }

  register(handle: string): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, handle);
    return token;
  }

  unregister(handle: string): void {
    for (const [token, owner] of this.tokens) if (owner === handle) this.tokens.delete(token);
  }

  stop(): void {
    this.server?.close();
  }

  private async handle(request: IncomingMessage): Promise<unknown> {
    const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
    // Reject anything not addressed to the loopback bridge (DNS rebinding) or without a session token.
    if (request.headers.host !== this.url.slice("http://".length)) throw fail(403, "bad host");
    const handle = this.tokens.get((request.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!handle) throw fail(401, "unauthorized");
    if (request.method !== "POST" || request.url !== "/browser") throw fail(404, "not found");

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw fail(413, "request too large");
      chunks.push(chunk as Buffer);
    }
    const action = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentAction;
    if (!ACTIONS.has(action?.action)) throw fail(400, `unknown action ${String(action?.action)}`);
    const agent = this.agent();
    if (!agent) throw fail(503, "the browser is not ready");
    return agent.run(handle, action);
  }
}
