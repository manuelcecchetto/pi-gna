// Test transport only: exercise the macOS helper's policy/RPC contract on Windows without pretending its native
// helper is supported there. The launch arguments stay unchanged; fake peers map the endpoint to a named pipe.
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { ComputerError, ComputerErrorCode } from "../../../shared/computer";

export const fakeSocketPath = (path: string): string => process.platform === "win32"
  ? `\\\\.\\pipe\\pigna-test-cu-${createHash("sha256").update(path).digest("hex").slice(0, 32)}`
  : path;

export async function connectFakeHelper(path: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  do {
    const socket = await new Promise<Socket | undefined>((resolve) => {
      const attempt = createConnection(fakeSocketPath(path));
      attempt.once("connect", () => { attempt.setTimeout(0); resolve(attempt); });
      attempt.once("error", () => { attempt.destroy(); resolve(undefined); });
      attempt.setTimeout(Math.max(1, deadline - Date.now()), () => { attempt.destroy(); resolve(undefined); });
    });
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new ComputerError(ComputerErrorCode.timeout, "Fake helper did not start listening in time");
}
