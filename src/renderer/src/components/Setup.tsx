// The first-run Setup flow: a few animated steps in a modal that get pi installed and connected. It opens by itself
// when pi is missing or broken, or on a first launch with no provider signed in; Settings > General opens it again.
// The first step asks who you are, the nerd 🤌 or the cool 🤌 (Settings.persona), and every later step speaks your
// language: commands, versions and npm's log for the nerd, plain words and a friendly progress bar for the other.
// It installs nothing behind your back: pi only with "Install pi", the rest is the Providers and Plugins sections.
// The checks and the install live in a module store, so closing Setup mid-install and opening it again picks up.
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy, ExternalLink, RotateCw, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Persona } from "../../../shared/settings";
import { MIN_NODE, PI_INSTALL_COMMAND, PI_PACKAGE, piReady, type SetupStatus } from "../../../shared/setup";
import bow from "../assets/setup/pigna-bow.webp";
import conduct from "../assets/setup/pigna-conduct.webp";
import cool from "../assets/setup/pigna-cool.webp";
import hammer from "../assets/setup/pigna-hammer.webp";
import joy from "../assets/setup/pigna-joy.webp";
import nerd from "../assets/setup/pigna-nerd.webp";
import plug from "../assets/setup/pigna-plug.webp";
import shock from "../assets/setup/pigna-shock.webp";
import { createStore, useStore } from "../lib/store";
import { applySettings, newChat, remoteError, setOverlay, store, useApp } from "../state/app";
import { PiSpinner } from "./PiLogo";
import { PluginsSection } from "./Plugins";
import { ProvidersSection } from "./Providers";

const STEPS = ["who", "pi", "model", "tools", "done"] as const;
type Step = (typeof STEPS)[number];

const DONE_KEY = "pigna:setup-done";
const NODE_URL = "https://nodejs.org/";
const README_FLAG = "pi install git:github.com/manuelcecchetto/pi-gna";
/** How long the install's confetti and celebration stay. */
const CELEBRATE_MS = 2500;

interface Install {
  phase: "idle" | "running" | "done" | "failed";
  lines: string[];
  error?: string;
  /** When it finished, for a one-time celebration. */
  doneAt?: number;
}

interface SetupState {
  open: boolean;
  status?: SetupStatus;
  checking: boolean;
  /** The last check could not reach main. */
  checkError?: string;
  install: Install;
}

const setupStore = createStore<SetupState>({ open: false, checking: false, install: { phase: "idle", lines: [] } });
const useSetup = <S,>(selector: (state: SetupState) => S) => useStore(setupStore, selector);
const patch = (change: Partial<SetupState>) => setupStore.set((state) => ({ ...state, ...change }));
const patchInstall = (change: Partial<Install>) => setupStore.set((state) => ({ ...state, install: { ...state.install, ...change } }));

export const openSetup = () => {
  if (setupStore.get().open) return;
  patch({ open: true });
  void check();
};

const closeSetup = () => {
  localStorage.setItem(DONE_KEY, "1");
  patch({ open: false });
  reviveChat();
};

/** The chat behind Setup failed to start while pi was missing: once pi works (and Setup is closed), give it a fresh
 * pi. Runs on close, and when an install finishes after you closed Setup. */
function reviveChat(): void {
  const { active, sessions, page } = store.get();
  const { status, open } = setupStore.get();
  if (!open && !page && active && sessions[active]?.phase === "exited" && status && piReady(status)) newChat();
}

let checks = 0;
async function check(): Promise<void> {
  const seq = ++checks;
  patch({ checking: true });
  const [result] = await Promise.all([
    window.studio.setup.status().then(
      (status) => ({ status }),
      (error: unknown) => ({ error: remoteError(error) }),
    ),
    // Long enough to see the checklist animate in, even when the checks are instant.
    new Promise((resolve) => setTimeout(resolve, 600)),
  ]);
  if (seq !== checks) return;
  patch("status" in result ? { status: result.status, checking: false, checkError: undefined } : { checking: false, checkError: result.error });
}

