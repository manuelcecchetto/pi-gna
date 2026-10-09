// Settings on the phone: the sections of the desktop page except Shortcuts. Every change goes through
// the same validated host methods as the desktop (settings.apply with baseRev for the choices, settings.setPi,
// computer.apply, devices.revoke), so the Mac shows it live; pairing a new device and the macOS permission prompts stay on the Mac.
import { Check, ChevronRight, RotateCcw, X } from "../renderer/src/components/icons";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../renderer/src/lib/store";
import { formatStamp, tildify } from "../renderer/src/lib/format";
import { WALLPAPER_LABELS } from "../renderer/src/lib/wallpapers";
import type { Permissions } from "../shared/computer";
import { deniedApps } from "../shared/computer";
import type { DeviceInfo, RemoteStatus } from "../shared/host-api";
import { PI_SETTINGS, type PiKey, type PiPatch, type PiSettingsState, type PiValue } from "../shared/pi-settings";
import type { Model, ThinkingLevel } from "../shared/protocol";
import {
  type Feature,
  FEATURE_LABELS,
  FEATURES,
  type SettingsOp,
  type Task,
  TASK_DEFAULTS,
  TASKS,
  type TaskModel,
  THEMES,
  THINKING_LEVELS,
  WALLPAPERS,
  emptySettings,
} from "../shared/settings";
import type { HostClient } from "./client/host-client";
import { snapshotOf } from "./client/host-client";
import { loadModels } from "./composer-data";
import type { Route } from "./nav";
import { disablePush, enablePush, browserPushEnv, pushAvailability, type PushAvailability } from "./push";
import { Header } from "./Screens";
import { canDownload, changeError, isMobileSection, MOBILE_SECTIONS, type MobileSection, SECTION_LABELS, TASK_INFO, updateSummary } from "./settings-data";
import { ModelSheet, Sheet } from "./Sheets";
import { ProvidersSection } from "./ProvidersSection";
import { toast } from "./toasts";

// ── Controls ─────────────────────────────────────────────────────────────────

