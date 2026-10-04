import { describe, expect, it } from "vitest";
import type { RemoteStatus } from "../shared/host-api";
import { applySettingsOp, emptySettings, type Settings, type SettingsOp } from "../shared/settings";
import type { TailscaleStatus } from "../shared/tailscale";
import { type RemoteListener, RemoteHost } from "./remote";
import type { Tailscale } from "./tailscale";

const ready: TailscaleStatus = { installed: true, loggedIn: true, dnsName: "mac.tail1.ts.net", httpsAvailable: true, funnel: false };

function setup(initial: TailscaleStatus = ready, startError?: Error) {
  let settings: Settings = emptySettings();
  const commands: string[][] = [];
  const published: RemoteStatus[] = [];
  let tailnet = initial;
  const server: RemoteListener & { listening: boolean; starts: number[] } = {
    listening: false,
    streamCount: 2,
    starts: [],
    async start(port: number) {
      if (startError) throw startError;
      this.starts.push(port);
      this.listening = true;
    },
    async stop() {
      this.listening = false;
    },
  };
  const tailscale: Tailscale = {
    status: async () => tailnet,
    run: async (args) => {
      commands.push(args);
      // The CLI's effect, as `tailscale serve status` would show it afterwards.
      tailnet = args.includes("off") ? { ...tailnet, serving: undefined } : { ...tailnet, serving: { target: args.at(-1)! } };
    },
  };
  const host = new RemoteHost({
    server,
    tailscale,
    settings: { get: async () => ({ ...settings, rev: 1 }), apply: async (op: SettingsOp) => void (settings = applySettingsOp(settings, op)) },
    devices: { list: async () => [] },
    publish: (status) => published.push(status),
    awake: () => false,
  });
  return { host, server, commands, published, setTailnet: (next: TailscaleStatus) => (tailnet = next) };
}

describe("RemoteHost", () => {
  it("listens only while remote access is on", async () => {
    const { host, server } = setup();
    await host.sync();
    expect(server.listening).toBe(false);
    await host.enable();
    expect(server.listening).toBe(true);
    expect(server.starts).toEqual([4517]);
    await host.disable();
    expect(server.listening).toBe(false);
  });

  it("restarts on another port", async () => {
    const { host, server } = setup();
    await host.enable(5000);
    await host.enable(5001);
    expect(server.starts).toEqual([5000, 5001]);
  });

  it("accepts the tailnet name as Host, and loopback only when testing", async () => {
    const { host } = setup();
    await host.enable();
    expect(host.allowedHosts()).toEqual(["mac.tail1.ts.net"]);
  });

  it("reports a port that is taken", async () => {
    const { host } = setup(ready, Object.assign(new Error("listen"), { code: "EADDRINUSE" }));
    const status = await host.enable();
    expect(status.listening).toBe(false);
    expect(status.error).toMatch(/Port 4517 is in use/);
  });

  it("changes nothing on the tailnet until serve is clicked", async () => {
    const { host, commands } = setup();
    await host.enable();
    expect(commands).toEqual([]);
    const status = await host.serve();
    expect(commands).toEqual([["serve", "--bg", "--https=443", "http://127.0.0.1:4517"]]);
    expect(status).toMatchObject({ serve: "on", url: "https://mac.tail1.ts.net", connected: 2 });
  });

  it("does not serve twice", async () => {
    const { host, commands } = setup();
    await host.enable();
    await host.serve();
    await host.serve();
    expect(commands).toHaveLength(1);
  });

  it("refuses to serve with Funnel on, and runs nothing", async () => {
    const { host, commands } = setup({ ...ready, funnel: true });
    await host.enable();
    await expect(host.serve()).rejects.toThrow(/Funnel/);
    expect(commands).toEqual([]);
    expect((await host.status()).serve).toBe("funnel_refused");
  });

  it("refuses to replace another service on 443 or serve when signed out", async () => {
    const other = setup({ ...ready, serving: { target: "http://127.0.0.1:9" } });
    await other.host.enable();
    await expect(other.host.serve()).rejects.toThrow(/already serves/);
    await expect(other.host.unserve()).rejects.toThrow(/not turning it off/);
    expect(other.commands).toEqual([]);
    const out = setup({ ...ready, loggedIn: false });
    await expect(out.host.serve()).rejects.toThrow(/Sign in/);
  });

  it("stops serving only its own mapping", async () => {
    const { host, commands } = setup();
    await host.enable();
    await host.serve();
    const status = await host.unserve();
    expect(commands.at(-1)).toEqual(["serve", "--https=443", "off"]);
    expect(status.serve).toBe("off");
  });

  it("publishes status changes", async () => {
    const { host, published } = setup();
    await host.enable();
    expect(published.at(-1)?.enabled).toBe(true);
    await host.setKeepAwake("always");
    expect(published.at(-1)?.keepAwake).toBe("always");
  });
});