function installPi(): void {
  if (setupStore.get().install.phase === "running") return;
  patch({ install: { phase: "running", lines: [] } });
  void window.studio.setup
    .installPi()
    .catch((error: unknown) => ({ ok: false as const, error: remoteError(error) }))
    .then(async (result) => {
      // Still "running" while pi is checked again, so the celebration lands with the green checks.
      await check();
      patchInstall(result.ok ? { phase: "done", doneAt: Date.now() } : { phase: "failed", error: result.error });
      reviveChat();
    });
}

/** The steps' names in the progress bar, per persona. */
const STEP_LABELS: Record<Persona, Record<Step, string>> = {
  nerd: { who: "You", pi: "pi", model: "Providers", tools: "Plugins & MCP", done: "Done" },
  cool: { who: "You", pi: "Install", model: "Brain", tools: "Superpowers", done: "Done" },
};

/** Mounted once, in App: opens Setup when pi is not usable, or on a first launch that has no provider yet. */
export function SetupFlow() {
  const open = useSetup((state) => state.open);
  useEffect(() => window.studio.setup.onLine((line) => patchInstall({ lines: [...setupStore.get().install.lines.slice(-199), line] })), []);
  useEffect(() => {
    void (async () => {
      const status = await window.studio.setup.status().catch(() => undefined);
      if (!status) return;
      if (!piReady(status)) return openSetup();
      if (localStorage.getItem(DONE_KEY)) return;
      const auth = await window.studio.auth.list().catch(() => undefined);
      if (auth && !auth.error && !auth.providers.some((provider) => provider.status)) openSetup();
    })();
  }, []);
  return open ? <SetupDialog /> : null;
}

function SetupDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const saved = useApp((state) => state.settings.persona);
  // Until you pick, the saved persona (settings may arrive after Setup opens), else the cool one.
  const [picked, setPicked] = useState<Persona>();
  const persona = picked ?? saved ?? "cool";
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const status = useSetup((state) => state.status);
  const installing = useSetup((state) => state.install.phase === "running");
  const step = STEPS[index] as Step;
  // Chats need pi itself; its package only matters to Providers and Plugins, which say so.
  const piRuns = status?.pi !== null && status?.pi !== undefined && "version" in status.pi;

  useEffect(() => {
    dialog.current?.showModal();
    setOverlay(true); // the native browser view would draw over the dialog
    return () => setOverlay(false);
  }, []);

  const choose = (next: Persona) => {
    setPicked(next);
    void applySettings({ type: "persona", persona: next });
  };
  const go = (delta: 1 | -1) => {
    if (step === "who" && delta === 1 && saved === undefined) void applySettings({ type: "persona", persona });
    if (STEPS[index + delta] === "pi") void check(); // you may have fixed something in a terminal meanwhile
    setDirection(delta);
    setIndex((value) => Math.min(STEPS.length - 1, Math.max(0, value + delta)));
  };

  // Esc closes Setup only when nothing inside wanted it: a login prompt (window capture, preventDefault), a search
  // field (stopPropagation) or a field with text.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target;
    if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value !== "") return;
    event.preventDefault();
    closeSetup();
  };

  const next: { label: string; onClick: () => void } | null =
    step === "done"
      ? { label: persona === "nerd" ? "Open a chat" : "Let's go", onClick: closeSetup }
      : step === "pi" && !piRuns
        ? null
        : { label: "Continue", onClick: () => go(1) };

  return (
    <dialog
      ref={dialog}
      aria-label="Set up pi"
      onCancel={(event) => event.preventDefault() /* Esc is onKeyDown's */}
      onKeyDown={onKeyDown}
      className="setup-card m-auto hidden h-[min(660px,calc(100vh-48px))] w-[min(900px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-canvas p-0 text-fg open:flex backdrop:bg-black/50 backdrop:backdrop-blur-md"
    >
      <div className="setup-glow" aria-hidden />
      <header className="relative flex shrink-0 items-center gap-4 px-6 pt-5 pb-3">
        <Progress persona={persona} index={index} onPick={(target) => target < index && (setDirection(-1), setIndex(target))} />
        <button
          type="button"
          onClick={closeSetup}
          title={
            installing
              ? "Close; pi keeps installing (Settings › General › Run setup to come back)"
              : "Close (Esc). Settings › General › Run setup opens it again."
          }
          aria-label="Close setup"
          className="rounded-lg p-1.5 text-faint hover:bg-raised hover:text-fg"
        >
          <X size={15} />
        </button>
      </header>
      <div key={step} className="setup-step relative flex min-h-0 flex-1 flex-col" style={{ "--dir": direction } as React.CSSProperties}>
        {step === "who" ? (
          <WhoStep persona={persona} onChoose={choose} />
        ) : step === "pi" ? (
          <PiStep persona={persona} />
        ) : step === "model" ? (
          <SectionStep
            sprite={conduct}
            title={persona === "nerd" ? "Sign in to a provider" : "Give pi a brain"}
            about={
              persona === "nerd"
                ? "pi's /login, saved in pi's auth.json. Subscriptions (ChatGPT, Claude via Claude Code, Copilot…) or API keys; keys exported in your login shell work too."
                : "pi needs an AI to think with. Pay for ChatGPT or Claude? Sign in with that account. No subscription? You can paste a key from an AI company instead."
            }
            persona={persona}
            status={status}
          >
            <ProvidersSection simple={persona === "cool"} />
          </SectionStep>
        ) : step === "tools" ? (
          <SectionStep
            sprite={plug}
            title={persona === "nerd" ? "Plugins & MCP servers" : "Superpowers"}
            optional
            about={
              persona === "nerd"
                ? "pi packages (extensions, skills, prompts, themes) and mcp.json servers, the same state pi config and pi mcp edit."
                : "Let pi read and update the apps you already use. Not sure? Skip it; it's always in Settings."
            }
            persona={persona}
            status={status}
          >
            <PluginsSection cwd={window.studio.launchCwd || window.studio.homeDir} simple={persona === "cool"} />
          </SectionStep>
        ) : (
          <DoneStep persona={persona} />
        )}
      </div>
      <footer className="relative flex shrink-0 items-center gap-3 border-t border-line px-6 py-3.5">
        {index > 0 && (
          <button
            type="button"
            onClick={() => go(-1)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-fg"
          >
            <ArrowLeft size={13} /> Back
          </button>
        )}
        <div className="flex-1" />
        {next ? (
          <button type="button" onClick={next.onClick} className="setup-next flex items-center gap-1.5 rounded-xl px-4 py-2 text-[13px] font-medium">
            {next.label} <ArrowRight size={14} />
          </button>
        ) : (
          <span className="text-[12.5px] text-faint">{installing ? "Continue unlocks when pi is installed" : "Continue unlocks once pi is installed"}</span>
        )}
      </footer>
    </dialog>
  );
}

