// Newline-delimited JSON-RPC client over a net.Socket. Framing is done by hand (no readline): one JSON object
// per LF-terminated line, UTF-8, split on the raw byte stream so multi-byte characters never straddle a chunk.
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { ComputerError, ComputerErrorCode, type ComputerMethod, type ComputerMethods, type ComputerNotification } from "../../shared/computer";

export const CALL_TIMEOUT_MS = 30_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private closed = false;

  /** `onNotification` receives helper notifications; `onClose` fires once when the socket ends or errors. */
  constructor(
    private readonly socket: Socket,
    private readonly onNotification: (notification: ComputerNotification) => void,
    private readonly onClose: (error?: Error) => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.feed(this.decoder.write(chunk)));
    socket.on("error", (error) => this.finish(error));
    socket.on("close", () => this.finish());
  }

  call<M extends ComputerMethod>(method: M, params: ComputerMethods[M][0], timeoutMs = CALL_TIMEOUT_MS): Promise<ComputerMethods[M][1]> {
    if (this.closed) return Promise.reject(new ComputerError(ComputerErrorCode.helperCrashed, "Computer Use helper is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ComputerError(ComputerErrorCode.timeout, `${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
    this.finish();
  }

  private feed(text: string): void {
    this.buffer += text;
    for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handle(line);
    }
  }

  private handle(line: string): void {
    let message: { id?: number | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new ComputerError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
    } else if (typeof message.method === "string") {
      this.onNotification({ method: message.method, params: message.params } as ComputerNotification);
    }
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerError(ComputerErrorCode.helperCrashed, "Computer Use helper stopped during the call"));
      this.pending.delete(id);
    }
    this.onClose(error);
  }
}
