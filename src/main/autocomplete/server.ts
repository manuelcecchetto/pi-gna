// Starts a llama.cpp `llama-server` on 127.0.0.1 at a free port behind a random API key, for composer autocomplete
// and voice calls, and waits until it answers /health.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

export interface LlamaServer {
  child: ChildProcess;
  url: string;
  key: string;
}

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });

/**
 * Runs `executable` with `args` plus the host, port and key, and resolves once it is healthy; rejects (and kills it)
 * when it exits first or does not answer within `startMs`. `onExit` hears of the child's exit, also a later one.
 */
export async function launchLlamaServer(executable: string, args: string[], startMs: number, onExit: (child: ChildProcess) => void): Promise<LlamaServer> {
  const port = await freePort();
  const key = randomBytes(24).toString("hex");
  const child = spawn(executable, [...args, "--host", "127.0.0.1", "--port", String(port), "--api-key", key, "--no-webui"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  const url = `http://127.0.0.1:${port}`;
  const exited = new Promise<never>((_, reject) => child.once("exit", (code) => reject(new Error(`llama-server exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`))));
  child.once("exit", () => onExit(child));
  const ready = (async () => {
    const deadline = Date.now() + startMs;
    while (Date.now() < deadline) {
      const response = await fetch(`${url}/health`).catch(() => undefined);
      if (response?.ok) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("llama-server did not start in time");
  })();
  try {
    await Promise.race([ready, exited]);
  } catch (error) {
    child.kill();
    throw error;
  }
  return { child, url, key };
}