function Progress({ persona, index, onPick }: { persona: Persona; index: number; onPick: (index: number) => void }) {
  const labels = STEP_LABELS[persona];
  return (
    <ol className="flex flex-1 items-center gap-1.5">
      {STEPS.map((step, i) => (
        <li key={step} className="flex flex-1 items-center gap-1.5 last:flex-none">
          <button
            type="button"
            onClick={() => onPick(i)}
            disabled={i >= index}
            aria-current={i === index ? "step" : undefined}
            className={`flex items-center gap-1.5 rounded-full py-0.5 pr-1.5 text-[11.5px] whitespace-nowrap transition-colors ${i === index ? "text-fg" : i < index ? "text-muted hover:text-fg" : "text-muted"}`}
          >
            <span
              className={`setup-dot grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-medium ${i < index ? "done" : i === index ? "active" : ""}`}
            >
              {i < index ? <Check size={11} strokeWidth={3} /> : i + 1}
            </span>
            <span className={i === index ? "" : "max-[820px]:hidden"}>{labels[step]}</span>
          </button>
          {i < STEPS.length - 1 && (
            <span className="relative h-px min-w-3 flex-1 bg-line-strong">
              <span className="setup-track absolute inset-y-0 left-0" style={{ width: i < index ? "100%" : "0%" }} />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

// ── Step 1: the nerd or the cool one ─────────────────────────────────────────

const PERSONAS: Record<Persona, { sprite: string; title: string; about: string }> = {
  nerd: { sprite: nerd, title: "I live in the terminal", about: "Show me the commands, versions and logs. I like to know what runs." },
  cool: { sprite: cool, title: "I just want it to work", about: "No jargon please. Big buttons, plain words, done." },
};

function WhoStep({ persona, onChoose }: { persona: Persona; onChoose: (persona: Persona) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      {/* my-auto centers while it fits and scrolls from the top when it does not (justify-center would clip). */}
      <div className="my-auto flex flex-col items-center">
        <h1 className="setup-rise text-center text-[24px] font-semibold tracking-tight text-fg">Ciao! Who's setting up pi today?</h1>
        <p className="setup-rise mt-1.5 text-center text-[13px] text-muted" style={{ animationDelay: "60ms" }}>
          Pick one. Same pi either way, it only changes how much we tell you.
        </p>
        <div role="radiogroup" aria-label="Who is setting up pi" className="mt-6 flex items-stretch justify-center gap-5">
          {(["nerd", "cool"] as const).map((id, i) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={persona === id}
              onClick={() => onChoose(id)}
              className={`setup-persona flex w-[230px] flex-col items-center rounded-2xl px-4 pt-4 pb-4 ${persona === id ? "picked" : ""}`}
              style={{ animationDelay: `${120 + i * 90}ms` }}
            >
              <span className="setup-sprite-wrap flex h-[clamp(110px,24vh,190px)] items-end justify-center">
                <img src={PERSONAS[id].sprite} alt="" draggable={false} className={`setup-sprite h-full w-auto object-contain ${id}`} />
              </span>
              <span className="mt-3 text-[14px] font-medium text-fg">{PERSONAS[id].title}</span>
              <span className="mt-1 text-center text-[12px] leading-relaxed text-muted">{PERSONAS[id].about}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 2: pi itself ────────────────────────────────────────────────────────

const FUN_LINES = ["Pinching the fingers…", "Teaching pi some Italian…", "Unpacking the brain…", "Polishing the pigna…", "Almost there, promise…"];

function PiStep({ persona }: { persona: Persona }) {
  const { status, checking, checkError, install } = useSetup((state) => state);
  const nerdy = persona === "nerd";
  const node = status?.node;
  const pi = status?.pi;
  const broken = pi && "error" in pi ? pi.error : undefined;
  const ready = status !== undefined && pi !== null && pi !== undefined && !broken;
  const needsNode = status !== undefined && pi === null && (!node?.ok || !status.npm);
  const celebrating = install.phase === "done" && ready && Date.now() - (install.doneAt ?? 0) < CELEBRATE_MS;
  const sprite = install.phase === "running" ? hammer : install.phase === "failed" || needsNode || broken || checkError ? shock : ready ? joy : hammer;
  const title =
    install.phase === "running"
      ? "Installing pi"
      : !status
        ? checkError
          ? "Hmm, that didn't work"
          : "Looking around your Mac…"
        : broken
          ? nerdy
            ? "pi is installed but not answering"
            : "pi needs a hand"
          : ready
            ? install.phase === "done"
              ? "pi is installed!"
              : nerdy && pi && "version" in pi
                ? `pi ${pi.version} is ready`
                : "pi is already here"
            : needsNode
              ? nerdy
                ? `pi needs Node.js ${MIN_NODE.replace(/\.0$/, "")}+`
                : "One small thing first"
              : nerdy
                ? "pi is not installed"
                : "Let's get pi";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10 py-6">
      <div className="my-auto flex items-start justify-center gap-10">
        <div className="relative flex h-[clamp(120px,26vh,210px)] w-[clamp(110px,22vh,190px)] shrink-0 items-end justify-center">
          {celebrating && <Confetti />}
          <img
            key={sprite}
            src={sprite}
            alt=""
            draggable={false}
            className={`setup-pop h-full max-w-full object-contain ${install.phase === "running" ? "setup-hammer" : "setup-bob"}`}
          />
        </div>
        <div className="min-w-0 max-w-[480px] flex-1">
          <h1 className="setup-rise text-[24px] font-semibold tracking-tight text-fg">{title}</h1>
          <p className="setup-rise mt-1.5 text-[13px] leading-relaxed text-muted" style={{ animationDelay: "60ms" }}>
            {nerdy ? (
              <>
                pi-gna is a desktop UI for the pi coding agent: every chat is a <Mono>pi --mode rpc</Mono> child with your own pi config, found on your login
                shell's PATH.
              </>
            ) : ready ? (
              "All set: pi is on your Mac and ready to help."
            ) : (
              "pi is the assistant that does the work. pi-gna is the window where you chat with it. pi needs a one-time install on your Mac."
            )}
          </p>
          <Checklist persona={persona} status={status} checking={checking} installing={install.phase === "running"} failed={install.phase === "failed"} />
          <div className="mt-5">
            {install.phase === "running" ? (
              <Installing persona={persona} lines={install.lines} />
            ) : !status && checkError ? (
              <Retry persona={persona} text={nerdy ? `Could not check: ${checkError}` : "pi-gna could not look around your Mac."} checking={checking} />
            ) : broken ? (
              <Retry
                persona={persona}
                text={
                  nerdy
                    ? `\`pi --version\` failed: ${broken}. Fix it in a terminal (reinstall with ${PI_INSTALL_COMMAND}), then check again.`
                    : "pi is on your Mac but didn't answer. Restarting your Mac often helps; then check again."
                }
                checking={checking}
              />
            ) : install.phase === "failed" && !ready ? (
              <InstallFailed persona={persona} error={install.error ?? ""} lines={install.lines} checking={checking} />
            ) : status && needsNode ? (
              <NeedNode persona={persona} status={status} checking={checking} />
            ) : status && pi === null ? (
              <div className="setup-rise flex flex-col items-start gap-2" style={{ animationDelay: "380ms" }}>
                {nerdy && <CommandLine command={PI_INSTALL_COMMAND} />}
                <button
                  type="button"
                  onClick={installPi}
                  disabled={checking}
                  className="setup-next flex items-center gap-2 rounded-xl px-5 py-2.5 text-[14px] font-medium disabled:opacity-50"
                >
                  {nerdy ? "Run it for me" : "Install pi"}
                </button>
                <span className="text-[12px] text-faint">Takes about a minute.</span>
              </div>
            ) : ready && !status?.sdk ? (
              <Note>
                {nerdy
                  ? `pi runs, but pi-gna cannot find the ${PI_PACKAGE} package next to it (a wrapper script or PIGNA_PI_BIN?). Chats work; the next two steps need the package.`
                  : "pi works. A couple of extras could not be found, so the next two steps may not work; chats are fine."}
              </Note>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

type Row = { label: string; detail?: string; state: "ok" | "bad" | "todo" | "pending" };

function Checklist({
  persona,
  status,
  checking,
  installing,
  failed,
}: {
  persona: Persona;
  status?: SetupStatus;
  checking: boolean;
  installing: boolean;
  failed: boolean;
}) {
  const nerdy = persona === "nerd";
  // Not installed yet is a to-do, not a failure: red only for a Node.js that is too old, a broken pi or a failed install.
  const state = (ok: boolean | undefined, bad: boolean): Row["state"] =>
    checking || ok === undefined || (installing && !ok) ? "pending" : ok ? "ok" : bad ? "bad" : "todo";
  const pi = status?.pi;
  const rows: Row[] = [
    {
      label: nerdy ? `Node.js ≥ ${MIN_NODE.replace(/\.0$/, "")}` : "Node.js, a free helper pi needs",
      detail: status ? (status.node ? `v${status.node.version}${status.node.ok ? "" : " (too old)"}` : "not found") : undefined,
      state: state(status && Boolean(status.node?.ok && status.npm), Boolean(status?.node && !status.node.ok)),
    },
    {
      label: nerdy ? "pi CLI" : "pi itself",
      detail: pi ? ("version" in pi ? pi.version : "not answering") : status ? "not installed" : undefined,
      state: state(status && Boolean(pi && "version" in pi), Boolean(pi && "error" in pi) || failed),
    },
  ];
  // The package is a nerd's detail; the cool one only hears of it when it is missing next to a working pi.
  if (nerdy || (pi && "version" in pi && status && !status.sdk))
    rows.push({
      label: nerdy ? "pi SDK (logins, plugins)" : "Sign-in and plugin support",
      detail: status ? (status.sdk ? "found" : "not found") : undefined,
      state: state(status?.sdk, Boolean(pi && "version" in pi)),
    });
  return (
    <ul className="mt-5 flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <li key={row.label} className="setup-row flex items-center gap-2.5 text-[13px]" style={{ animationDelay: `${140 + i * 110}ms` }}>
          <span className={`setup-check grid h-5 w-5 shrink-0 place-items-center rounded-full ${row.state}`} style={{ animationDelay: `${300 + i * 140}ms` }}>
            {row.state === "pending" ? (
              <PiSpinner size={11} />
            ) : row.state === "ok" ? (
              <Check size={12} strokeWidth={3} />
            ) : row.state === "bad" ? (
              <X size={12} strokeWidth={3} />
            ) : null}
          </span>
          <span className="text-fg">{row.label}</span>
          {nerdy && row.detail && row.state !== "pending" && <span className="font-mono text-[11.5px] text-faint">{row.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function Installing({ persona, lines }: { persona: Persona; lines: string[] }) {
  const [fun, setFun] = useState(0);
  const [details, setDetails] = useState(persona === "nerd");
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setFun((value) => (value + 1) % FUN_LINES.length), 2400);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, details]);
  return (
    <div className="setup-rise flex flex-col gap-2.5">
      <div className="setup-bar" />
      <div className="flex items-center gap-2 text-[12.5px]">
        <PiSpinner size={12} />
        <span key={fun} className="setup-fun shimmer min-w-0 truncate">
          {persona === "nerd" ? PI_INSTALL_COMMAND : FUN_LINES[fun]}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setDetails((value) => !value)}
          aria-expanded={details}
          className="flex shrink-0 items-center gap-1 text-[11.5px] text-faint hover:text-fg"
        >
          {details ? "Hide" : "Show"} details <ChevronDown size={12} className={details ? "rotate-180" : ""} />
        </button>
      </div>
      {details && <Log ref={log} lines={lines.length ? lines : ["Waiting for npm…"]} className="h-28" />}
    </div>
  );
}

function InstallFailed({ persona, error, lines, checking }: { persona: Persona; error: string; lines: string[]; checking: boolean }) {
  return (
    <div className="setup-rise flex flex-col gap-3">
      <Note>
        {persona === "nerd" ? error : "The install did not go through. Try once more. If it fails again, copy the command and ask someone techy to run it in Terminal."}
      </Note>
      {persona === "nerd" && lines.length > 0 && <Log lines={lines.slice(-12)} className="max-h-24" />}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={installPi}
          disabled={checking}
          className="setup-next flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-50"
        >
          <RotateCw size={13} /> Try again
        </button>
        <CopyChip text={PI_INSTALL_COMMAND} label="Copy the command" />
      </div>
    </div>
  );
}

function NeedNode({ persona, status, checking }: { persona: Persona; status: SetupStatus; checking: boolean }) {
  const nerdy = persona === "nerd";
  return (
    <div className="setup-rise flex flex-col items-start gap-3" style={{ animationDelay: "380ms" }}>
      <p className="text-[13px] leading-relaxed text-muted">
        {nerdy
          ? status.node
            ? `Your node is v${status.node.version}; pi needs ${MIN_NODE} or newer. Upgrade it (Homebrew, nvm, or the installer), then check again.`
            : status.npm
              ? "No node on your login shell's PATH. Install it, then check again."
              : "No node or npm on your login shell's PATH. Install Node.js (it brings npm), then check again."
          : status.node
            ? "pi needs a newer Node.js, the free helper it runs on. Download it from nodejs.org, open the installer and click Continue until it's done, then come back here."
            : "pi runs on a free helper called Node.js. Download it from nodejs.org (the big green button), open the installer and click Continue until it's done, then come back here."}
      </p>
      {nerdy && status.brew && <CommandLine command={status.node ? "brew upgrade node" : "brew install node"} />}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.studio.openExternal(NODE_URL)}
          className="setup-next flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-[12.5px] font-medium"
        >
          <ExternalLink size={13} /> {nerdy ? "nodejs.org" : "Download Node.js"}
        </button>
        <CheckAgain persona={persona} checking={checking} />
      </div>
    </div>
  );
}

function Retry({ persona, text, checking }: { persona: Persona; text: string; checking: boolean }) {
  return (
    <div className="setup-rise flex flex-col items-start gap-3">
      <Note>{text}</Note>
      <CheckAgain persona={persona} checking={checking} />
    </div>
  );
}

function CheckAgain({ persona, checking }: { persona: Persona; checking: boolean }) {
  return (
    <button
      type="button"
      onClick={() => void check()}
      disabled={checking}
      className="flex items-center gap-1.5 rounded-xl border border-line-strong px-3.5 py-1.5 text-[12.5px] text-fg hover:bg-raised disabled:opacity-50"
    >
      <RotateCw size={13} className={checking ? "spin" : ""} /> {persona === "nerd" ? "Check again" : "I've done it, check again"}
    </button>
  );
}

// ── Steps 3 and 4: the Settings sections, framed ─────────────────────────────

function SectionStep({
  sprite,
  title,
  optional,
  about,
  persona,
  status,
  children,
}: {
  sprite: string;
  title: string;
  optional?: boolean;
  about: string;
  persona: Persona;
  status?: SetupStatus;
  children: ReactNode;
}) {
  const runs = status?.pi !== null && status?.pi !== undefined && "version" in status.pi;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-4 px-8 pt-3 pb-3">
        <img src={sprite} alt="" draggable={false} className="setup-pop setup-bob h-[84px] w-[84px] shrink-0 object-contain" />
        <div className="min-w-0">
          <h1 className="setup-rise flex items-center gap-2 text-[20px] font-semibold tracking-tight text-fg">
            {title}
            {optional && <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-normal tracking-normal text-muted">Optional</span>}
          </h1>
          <p className="setup-rise mt-1 text-[12.5px] leading-relaxed text-muted" style={{ animationDelay: "60ms" }}>
            {about}
          </p>
        </div>
      </div>
      <div className="setup-rise min-h-0 flex-1 overflow-y-auto px-8 pt-1 pb-6 [scrollbar-gutter:stable]" style={{ animationDelay: "140ms" }}>
        {runs && status?.sdk ? (
          <div className="flex flex-col gap-6">{children}</div>
        ) : (
          <Note>
            {!runs
              ? persona === "nerd"
                ? "pi is not installed yet, so there is nothing to configure. Go back a step."
                : "Install pi first (one step back), then come here."
              : persona === "nerd"
                ? `This needs pi's package (${PI_PACKAGE}) next to the pi on your PATH; pi-gna could not find it. Use /login and pi config in a terminal instead.`
                : "This part needs a piece of pi that could not be found. Chats still work; someone techy can set this up later."}
          </Note>
        )}
      </div>
    </div>
  );
}

// ── Step 5 ───────────────────────────────────────────────────────────────────

function DoneStep({ persona }: { persona: Persona }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <div className="my-auto flex flex-col items-center text-center">
        <div className="relative flex h-[clamp(110px,24vh,180px)] items-end justify-center">
          <Confetti />
          <img src={bow} alt="" draggable={false} className="setup-pop setup-bow h-full w-auto object-contain" />
        </div>
        <h1 className="setup-rise mt-5 text-[24px] font-semibold tracking-tight text-fg" style={{ animationDelay: "200ms" }}>
          Pronto!
        </h1>
        <p className="setup-rise mt-1.5 max-w-md text-[13px] leading-relaxed text-muted" style={{ animationDelay: "280ms" }}>
          {persona === "nerd" ? (
            <>
              New chats run your pi with your config, in the project you open. Tip: <Mono>{README_FLAG}</Mono> adds <Mono>pi --pigna</Mono>, which opens pi-gna
              from a terminal. Settings › General runs this setup again.
            </>
          ) : (
            "Ask pi for anything: tidy a document, build a simple web page, explain what's in a folder. It works inside the folder a chat is in, so pick one you're happy for it to change."
          )}
        </p>
      </div>
    </div>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

const CONFETTI = ["#f09082", "#4d9abf", "#f1be58"];

function Confetti() {
  return (
    <div className="setup-confetti pointer-events-none absolute top-1/2 left-1/2" aria-hidden>
      {Array.from({ length: 18 }, (_, i) => {
        const angle = (i / 18) * Math.PI * 2;
        const distance = 90 + (i % 3) * 28;
        return (
          <span
            key={i}
            style={
              {
                "--x": `${Math.cos(angle) * distance}px`,
                "--y": `${Math.sin(angle) * distance - 20}px`,
                "--r": `${(i * 47) % 360}deg`,
                background: CONFETTI[i % 3],
                animationDelay: `${(i % 4) * 30}ms`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

function Log({ lines, className = "", ref }: { lines: string[]; className?: string; ref?: React.Ref<HTMLPreElement> }) {
  return (
    <pre
      ref={ref}
      className={`selectable overflow-y-auto rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-muted ${className}`}
    >
      {lines.join("\n")}
    </pre>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex max-w-full items-center gap-2 rounded-lg border border-line bg-sunken py-1.5 pr-1.5 pl-3 font-mono text-[11.5px] text-fg">
      <span className="text-faint">$</span>
      <span className="selectable min-w-0 truncate">{command}</span>
      <CopyChip text={command} label="Copy" />
    </div>
  );
}

function CopyChip({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      className="grid shrink-0 rounded-md border border-line px-2 py-1 font-sans text-[11.5px] text-muted hover:bg-raised hover:text-fg"
    >
      {/* Both labels share one grid cell, so the chip keeps the wider one's width. */}
      <span className={`col-start-1 row-start-1 flex items-center gap-1 ${copied ? "invisible" : ""}`}>
        <Copy size={12} /> {label}
      </span>
      <span className={`col-start-1 row-start-1 flex items-center justify-center gap-1 ${copied ? "" : "invisible"}`}>
        <Check size={12} className="text-ok" /> Copied
      </span>
    </button>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="rounded bg-raised px-1 py-px font-mono text-[11.5px] text-fg">{children}</span>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[12.5px] text-fg">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
      <p className="selectable min-w-0 break-words">{children}</p>
    </div>
  );
}
