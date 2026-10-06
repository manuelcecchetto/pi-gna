// Settings > Remote access: turn it on, publish it on the tailnet, pair phones and revoke them (docs/REMOTE.md).
// Everything that changes the tailnet or lets a device in happens on a click here; the status comes from main.
import { Check, CircleAlert, Smartphone } from "./icons";
import { useEffect, useMemo, useState } from "react";
import type { DeviceInfo, PairingStatus, RemoteStatus } from "../../../shared/host-api";
import { KEEP_AWAKE_LABELS, KEEP_AWAKE_MODES } from "../../../shared/settings";
import { relativeTime } from "../lib/format";
import { qrCode } from "../lib/qr";
import { canServe, describeAgent, groupCode, pairingLink, remoteChecks } from "../lib/remote";
import { applySettings, remoteError, toast, useApp } from "../state/app";
import { Switch } from "./primitives";
import { Button, Card, ConfirmButton, NumberField, Row, Segmented } from "./SettingsControls";

/** Runs a remote call; a failure (Funnel on, port taken) is shown, not swallowed. */
async function attempt(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    toast(remoteError(error), "error");
  }
}

function useRemote() {
  const [status, setStatus] = useState<RemoteStatus>();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [pairing, setPairing] = useState<PairingStatus>({ state: "idle" });
  useEffect(() => {
    const remote = window.studio.remote;
    const off = [remote.onChange(setStatus), remote.onDevices(setDevices), remote.onPairing(setPairing)];
    const load = () => void remote.get().then(setStatus, (error) => toast(remoteError(error), "error"));
    load();
    void remote.devices().then(setDevices);
    void remote.pairing().then(setPairing);
    // Tailscale is changed outside pi-gna (sign-in, certificates): read it again when the window returns.
    window.addEventListener("focus", load);
    return () => {
      for (const stop of off) stop();
      window.removeEventListener("focus", load);
    };
  }, []);
  return { status, devices, pairing };
}

export function RemoteSection() {
  const remote = useApp((state) => state.settings.remote);
  const openAtLogin = useApp((state) => state.settings.openAtLogin);
  const { status, devices, pairing } = useRemote();
  const [busy, setBusy] = useState<"serve" | "unserve">();
  const serve = status ? canServe(status) : { ok: false };

  const run = (kind: "serve" | "unserve") => {
    setBusy(kind);
    void attempt(() => window.studio.remote[kind]()).finally(() => setBusy(undefined));
  };

  return (
    <>
      <Card>
        <Row title="Remote access" about="While on, closing the window hides it and pi-gna keeps running, so your phone can still reach it. Quit from the menu to stop.">
          <Switch on={remote.enabled} onChange={(on) => void attempt(() => (on ? window.studio.remote.enable() : window.studio.remote.disable()))} />
        </Row>
        <Row title="Port" about="Listens on 127.0.0.1 only; Tailscale serve forwards to it.">
          <NumberField value={remote.port} min={1024} max={65535} onCommit={(port) => void applySettings({ type: "remotePort", port })} />
        </Row>
        <Row title="Open at login" about="Start pi-gna when you log in to this Mac.">
          <Switch on={openAtLogin} onChange={(on) => void applySettings({ type: "openAtLogin", on })} />
        </Row>
      </Card>

      {status && (
        <Card title="Status" note="pi-gna only reads Tailscale until you click Serve over Tailscale. It never turns on Funnel.">
          {remoteChecks(status).map((check) => (
            <Row key={check.label} title={check.label} about={check.detail}>
              {check.ok ? <Check size={14} className="text-ok" /> : <CircleAlert size={14} className="text-warn" />}
              {check.fix && <Button onClick={() => window.studio.openExternal(check.fix!.url)}>{check.fix.label}</Button>}
            </Row>
          ))}
          <Row title="Address" about={status.url ? <span className="select-text font-mono">{status.url}</span> : serve.ok ? "Not published on your tailnet yet." : serve.why}>
            {status.serve === "on" ? (
              <Button onClick={() => run("unserve")} disabled={busy !== undefined}>
                Stop serving
              </Button>
            ) : (
              <Button primary onClick={() => run("serve")} disabled={!serve.ok || busy !== undefined} title="tailscale serve --bg --https=443">
                Serve over Tailscale
              </Button>
            )}
          </Row>
        </Card>
      )}

      <Card title="Keep awake" note="Keep awake prevents idle sleep only. A MacBook with its lid closed sleeps anyway, unless it is on power with an external display (clamshell mode). For use that does not depend on a laptop, run pi-gna on an always-on Mac.">
        <Row title="Prevent idle sleep" about={status?.awake ? "Held now." : "Only while remote access is on."}>
          <Segmented value={remote.keepAwake} options={KEEP_AWAKE_MODES} labels={KEEP_AWAKE_LABELS} onChange={(mode) => void applySettings({ type: "keepAwake", mode })} />
        </Row>
      </Card>

      <PairCard status={status} pairing={pairing} />

      <Card title="Devices" note={status ? `${status.connected} connected now.` : undefined}>
        {devices.length === 0 && <Row title="No paired devices" about="Pair a phone above." >{null}</Row>}
        {devices.map((device) => (
          <Row key={device.id} title={device.name} about={`${describeAgent(device.userAgent)}${device.tailnetLogin ? ` · ${device.tailnetLogin}` : ""} · last seen ${relativeTime(device.lastSeenAt)}`}>
            <ConfirmButton label="Revoke" confirm="Revoke?" onConfirm={() => void attempt(() => window.studio.remote.revoke(device.id))} />
          </Row>
        ))}
        {devices.length > 1 && (
          <Row title="Revoke all devices" about="Every phone must pair again.">
            <ConfirmButton label="Revoke all" confirm="Revoke all?" onConfirm={() => void attempt(() => window.studio.remote.revokeAll())} />
          </Row>
        )}
      </Card>
    </>
  );
}