function Card({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-4 pt-4">
      {title && <h2 className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wide text-faint">{title}</h2>}
      <div className="flex flex-col divide-y divide-line rounded-xl border border-line">{children}</div>
      {note && <p className="mt-1.5 px-1 text-[12px] leading-relaxed text-faint">{note}</p>}
    </section>
  );
}

function Row({ title, about, onReset, children, onClick, testId }: { title: string; about?: ReactNode; onReset?: () => void; children?: ReactNode; onClick?: () => void; testId?: string }) {
  const body = (
    <>
      <div className="min-w-0 flex-1 text-left">
        <div className="text-[15px] text-fg">{title}</div>
        {about && <div className="mt-0.5 text-[12px] leading-relaxed text-faint">{about}</div>}
      </div>
      {children}
    </>
  );
  return (
    <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5" data-testid={onClick ? undefined : testId}>
      {onClick ? (
        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 active:opacity-70" data-testid={testId}>
          {body}
        </button>
      ) : (
        body
      )}
      {onReset && (
        <button type="button" aria-label={`Reset ${title}`} onClick={onReset} className="grid h-9 w-9 shrink-0 place-items-center text-faint active:text-fg">
          <RotateCcw size={14} />
        </button>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-8 w-[52px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-accent" : "border border-line bg-raised"}`}
    >
      <span className={`absolute top-1 size-6 rounded-full bg-white transition-all ${on ? "left-[24px]" : "left-1"}`} />
    </button>
  );
}

const Value = ({ children, mono }: { children: ReactNode; mono?: boolean }) => (
  <span className={`flex shrink-0 items-center gap-1 text-[14px] text-muted ${mono ? "font-mono text-[13px]" : ""}`}>
    {children}
    <ChevronRight size={15} className="text-faint" />
  </span>
);

/** A row that picks one of a few values from a sheet. */
function ChoiceRow<T extends string>({ title, about, value, options, labels, mono, onChange, onReset }: { title: string; about?: ReactNode; value: T; options: readonly T[]; labels?: Partial<Record<T, string>>; mono?: boolean; onChange: (value: T) => void; onReset?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row title={title} about={about} onReset={onReset} onClick={() => setOpen(true)} testId={`choice-${title}`}>
        <Value mono={mono}>{labels?.[value] ?? value}</Value>
      </Row>
      {open && (
        <Sheet title={title} onClose={() => setOpen(false)} testId="choice-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setOpen(false);
                  if (option !== value) onChange(option);
                }}
                className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-[15px] ${option === value ? "text-accent" : "text-fg"} ${mono ? "font-mono text-[14px]" : ""}`}
                data-testid="choice-option"
              >
                {labels?.[option] ?? option}
                {option === value && <Check size={15} />}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}

/** A whole number, saved when the field loses focus. */
function NumberField({ value, min, max, onCommit, label }: { value: number; min: number; max: number; onCommit: (value: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number(text.replace(/[\s_,]/g, ""));
    if (text.trim() === "" || !Number.isSafeInteger(next) || next < min || next > max) {
      toast(`Enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}`, "warning");
      setText(String(value));
    } else if (next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      className="w-28 shrink-0 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-right font-mono text-[16px] text-fg outline-none"
    />
  );
}

const Button = ({ onClick, children, primary, disabled, testId }: { onClick: () => void; children: ReactNode; primary?: boolean; disabled?: boolean; testId?: string }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-testid={testId}
    className={`shrink-0 rounded-lg border px-3 py-2 text-[14px] disabled:opacity-50 ${primary ? "border-accent bg-accent font-medium text-white" : "border-line text-fg active:bg-raised"}`}
  >
    {children}
  </button>
);

/** Two taps: the first asks, the second (within three seconds) does it. */
function ConfirmButton({ label, confirm, onConfirm, testId }: { label: string; confirm: string; onConfirm: () => void; testId?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      className={`shrink-0 rounded-lg border px-3 py-2 text-[14px] ${armed ? "border-bad/50 bg-bad/10 text-bad" : "border-line text-muted"}`}
    >
      {armed ? confirm : label}
    </button>
  );
}

// ── Data ─────────────────────────────────────────────────────────────────────

/** Host settings with the change helpers; a refused change (or a conflict) toasts and reloads the latest. */
function useHostSettings(client: HostClient) {
  const settings = useStore(client.store, (s) => s.global.settings) ?? { ...emptySettings(), rev: 0 };
  const computer = useStore(client.store, (s) => s.global.computer);
  const reload = useCallback(async () => {
    const [nextSettings, nextComputer] = await Promise.all([client.call("settings.get", {}), client.call("computer.get", {})]);
    client.store.set((s) => ({ ...s, global: { ...s.global, settings: snapshotOf(nextSettings).value as typeof settings, computer: snapshotOf(nextComputer).value as typeof computer } }));
  }, [client]);
  const fail = useCallback(
    (error: unknown) => {
      toast(changeError(error).text, "error");
      void reload().catch(() => undefined);
    },
    [reload],
  );
  const apply = useCallback((op: SettingsOp) => client.call("settings.apply", { op, baseRev: settings.rev }).catch(fail), [client, fail, settings.rev]);
  const applyComputer = useCallback(
    (op: Parameters<typeof client.call<"computer.apply">>[1]["op"]) => client.call("computer.apply", { op, baseRev: computer?.rev }).catch(fail),
    [client, fail, computer?.rev],
  );
  return { settings, computer, apply, applyComputer };
}

type Pi = { state?: PiSettingsState; value(key: PiKey): PiValue | undefined; isSet(key: PiKey): boolean; set(patch: PiPatch): void };

/** pi's settings.json, read again when the page comes back to the foreground (the file may have been edited). */
function usePiSettings(client: HostClient): Pi {
  const [state, setState] = useState<PiSettingsState>();
  const load = useCallback(() => void client.call("settings.pi", {}).then(setState, (error) => toast(`Could not read pi's settings: ${changeError(error).text}`, "error")), [client]);
  useEffect(() => {
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);
  return {
    state,
    value: (key) => state?.values[key] ?? (("default" in PI_SETTINGS[key] ? PI_SETTINGS[key].default : undefined) as PiValue | undefined),
    isSet: (key) => state?.values[key] !== undefined,
    set: (patch) =>
      void client.call("settings.setPi", { patch }).then(setState, (error) => {
        toast(changeError(error).text, "error");
        load();
      }),
  };
}

function PiFileNote({ pi }: { pi: Pi }) {
  if (!pi.state) return <p className="px-5 pt-4 text-[12.5px] text-faint">Reading pi's settings…</p>;
  if (pi.state.problem) return <p className="mx-4 mt-4 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">pi's settings file cannot be changed: {pi.state.problem}</p>;
  return <p className="px-5 pt-3 font-mono text-[11px] break-all text-faint">{pi.state.path}</p>;
}

// ── Sections ─────────────────────────────────────────────────────────────────

function GeneralSection({ client, pi, homeDir }: { client: HostClient; pi: Pi; homeDir: string }) {
  const { settings, apply } = useHostSettings(client);
  return (
    <>
      <Card note="Starts pi-gna when you log in to the Mac.">
        <Row title="Open at login">
          <Toggle on={settings.openAtLogin} label="Open at login" onChange={(on) => void apply({ type: "openAtLogin", on })} />
        </Row>
      </Card>
      <Card note="pi owns this file on the Mac; changes apply to chats started afterwards. Reveal in Finder is on the Mac.">
        <Row title="pi's settings" about={pi.state ? <span className="font-mono break-all">{tildify(pi.state.path, homeDir)}</span> : "Reading…"} />
      </Card>
    </>
  );
}

function AppearanceSection({ client }: { client: HostClient }) {
  const { settings, apply } = useHostSettings(client);
  return (
    <>
      <Card note="This changes the Mac's window. The phone follows iOS's own appearance.">
        <ChoiceRow title="Mac theme" value={settings.theme} options={THEMES} onChange={(theme) => void apply({ type: "theme", theme })} />
      </Card>
      <Card title="Wallpaper" note="Behind a new chat on the Mac.">
        <ChoiceRow title="Wallpaper" value={settings.wallpaper} options={WALLPAPERS} labels={WALLPAPER_LABELS} onChange={(wallpaper) => void apply({ type: "wallpaper", wallpaper })} />
        <Row title="Loop" about="Show the next wallpaper at each new chat and each launch.">
          <Toggle on={settings.wallpaperLoop} label="Loop wallpapers" onChange={(loop) => void apply({ type: "wallpaperLoop", loop })} />
        </Row>
      </Card>
    </>
  );
}

/** Models pi offers, read from any live chat (pi lists them once a chat runs). */
function useModels(client: HostClient): Model[] | undefined {
  const handle = useStore(client.store, (s) => Object.keys(s.global.attention)[0]);
  const [models, setModels] = useState<Model[]>();
  useEffect(() => {
    if (!handle) return;
    let alive = true;
    void loadModels((command) => client.call("chat.command", { handle, command })).then((list) => alive && list && setModels(list));
    return () => {
      alive = false;
    };
  }, [client, handle]);
  return models;
}

function ModelPick({ title, models, value, onPick, onReset, about, unset }: { title: string; models?: Model[]; value?: { provider?: string; id: string }; onPick: (model: Model) => void; onReset?: () => void; about?: string; unset?: string }) {
  const [open, setOpen] = useState(false);
  const known = models?.find((m) => m.id === value?.id && (value.provider === undefined || m.provider === value.provider));
  return (
    <>
      <Row title={title} about={about} onReset={onReset} onClick={() => setOpen(true)} testId={`model-${title}`}>
        <Value>{value ? (known?.name ?? value.id) : (unset ?? "Not set")}</Value>
      </Row>
      {open && (
        <ModelSheet
          models={models ?? []}
          current={known}
          onClose={() => setOpen(false)}
          onPick={(model) => {
            setOpen(false);
            onPick(model);
          }}
        />
      )}
    </>
  );
}

function ModelsSection({ client, pi }: { client: HostClient; pi: Pi }) {
  const { settings, apply } = useHostSettings(client);
  const models = useModels(client);
  const tasks = TASKS.filter((task) => {
    const feature = TASK_INFO[task].feature;
    return !feature || settings.features[feature];
  });
  const provider = pi.value("defaultProvider") as string | undefined;
  const id = pi.value("defaultModel") as string | undefined;
  const setTask = (task: Task, model: TaskModel | null) => void apply({ type: "model", task, model });
  return (
    <>
      <PiFileNote pi={pi} />
      {!models && <p className="px-5 pt-3 text-[12px] text-faint">pi lists its models once a chat is running; open one to pick a model here.</p>}
      <Card title="New chats">
        <ModelPick
          title="Default model"
          about="The model a new chat starts on."
          models={models}
          value={id ? { provider, id } : undefined}
          unset="pi picks one"
          onPick={(model) => pi.set({ defaultProvider: model.provider, defaultModel: model.id })}
          onReset={pi.isSet("defaultModel") || pi.isSet("defaultProvider") ? () => pi.set({ defaultProvider: null, defaultModel: null }) : undefined}
        />
        <ChoiceRow
          title="Thinking level"
          about="The thinking level a new chat starts with."
          value={String(pi.value("defaultThinkingLevel"))}
          options={THINKING_LEVELS}
          mono
          onChange={(level) => pi.set({ defaultThinkingLevel: level })}
          onReset={pi.isSet("defaultThinkingLevel") ? () => pi.set({ defaultThinkingLevel: null }) : undefined}
        />
      </Card>
      {tasks.length > 0 && (
        <Card title="pi-gna's own work" note="For that work only: new chats keep your default.">
          {tasks.map((task) => {
            const custom = settings.models[task];
            const model = custom ?? TASK_DEFAULTS[task];
            return (
              <div key={task}>
                <ModelPick
                  title={TASK_INFO[task].title}
                  about={TASK_INFO[task].about}
                  models={models}
                  value={model}
                  onPick={(next) => setTask(task, { provider: next.provider, id: next.id, thinking: model.thinking })}
                  onReset={custom ? () => setTask(task, null) : undefined}
                />
                <div className="border-t border-line">
                  <ChoiceRow title="Thinking" value={model.thinking} options={THINKING_LEVELS as readonly ThinkingLevel[]} mono onChange={(thinking) => setTask(task, { ...model, thinking })} />
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </>
  );
}

const QUEUE_LABELS = { "one-at-a-time": "One at a time", all: "All at once" };
const TRUST_LABELS = { ask: "Ask", always: "Always", never: "Never" };
const WARMING_LABELS = { off: "Off", streaming: "During runs", idle: "Between runs too" };

function AgentSection({ client, pi }: { client: HostClient; pi: Pi }) {
  const { settings, apply } = useHostSettings(client);
  const reset = (...keys: PiKey[]) => (keys.some((key) => pi.isSet(key)) ? () => pi.set(Object.fromEntries(keys.map((key) => [key, null]))) : undefined);
  const toggle = (key: PiKey, title: string) => <Toggle on={pi.value(key) === true} label={title} onChange={(on) => pi.set({ [key]: on })} />;
  const choice = (key: PiKey, title: string, about: string, labels: Record<string, string>) => {
    const setting = PI_SETTINGS[key];
    return setting.type === "choice" ? <ChoiceRow title={title} about={about} value={String(pi.value(key))} options={setting.values} labels={labels} onChange={(value) => pi.set({ [key]: value })} onReset={reset(key)} /> : null;
  };
  const number = (key: PiKey, title: string, about: string) => {
    const setting = PI_SETTINGS[key];
    return setting.type === "integer" ? (
      <Row title={title} about={about} onReset={reset(key)}>
        <NumberField label={title} value={pi.value(key) as number} min={setting.min} max={setting.max} onCommit={(value) => pi.set({ [key]: value })} />
      </Row>
    ) : null;
  };
  return (
    <>
      <PiFileNote pi={pi} />
      <Card title="Beta">
        <Row title="Inline visuals" about="Agents may add small interactive HTML visuals to replies. Applies to chats you open afterwards.">
          <Toggle on={settings.visuals} label="Inline visuals" onChange={(on) => void apply({ type: "visuals", on })} />
        </Row>
      </Card>
      <Card title="Messages while pi works">
        {choice("steeringMode", "Steering", "Messages you send while pi works, delivered after its current step.", QUEUE_LABELS)}
        {choice("followUpMode", "Follow-ups", "Messages queued for when pi finishes.", QUEUE_LABELS)}
      </Card>
      <Card title="Context">
        <Row title="Compact automatically" about="Summarize older messages when the context fills up." onReset={reset("compaction.enabled")}>
          {toggle("compaction.enabled", "Compact automatically")}
        </Row>
        {number("compaction.reserveTokens", "Reserved tokens", "Room kept free for the model's reply.")}
        {number("compaction.keepRecentTokens", "Recent tokens kept", "The most recent context, kept as it is when older messages are summarized.")}
      </Card>
      <Card title="Errors">
        <Row title="Retry automatically" about="Try again when the provider fails with a passing error." onReset={reset("retry.enabled")}>
          {toggle("retry.enabled", "Retry automatically")}
        </Row>
        {number("retry.maxRetries", "Attempts", "Retries before pi gives up.")}
      </Card>
      <Card title="Images">
        <Row title="Resize images" about="Shrink images to at most 2000 × 2000 pixels before sending them." onReset={reset("images.autoResize")}>
          {toggle("images.autoResize", "Resize images")}
        </Row>
        <Row title="Block images" about="Never send images to the model." onReset={reset("images.blockImages")}>
          {toggle("images.blockImages", "Block images")}
        </Row>
      </Card>
      <Card title="More">
        <Row title="Skill commands" about="Offer every skill as a /skill:name command." onReset={reset("enableSkillCommands")}>
          {toggle("enableSkillCommands", "Skill commands")}
        </Row>
        {choice("cacheWarming", "Cache warming", "Keep the provider's prompt cache warm. Warming between runs costs money while you are away.", WARMING_LABELS)}
        {choice("defaultProjectTrust", "Trust new projects", "Whether pi loads a project's own settings, extensions and skills when you have not decided yet.", TRUST_LABELS)}
      </Card>
    </>
  );
}

const FEATURE_ABOUT: Record<Feature, string> = {
  kanban: "A board of cards per project, chats that resolve them, triage of new cards.",
  laments: "Where agents file the tools they missed.",
  github: "A project's issues and pull requests.",
  atp: "Plans that worker chats run node by node.",
};

function FeaturesSection({ client }: { client: HostClient }) {
  const { settings, computer, apply, applyComputer } = useHostSettings(client);
  const running = useStore(client.store, (s) => Object.keys(s.global.atp?.runners ?? {}).length);
  return (
    <Card>
      {FEATURES.map((feature) => {
        const locked = feature === "atp" && settings.features.atp && running > 0;
        return (
          <Row key={feature} title={FEATURE_LABELS[feature]} about={locked ? "Stop the running plan first." : FEATURE_ABOUT[feature]}>
            <Toggle on={settings.features[feature]} label={FEATURE_LABELS[feature]} disabled={locked} onChange={(enabled) => void apply({ type: "feature", feature, enabled })} />
          </Row>
        );
      })}
      <Row title="Computer use" about="The computer_* tools, which operate apps on the Mac. Permissions and apps are in Computer use.">
        <Toggle on={computer?.enabled ?? false} label="Computer use" onChange={(on) => void applyComputer({ type: on ? "enable" : "disable" })} />
      </Row>
    </Card>
  );
}

function ComputerSection({ client }: { client: HostClient }) {
  const { computer, applyComputer } = useHostSettings(client);
  const [permissions, setPermissions] = useState<Permissions>();
  const [problem, setProblem] = useState<string>();
  const check = useCallback(() => {
    setProblem(undefined);
    client.call("computer.permissions", {}).then(setPermissions, (error) => setProblem(`Could not reach the Computer Use helper on the Mac: ${changeError(error).text}`));
  }, [client]);
  useEffect(check, [check]);
  const granted = (value: boolean | undefined) => (value === undefined ? (problem ? "Unknown" : "Checking…") : value ? "Granted" : "Not granted");
  return (
    <>
      <Card note="When on, new chats get the computer_* tools: pi operates apps on the Mac in the background. pi asks before it first uses each app.">
        <Row title="Let pi use apps on the Mac">
          <Toggle on={computer?.enabled ?? false} label="Computer use" onChange={(on) => void applyComputer({ type: on ? "enable" : "disable" })} />
        </Row>
      </Card>
      <Card title="Permissions" note="Granting them happens on the Mac: System Settings > Privacy & Security, for pi-gna's helper.">
        <Row title="Accessibility" about={granted(permissions?.accessibility)} />
        <Row title="Screen recording" about={granted(permissions?.screenRecording)} />
        <Row title="Check again" onClick={check} />
      </Card>
      {problem && <p className="px-5 pt-2 text-[12.5px] wrap-anywhere text-warn">{problem}</p>}
      <Card title="Always allowed apps">
        {(computer?.alwaysAllowed.length ?? 0) === 0 ? (
          <p className="px-3.5 py-3 text-[13px] text-faint">No apps yet. Choose "Always allow" when pi asks to use an app.</p>
        ) : (
          computer?.alwaysAllowed.map((entry) => (
            <Row key={entry.bundleId} title={entry.name} about={`${entry.bundleId} · allowed ${formatStamp(entry.at)}`} testId="allowed-app">
              <button type="button" aria-label={`Revoke ${entry.name}`} onClick={() => void applyComputer({ type: "revoke", bundleId: entry.bundleId })} className="flex items-center gap-1 rounded-lg border border-line px-2.5 py-2 text-[13px] text-muted active:bg-raised" data-testid="revoke-app">
                <X size={13} /> Revoke
              </button>
            </Row>
          ))
        )}
      </Card>
      <Card title="Never allowed" note="No approval unlocks these apps.">
        {deniedApps().map((group) => (
          <Row key={group.reason} title={group.names.join(", ")} about={group.reason} />
        ))}
      </Card>
    </>
  );
}

function RemoteSection({ client, signOut }: { client: HostClient; signOut: ReactNode }) {
  const [devices, setDevices] = useState<DeviceInfo[]>();
  const [status, setStatus] = useState<RemoteStatus>();
  const load = useCallback(() => {
    void client.call("devices.list", {}).then(setDevices, (error) => toast(changeError(error).text, "error"));
    void client.call("remote.get", {}).then(setStatus, () => undefined);
  }, [client]);
  useEffect(load, [load]);
  const revoke = (device: DeviceInfo) => client.call("devices.revoke", { id: device.id }).then(setDevices, (error) => toast(changeError(error).text, "error"));
  return (
    <>
      {status && (
        <Card note="Switching remote access on or off and pairing a new device are done on the Mac.">
          <Row title="Remote access" about={status.enabled ? `On · ${status.connected} connected${status.url ? ` · ${status.url}` : ""}` : "Off"} />
        </Card>
      )}
      <Card title="Devices">
        {!devices && <p className="px-3.5 py-3 text-[13px] text-faint">Loading…</p>}
        {devices?.map((device) => (
          <Row key={device.id} title={device.name + (device.current ? " (this device)" : "")} about={`${device.tailnetLogin} · last seen ${formatStamp(device.lastSeenAt)}`} testId="device-row">
            {!device.current && <ConfirmButton label="Revoke" confirm="Revoke?" onConfirm={() => void revoke(device)} testId="revoke-device" />}
          </Row>
        ))}
      </Card>
      <NotificationsCard client={client} />
      {signOut}
    </>
  );
}

const PUSH_KIND_LABELS = {
  approval: "Approval needed",
  done: "Run finished",
  failed: "Run failed",
  plan: "Plan stopped or finished",
  host_quit: "pi-gna quitting on the Mac",
} as const;
type PushPrefs = Record<keyof typeof PUSH_KIND_LABELS, boolean>;

const PUSH_NOTES: Record<Exclude<PushAvailability, "ready">, string> = {
  unsupported: "This browser cannot receive notifications.",
  needs_install: "On iPhone, notifications work from the Home Screen app: Share, Add to Home Screen, then open pi-gna from there.",
  denied: "Notifications are blocked for pi-gna. Allow them in the iPhone's Settings > Notifications.",
};

/** Web Push for this phone. Pushes carry no text from the chat, only what happened; they only arrive while the Mac is awake and online. */
function NotificationsCard({ client }: { client: HostClient }) {
  const [availability] = useState(() => pushAvailability(browserPushEnv()));
  const [state, setState] = useState<{ subscribed: boolean; prefs: PushPrefs }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void client.call("push.state", {}).then(setState, () => undefined);
  }, [client]);
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : changeError(error).text, "error");
  const toggle = (on: boolean) => {
    setBusy(true);
    // Permission must be requested inside this tap, so the call starts synchronously.
    (on ? enablePush(client) : disablePush(client))
      .then(() => client.call("push.state", {}))
      .then(setState, fail)
      .finally(() => setBusy(false));
  };
  const setPref = (kind: keyof PushPrefs, on: boolean) => void client.call("push.setPrefs", { prefs: { [kind]: on } }).then((prefs) => setState((current) => current && { ...current, prefs }), fail);
  return (
    <Card title="Notifications" note={availability === "ready" ? "Sent through your phone's push service when the Mac is awake and reachable. Nothing from the chat is included." : PUSH_NOTES[availability]}>
      <Row title="Notify this phone" about={state?.subscribed ? "On" : "Off"} testId="push-row">
        <Toggle on={!!state?.subscribed} onChange={toggle} label="Notify this phone" disabled={busy || availability !== "ready" || !state} />
      </Row>
      {state?.subscribed &&
        (Object.keys(PUSH_KIND_LABELS) as (keyof PushPrefs)[]).map((kind) => (
          <Row key={kind} title={PUSH_KIND_LABELS[kind]} testId={`push-pref-${kind}`}>
            <Toggle on={state.prefs[kind]} onChange={(on) => setPref(kind, on)} label={PUSH_KIND_LABELS[kind]} />
          </Row>
        ))}
    </Card>
  );
}

function UpdatesSection({ client }: { client: HostClient }) {
  const update = useStore(client.store, (s) => s.global.update) ?? { phase: "idle" as const };
  const pending = update.phase === "idle" ? undefined : update.release;
  return (
    <Card note="Restarting to install is done on the Mac.">
      <Row title="pi-gna" about={updateSummary(update)} testId="update-row">
        {canDownload(update) && (
          <Button primary onClick={() => void client.call("update.download", {}).catch((error) => toast(changeError(error).text, "error"))} testId="update-download">
            Download
          </Button>
        )}
      </Row>
      {pending && <Row title="Release notes" about={pending.url} />}
    </Card>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export function SettingsScreen({ client, section, push, back, signOut }: { client: HostClient; section?: MobileSection; push: (route: Route) => void; back: () => void; signOut: ReactNode }) {
  const pi = usePiSettings(client);
  const [homeDir, setHomeDir] = useState("");
  useEffect(() => void client.call("app.info", {}).then((info) => setHomeDir(info.homeDir), () => undefined), [client]);
  const body = useMemo(() => {
    switch (section) {
      case "general":
        return <GeneralSection client={client} pi={pi} homeDir={homeDir} />;
      case "appearance":
        return <AppearanceSection client={client} />;
      case "providers":
        return <ProvidersSection client={client} />;
      case "models":
        return <ModelsSection client={client} pi={pi} />;
      case "agent":
        return <AgentSection client={client} pi={pi} />;
      case "features":
        return <FeaturesSection client={client} />;
      case "computer":
        return <ComputerSection client={client} />;
      case "remote":
        return <RemoteSection client={client} signOut={signOut} />;
      case "updates":
        return <UpdatesSection client={client} />;
      default:
        return undefined;
    }
  }, [client, pi, section, homeDir, signOut]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={section ? `settings-${section}` : "settings"}>
      <Header title={section && isMobileSection(section) ? SECTION_LABELS[section] : "Settings"} onBack={back} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        {body ?? (
          <Card>
            {MOBILE_SECTIONS.map((id) => (
              <Row key={id} title={SECTION_LABELS[id]} onClick={() => push({ screen: "settings", section: id })} testId={`section-${id}`}>
                <ChevronRight size={16} className="text-faint" />
              </Row>
            ))}
          </Card>
        )}
        {!body && <p className="px-5 pt-3 text-[12px] text-faint">Keyboard shortcuts and the Mac's own windows are on the Mac.</p>}
      </div>
    </div>
  );
}
