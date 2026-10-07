// Settings > Computer use: turn it on, fix macOS permissions and manage which apps pi may always operate. Policy
// lives in main (src/main/computer/store.ts); permission status comes live from the native helper, which starts only
// when this section asks (never in the background).
import { Check, RefreshCw, ShieldAlert, X } from "./icons";
import { useCallback, useEffect, useState } from "react";
import { type ComputerOp, type ComputerSettings, deniedApps, emptyComputerSettings, type Permissions } from "../../../shared/computer";
import { formatStamp } from "../lib/format";
import { remoteError, toast } from "../state/app";
import { Switch } from "./primitives";

const studio = () => window.studio.computer;

type Status = { state: "loading" } | { state: "ready"; permissions: Permissions } | { state: "error"; message: string };

export function useComputerSettings(): ComputerSettings {
  const [settings, setSettings] = useState(emptyComputerSettings);
  useEffect(() => {
    let live = true;
    void studio().get().then((next) => live && setSettings(next));
    const off = studio().onChange(setSettings);
    return () => {
      live = false;
      off();
    };
  }, []);
  return settings;
}

export async function applyComputer(op: ComputerOp): Promise<void> {
  try {
    await studio().apply(op);
  } catch (error) {
    toast(remoteError(error), "error");
  }
}

export function ComputerSection() {
  const settings = useComputerSettings();
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (load: () => Promise<Permissions>) => {
    setBusy(true);
    try {
      setStatus({ state: "ready", permissions: await load() });
    } catch (error) {
      setStatus({ state: "error", message: remoteError(error) });
    } finally {
      setBusy(false);
    }
  }, []);
  const recheck = useCallback(() => run(() => studio().permissions()), [run]);
  useEffect(() => void recheck(), [recheck]);
  // Coming back from System Settings: look again.
  useEffect(() => {
    const onFocus = () => void recheck();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [recheck]);

  const permissions = status.state === "ready" ? status.permissions : undefined;
  const open = (pane: "accessibility" | "screen_recording") => void studio().openSettings(pane).catch((error) => toast(remoteError(error), "error"));

  return (
    <div className="flex flex-col gap-7">
      <section className="flex items-start gap-4">
        <div className="flex-1">
          <h2 className="text-[13px] font-medium text-fg">Let pi use apps on this Mac</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            When on, new chats get the <code>computer_*</code> tools: pi can read an app's windows and operate them in the background with its own cursor, while you keep working. Chats already open pick the tools up when they restart. pi asks before it
            first uses each app.
          </p>
        </div>
        <span className="mt-0.5">
          <Switch on={settings.enabled} onChange={(on) => void applyComputer({ type: on ? "enable" : "disable" })} />
        </span>
      </section>

      <section>
        <div className="mb-2 flex items-center">
          <h2 className="flex-1 text-[13px] font-medium text-fg">Permissions</h2>
          <button type="button" onClick={() => void recheck()} disabled={busy} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg disabled:opacity-50">
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
            Re-check
          </button>
        </div>
        {status.state === "error" && <p className="mb-2 rounded-lg border border-line px-3 py-2 text-[12.5px] text-muted">Could not reach the Computer Use helper: {status.message}</p>}
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          <PermissionRow
            name="Accessibility"
            about="Read app windows and send clicks and keys."
            granted={permissions?.accessibility}
            unknown={status.state === "error"}
            onRequest={() => void run(() => studio().requestPermissions("accessibility"))}
            onOpen={() => open("accessibility")}
          />
          <PermissionRow
            name="Screen Recording"
            about="Take screenshots of app windows."
            granted={permissions?.screenRecording}
            unknown={status.state === "error"}
            onRequest={() => void run(() => studio().requestPermissions("screen_recording"))}
            onOpen={() => open("screen_recording")}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[13px] font-medium text-fg">Always allowed apps</h2>
        {settings.alwaysAllowed.length === 0 ? (
          <p className="rounded-lg border border-line px-3 py-3 text-[12.5px] text-faint">No apps yet. Choose "Always allow" when pi asks to use an app and it shows up here.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {settings.alwaysAllowed.map((entry) => (
              <li key={entry.bundleId} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-fg">{entry.name}</div>
                  <div className="truncate font-mono text-[11px] text-faint">
                    {entry.bundleId} · allowed {formatStamp(entry.at)}
                  </div>
                </div>
                <button type="button" onClick={() => void applyComputer({ type: "revoke", bundleId: entry.bundleId })} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg">
                  <X size={12} />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-[13px] font-medium text-fg">Never allowed</h2>
        <p className="mb-2 text-[12.5px] text-muted">No approval unlocks these apps.</p>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {deniedApps().map((group) => (
            <li key={group.reason} className="px-3 py-2" title={group.ids.join("\n")}>
              <div className="text-[13px] text-fg">{group.names.join(", ")}</div>
              <div className="text-[11.5px] text-faint">{group.reason}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex gap-3 rounded-lg border border-line px-3 py-3">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-muted" />
        <div className="text-[12.5px] leading-relaxed text-muted">
          <p>
            pi can see what an approved app's window shows (its text and a screenshot) and click, type and press keys in it. It never moves your mouse. Press <kbd className="font-mono">Esc</kbd> to cancel at any time.
          </p>
          <p className="mt-1.5">Close apps showing sensitive data (banking, passwords, private messages) before you let pi work, and check what it does the first time you approve an app.</p>
        </div>
      </section>
    </div>
  );
}

function PermissionRow({ name, about, granted, unknown, onRequest, onOpen }: { name: string; about: string; granted?: boolean; unknown?: boolean; onRequest: () => void; onOpen: () => void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{name}</div>
        <div className="text-[12px] text-faint">{about}</div>
      </div>
      {granted === undefined ? (
        <span className="text-[12px] text-faint">{unknown ? "Unknown" : "Checking…"}</span>
      ) : granted ? (
        <span className="flex items-center gap-1 text-[12px] text-muted">
          <Check size={13} />
          Granted
        </span>
      ) : (
        <>
          <span className="text-[12px] text-muted">Not granted</span>
          <button type="button" onClick={onRequest} className="rounded-md border border-line px-2 py-1 text-[12px] text-fg hover:bg-raised">
            Request
          </button>
          <button type="button" onClick={onOpen} className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg">
            Open System Settings
          </button>
        </>
      )}
    </div>
  );
}
