// The host's remote access as one unit: the RemoteServer follows the settings (on only while remote.enabled), the
// tailnet publication goes through `tailscale serve` only on a click, and the Mac's Settings reads one RemoteStatus.
// Nothing here listens or changes the tailnet by itself (REMOTE.md s.11-12).
import type { DeviceInfo, KeepAwake, RemoteStatus } from "../shared/host-api";
import type { Revved } from "../shared/host-api";
import type { Settings, SettingsOp } from "../shared/settings";
import { allowedHosts, noTailscale, serveArgs, serveBlocker, serveState, type TailscaleStatus, unserveArgs, unserveBlocker } from "../shared/tailscale";
import type { Tailscale } from "./tailscale";

/** The slice of RemoteServer used here. */
export interface RemoteListener {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  readonly listening: boolean;
  readonly streamCount: number;
}

export interface RemoteHostOptions {
  server: RemoteListener;
  tailscale: Tailscale;
  settings: { get(): Promise<Revved<Settings>>; apply(op: SettingsOp): Promise<unknown> };
  devices: { list(): Promise<DeviceInfo[]> };
  /** The status changed: pushed to the window and the phones. */
  publish(status: RemoteStatus): void;
  /** The sleep blocker is held now. */
  awake(): boolean;
  /** Accept Host: 127.0.0.1/localhost too, for testing without Tailscale (PIGNA_REMOTE_LOOPBACK=1). */
  loopback?: boolean;
  log?(line: string): void;
  /** How often the tailnet name is re-read while listening. */
  refreshMs?: number;
}

export class RemoteHost {
  private tailnet: TailscaleStatus = noTailscale();
  private port = 0;
  private error?: string;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(private readonly o: RemoteHostOptions) {}

  /** Host header values the server accepts right now. */
  allowedHosts(): string[] {
    return allowedHosts(this.tailnet.dnsName, this.port, this.o.loopback === true);
  }

  /** Serialized: settings changes arrive faster than a server can start or stop. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Makes the server match the settings: listening exactly while remote access is on. Call after every settings change. */
  sync(): Promise<void> {
    return this.serial(async () => {
      const { remote } = await this.o.settings.get();
      const { server } = this.o;
      if (server.listening && (!remote.enabled || remote.port !== this.port)) {
        await server.stop();
        this.o.log?.(`remote server stopped`);
      }
      if (remote.enabled && !server.listening) {
        this.port = remote.port;
        try {
          await this.refresh();
          await server.start(remote.port);
          this.error = undefined;
          this.o.log?.(`remote server listening on 127.0.0.1:${remote.port}`);
        } catch (error) {
          this.error = (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Port ${remote.port} is in use. Pick another port.` : (error as Error).message;
          this.o.log?.(`remote server could not start: ${this.error}`);
        }
      }
      if (!remote.enabled) this.error = undefined;
      this.watch(server.listening);
      await this.announce();
    });
  }

  /** While listening, the tailnet name is re-read now and then (sign-in, renames); the timer never keeps the app alive. */
  private watch(on: boolean) {
    if (!on) return clearInterval(this.timer), (this.timer = undefined);
    this.timer ??= setInterval(() => void this.refresh().then(() => this.announce()), this.o.refreshMs ?? 60_000).unref();
  }

  private async refresh(): Promise<TailscaleStatus> {
    return (this.tailnet = await this.o.tailscale.status());
  }

  async status(): Promise<RemoteStatus> {
    const [{ remote }, devices] = await Promise.all([this.o.settings.get(), this.o.devices.list()]);
    const { tailnet } = this;
    const state = serveState(tailnet, remote.port);
    return {
      enabled: remote.enabled,
      port: remote.port,
      ...(state === "on" && tailnet.dnsName ? { url: `https://${tailnet.dnsName}` } : {}),
      serve: state,
      keepAwake: remote.keepAwake,
      awake: this.o.awake(),
      devices: devices.length,
      listening: this.o.server.listening,
      connected: this.o.server.streamCount,
      ...(this.error ? { error: this.error } : {}),
      tailscale: tailnet,
    };
  }

  /** Re-reads Tailscale and returns the status (the Settings page does this when it opens). */
  async check(): Promise<RemoteStatus> {
    await this.refresh();
    return this.status();
  }

  /** Push the current status to everyone who shows it. */
  async announce(): Promise<RemoteStatus> {
    const status = await this.status();
    this.o.publish(status);
    return status;
  }

  async enable(port?: number): Promise<RemoteStatus> {
    if (port !== undefined) await this.o.settings.apply({ type: "remotePort", port });
    await this.o.settings.apply({ type: "remoteEnabled", on: true });
    await this.sync();
    return this.status();
  }

  async disable(): Promise<RemoteStatus> {
    await this.o.settings.apply({ type: "remoteEnabled", on: false });
    await this.sync();
    return this.status();
  }

  async setKeepAwake(mode: KeepAwake): Promise<RemoteStatus> {
    await this.o.settings.apply({ type: "keepAwake", mode });
    return this.announce();
  }

  /** `Serve over Tailscale`: only on a click, never with Funnel on, never over another service. Throws the reason otherwise. */
  serve(): Promise<RemoteStatus> {
    return this.serial(async () => {
      const { remote } = await this.o.settings.get();
      const tailnet = await this.refresh();
      const blocker = serveBlocker(tailnet, remote.port);
      if (blocker) throw new Error(blocker);
      if (serveState(tailnet, remote.port) !== "on") {
        await this.o.tailscale.run(serveArgs(remote.port));
        this.o.log?.(`tailscale serve on for port ${remote.port}`);
      }
      await this.refresh();
      return this.announce();
    });
  }

  /** `Stop serving`: turns off the :443 mapping, only when it is pi-gna's. */
  unserve(): Promise<RemoteStatus> {
    return this.serial(async () => {
      const { remote } = await this.o.settings.get();
      const tailnet = await this.refresh();
      const blocker = unserveBlocker(tailnet, remote.port);
      if (blocker) throw new Error(blocker);
      if (tailnet.serving) {
        await this.o.tailscale.run(unserveArgs());
        this.o.log?.(`tailscale serve off`);
      }
      await this.refresh();
      return this.announce();
    });
  }

  async stop(): Promise<void> {
    this.watch(false);
    await this.o.server.stop();
  }
}