/** The one-time code with the QR, and the approval prompt once a phone has used it. */
function PairCard({ status, pairing }: { status?: RemoteStatus; pairing: PairingStatus }) {
  const link = status?.url && pairing.code ? pairingLink(status.url, pairing.code) : undefined;
  const qr = useMemo(() => (link ? qrCode(link) : undefined), [link]);
  const request = pairing.request;
  return (
    <Card title="Pair a device" note="Open the address on your phone in Safari, tap Add to Home Screen, then open the app from there and enter the code. The code works once and expires in five minutes.">
      {request ? (
        <div className="flex flex-col gap-2 px-3 py-3">
          <div className="flex items-center gap-2 text-[13px] text-fg">
            <Smartphone size={14} /> {request.deviceName} wants to pair
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-muted">
            <dt>Device</dt>
            <dd className="select-text">{describeAgent(request.userAgent)}</dd>
            <dt>Browser</dt>
            <dd className="select-text break-all">{request.userAgent || "unknown"}</dd>
            <dt>Tailscale user</dt>
            <dd className="select-text">{request.tailnetLogin || "unknown"}</dd>
          </dl>
          <p className="text-[12px] text-faint">Allow only a device you just set up. A paired device can use every chat on this Mac.</p>
          <div className="flex gap-2">
            <Button primary onClick={() => void attempt(() => window.studio.remote.pairDecide(request.id, true))}>
              Allow
            </Button>
            <Button onClick={() => void attempt(() => window.studio.remote.pairDecide(request.id, false))}>Deny</Button>
          </div>
        </div>
      ) : pairing.state === "code_issued" && pairing.code ? (
        <div className="flex items-center gap-4 px-3 py-3">
          {qr && (
            <svg viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} className="size-32 shrink-0 rounded-md bg-white" role="img" aria-label="Pairing QR code" shapeRendering="crispEdges">
              <path d={qr.path} fill="#000" />
            </svg>
          )}
          <div className="min-w-0">
            <div className="select-text font-mono text-[22px] tracking-widest text-fg">{groupCode(pairing.code)}</div>
            <div className="mt-1 select-text break-all font-mono text-[12px] text-muted">{status?.url ?? "Serve over Tailscale first to get an address."}</div>
            {pairing.expiresAt && <div className="mt-1 text-[12px] text-faint">Expires {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>}
          </div>
        </div>
      ) : pairing.state === "locked" ? (
        <Row title="Code locked" about="Too many wrong codes. Make a new one.">
          <PairButton status={status} />
        </Row>
      ) : (
        <Row title="Pair a device" about={status?.listening ? undefined : "Turn remote access on first."}>
          <PairButton status={status} />
        </Row>
      )}
    </Card>
  );
}

function PairButton({ status }: { status?: RemoteStatus }) {
  return (
    <Button primary disabled={!status?.listening} onClick={() => void attempt(() => window.studio.remote.pairStart())}>
      New pairing code
    </Button>
  );
}
