// A real process behind the FIFOs: a fake pi that answers commands, streams numbered records and can cut a record in
// two writes, so a handover can land inside one.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const FAKE_PI = `#!/usr/bin/env node
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let n = 0;
let timer;
process.on("SIGTERM", () => process.exit(143));
process.stdin.on("end", () => process.exit(0));
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let lf;
  while ((lf = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, lf));
    buffer = buffer.slice(lf + 1);
    out({ type: "response", id: command.id, command: command.type, success: true, data: { pid: process.pid } });
    // Records 1, 2, ... every 5 ms.
    if (command.type === "stream") timer = setInterval(() => out({ type: "tick", n: ++n }), 5);
    if (command.type === "stop") clearInterval(timer);
    // One record in two writes, the cut inside a two-byte character.
    if (command.type === "split") {
      const bytes = Buffer.from(JSON.stringify({ type: "split", text: "caf\\u00e9" }) + "\\n");
      const cut = bytes.indexOf(0xc3) + 1;
      process.stdout.write(bytes.subarray(0, cut));
      setTimeout(() => process.stdout.write(bytes.subarray(cut)), 400);
    }
  }
});
`;

let dir: string;
let PiProcess: typeof import("./pi-process").PiProcess;
let piIo: typeof import("./pi-process").piIo;

const collect = () => {
  const records: { type: string; n?: number; text?: string }[] = [];
  const exits: unknown[] = [];
  return { records, exits, handlers: { onRecords: (batch: unknown[]) => records.push(...(batch as typeof records)), onExit: (exit: unknown) => exits.push(exit) } };
};
const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe.skipIf(process.platform === "win32")("PiProcess over FIFOs", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pigna-pi-test-"));
    const bin = join(dir, "pi");
    writeFileSync(bin, FAKE_PI);
    chmodSync(bin, 0o755);
    vi.stubEnv("PIGNA_PI_BIN", bin);
    ({ PiProcess, piIo } = await import("./pi-process"));
    piIo.root = join(dir, "io");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers commands, and close stops pi and removes its folder", async () => {
    const { exits, handlers } = collect();
    const pi = new PiProcess({ cwd: dir, tag: "t", detachable: true }, handlers);
    const response = await pi.send({ type: "get_state" } as never);
    expect(response.success).toBe(true);
    const io = join(piIo.root, (await import("node:fs")).readdirSync(piIo.root)[0]!);
    await pi.close();
    expect(exits).toHaveLength(1);
    expect(existsSync(io)).toBe(false);
    expect(() => process.kill(pi.pid!, 0)).toThrow();
  });

  it("hands a streaming pi over without losing or repeating a record", async () => {
    const first = collect();
    const pi = new PiProcess({ cwd: dir, tag: "t", detachable: true }, first.handlers);
    await pi.send({ type: "stream" } as never);
    await until(() => first.records.length >= 5);
    const io = (await pi.detach())!;
    expect(io.pid).toBe(pi.pid);
    // pi goes on while nobody reads; its records wait in the FIFO.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = collect();
    const taken = PiProcess.attach(io, { cwd: dir, tag: "t2" }, second.handlers)!;
    await until(() => second.records.filter((r) => r.type === "tick").length >= 10);
    await taken.send({ type: "stop" } as never);
    const ticks = [...first.records, ...second.records].filter((r) => r.type === "tick").map((r) => r.n!);
    expect(ticks).toEqual(ticks.map((_, index) => index + 1));
    expect(first.exits).toEqual([]);
    await taken.close();
    expect(second.exits).toHaveLength(1);
  });

  it("hands over inside a record cut in the middle of a character", async () => {
    const first = collect();
    const pi = new PiProcess({ cwd: dir, tag: "t", detachable: true }, first.handlers);
    await pi.send({ type: "split" } as never);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const io = (await pi.detach())!;
    expect(io.partial).not.toBe("");
    const second = collect();
    const taken = PiProcess.attach(io, { cwd: dir, tag: "t2" }, second.handlers)!;
    await until(() => second.records.some((r) => r.type === "split"));
    expect(second.records.find((r) => r.type === "split")?.text).toBe("café");
    await taken.close();
  });

  it("notices a taken-over pi exit, and attach refuses one that is gone", async () => {
    const first = collect();
    const pi = new PiProcess({ cwd: dir, tag: "t", detachable: true }, first.handlers);
    await pi.send({ type: "get_state" } as never);
    const io = (await pi.detach())!;
    const second = collect();
    PiProcess.attach(io, { cwd: dir, tag: "t2" }, second.handlers);
    process.kill(io.pid, "SIGKILL");
    await until(() => second.exits.length === 1);
    expect(existsSync(io.dir)).toBe(false);
    expect(PiProcess.attach(io, { cwd: dir, tag: "t3" }, collect().handlers)).toBeUndefined();
  });
});
