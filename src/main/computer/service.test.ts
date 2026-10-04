import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerError, ComputerErrorCode } from "../../shared/computer";
import { ComputerService, type ComputerServiceDeps } from "./service";

vi.mock("../log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

interface Fake {
  server: Server;
  sockets: Socket[];
  argv: string[];
  silent: boolean;
}

/** A fake helper: listens on the socket path it was launched with and speaks the protocol. */
function fakeLauncher(opts: { silentMethods?: string[]; notifyOnPing?: boolean } = {}) {
  const helpers: Fake[] = [];
  const launch = async (_app: string, argv: string[]) => {
    const path = argv[argv.indexOf("--socket") + 1] as string;
    const token = argv[argv.indexOf("--token") + 1];
    const helper: Fake = { server: createServer(), sockets: [], argv, silent: false };
    helper.server.on("connection", (socket) => {
      helper.sockets.push(socket);
      let buffer = "";
      let authed = false;
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
          const msg = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          const reply = (body: object) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body })}\n`);
          if (!authed) {
            if (msg.method !== "hello" || msg.params.token !== token) {
              reply({ error: { code: -32600, message: "unauthorized" } });
              socket.end();
              return;
            }
            authed = true;
            reply({ result: { helperVersion: 1, protocol: 1, os: "26", arch: "arm64", permissions: { accessibility: true, screenRecording: false } } });
          } else if (opts.silentMethods?.includes(msg.method)) {
            // never answers
          } else if (msg.method === "ping") {
            if (opts.notifyOnPing) socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "cancelled", params: { session: "s1", reason: "esc" } })}\n`);
            reply({ result: { pong: true, text: "héllo 🙂" } });
          } else if (msg.method === "shutdown") reply({ result: {} });
          else reply({ error: { code: -32601, message: `method not found: ${msg.method}` } });
        }
      });
    });
    await new Promise<void>((resolve) => helper.server.listen(path, resolve));
    helpers.push(helper);
  };
  return { launch, helpers };
}

const servers: Fake[][] = [];
afterEach(() => {
  for (const helpers of servers.splice(0)) for (const h of helpers) { for (const s of h.sockets) s.destroy(); h.server.close(); }
});

async function setup(opts: Parameters<typeof fakeLauncher>[0] = {}, deps: Partial<ComputerServiceDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pigna-cu-"));
  const fake = fakeLauncher(opts);
  servers.push(fake.helpers);
  const versions = new Map<string, number>([["/bundle/app", 1]]);
  const installs: string[] = [];
  const service = new ComputerService({
    bundledApp: "/bundle/app",
    installDir: join(dir, "install"),
    socketDir: dir,
    parentPid: 4242,
    launch: fake.launch,
    readVersion: async (p) => (p.startsWith("/bundle") ? versions.get(p) : versions.get("installed")),
    install: async (from, to) => {
      installs.push(`${from} -> ${to}`);
      versions.set("installed", versions.get(from) ?? 0);
    },
    connectTimeoutMs: 1000,
    callTimeoutMs: 1000,
    ...deps,
  });
  return { service, fake, versions, installs };
}

describe("ComputerService", () => {
  it("installs, launches with socket/token/parent, handshakes and calls", async () => {
    const { service, fake, installs } = await setup();
    const info = await service.info();
    expect(info.permissions.accessibility).toBe(true);
    expect(installs).toHaveLength(1);
    const argv = fake.helpers[0]?.argv ?? [];
    expect(argv).toEqual(["--socket", expect.stringMatching(/cu-[0-9a-f]{8}\.sock$/), "--token", expect.stringMatching(/^[0-9a-f]{48}$/), "--parent", "4242"]);
    expect(await service.call("ping", {})).toEqual({ pong: true, text: "héllo 🙂" });
    await service.stop();
  });

  it("reinstalls only when the bundled helper version is newer", async () => {
    const { service, versions, installs } = await setup();
    await service.info();
    await service.stop();
    await service.info();
    expect(installs).toHaveLength(1);
    await service.stop();
    versions.set("/bundle/app", 2);
    await service.info();
    expect(installs).toHaveLength(2);
    await service.stop();
  });

  it("rejects a helper that refuses the token", async () => {
    const { service } = await setup({}, { launch: async (_a, argv) => fakeLauncher().launch("", argv.map((a, i) => (argv[i - 1] === "--token" ? "wrong" : a))) });
    servers.push([]);
    await expect(service.info()).rejects.toMatchObject({ code: ComputerErrorCode.unauthorized });
  });

  it("times out a call that never answers with a typed error", async () => {
    const { service } = await setup({ silentMethods: ["ping"] });
    const error = await service.call("ping", {}, 80).catch((e) => e);
    expect(error).toBeInstanceOf(ComputerError);
    expect(error.code).toBe(ComputerErrorCode.timeout);
    await service.stop();
  });

  it("surfaces helper errors with their code", async () => {
    const { service } = await setup();
    await expect(service.call("list_apps", {})).rejects.toMatchObject({ code: ComputerErrorCode.methodNotFound });
    await service.stop();
  });

  it("fails the in-flight call with helper_crashed and restarts on the next call", async () => {
    const { service, fake } = await setup({ silentMethods: ["ping"] });
    await service.info();
    const inflight = service.call("ping", {}).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    for (const s of fake.helpers[0]?.sockets ?? []) s.destroy();
    expect((await inflight).code).toBe(ComputerErrorCode.helperCrashed);
    await expect(service.call("permissions", {})).rejects.toMatchObject({ code: ComputerErrorCode.methodNotFound });
    expect(fake.helpers).toHaveLength(2);
    await service.stop();
  });

  it("delivers notifications", async () => {
    const { service } = await setup({ notifyOnPing: true });
    const seen: unknown[] = [];
    service.onNotification((n) => seen.push(n));
    await service.call("ping", {});
    expect(seen).toEqual([{ method: "cancelled", params: { session: "s1", reason: "esc" } }]);
    await service.stop();
  });
});
