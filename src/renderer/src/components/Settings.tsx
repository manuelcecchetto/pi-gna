// The Settings page (⌘,): pi-gna's own settings (main's settings.json: features, appearance, the models of the chats
// pi-gna starts), the pi settings it edits in pi's settings.json (pi reads them when a chat starts, so they apply to
// new chats) and Computer Use. While it is open, the sidebar lists its sections instead of the chats (SettingsNav).
import { ArrowLeft, Bot, Cpu, FolderOpen, KeyRound, Keyboard, type LucideIcon, Monitor, Palette, Search, Settings2, Smartphone, ToggleRight, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PI_SETTINGS, type PiKey, type PiPatch, type PiSettingsState, type PiValue } from "../../../shared/pi-settings";
import { type Feature, FEATURE_LABELS, FEATURES, type SettingsSection, type Task, TASK_DEFAULTS, TASKS, type TaskModel, KEEP_AWAKE_LABELS, KEEP_AWAKE_MODES, THEMES, type Theme, THINKING_LEVELS, WALLPAPERS } from "../../../shared/settings";
import { tildify } from "../lib/format";
import { WALLPAPER_LABELS, wallpaperStyle } from "../lib/wallpapers";
import { applySettings, closeSettings, openSettings, type PageState, remoteError, showUpdate, toast, useApp } from "../state/app";
import { useAtp } from "../state/atp";
import { applyComputer, ComputerSection, useComputerSettings } from "./Computer";
import { DigitHint, Kbd, Switch, useCommandDigits } from "./primitives";
import { ProvidersSection } from "./Providers";
import { RemoteSection } from "./Remote";
import { Button, Card, Choice, ModelChoice, NumberField, Row, Segmented } from "./SettingsControls";
import { COLLAPSED_INSET } from "./Sidebar";

type Group = "pi-gna" | "pi" | "Integrations";

interface SectionInfo {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: Group;
  about: string;
  /** What the search finds it by, besides its label. */
  keywords: string;
}

const SECTIONS: SectionInfo[] = [
  { id: "general", label: "General", icon: Settings2, group: "pi-gna", about: "pi-gna's version, and where pi keeps the settings this page changes.", keywords: "version update about settings.json file folder" },
  { id: "appearance", label: "Appearance", icon: Palette, group: "pi-gna", about: "How pi-gna looks.", keywords: "theme dark light system mode color wallpaper background backdrop empty state image loop cycle rotate shuffle" },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, group: "pi-gna", about: "Hold ⌘ anywhere to see ⌘1–⌘9 on the chats in the sidebar.", keywords: "keys hotkeys keyboard command" },
  {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    group: "pi",
    about: "Sign in to the providers pi runs models on, the way pi's /login does: with your account or subscription, or with an API key.",
    keywords: "login log in sign in sign out logout auth authentication api key keys account subscription oauth credentials claude anthropic chatgpt openai codex copilot",
  },
  {
    id: "models",
    label: "Models",
    icon: Cpu,
    group: "pi",
    about: "The model new chats start on, and the models of the chats pi-gna starts itself.",
    keywords: "default model provider thinking level triage card atp orchestrator worker",
  },
  {
    id: "agent",
    label: "Agent",
    icon: Bot,
    group: "pi",
    about: "How pi works in new chats.",
    keywords: "steering follow-up queue messages compaction context summarize retry errors images resize block skills commands cache warming project trust",
  },
  {
    id: "features",
    label: "Features",
    icon: ToggleRight,
    group: "Integrations",
    about: "Turn off what you do not use. A feature that is off leaves the sidebar and the menus, and new chats get none of its tools; chats already open are refused when they call them.",
    keywords: "kanban board cards laments github issues pull requests atp plans computer use turn off disable tools",
  },
  {
    id: "remote",
    label: "Remote access",
    icon: Smartphone,
    group: "Integrations",
    about: "Serve pi-gna to your phone over Tailscale. Chats, tools and files stay on this Mac.",
    keywords: "iphone phone mobile tailscale remote keep awake sleep login lid clamshell port",
  },
  { id: "computer", label: "Computer use", icon: Monitor, group: "Integrations", about: "The computer_* tools: what pi may operate on this Mac, and the macOS permissions they need.", keywords: "apps mac accessibility screen recording permissions always allowed denylist" },
];

const GROUPS: Group[] = ["pi-gna", "pi", "Integrations"];

const matches = (section: SectionInfo, query: string): boolean => {
  const text = `${section.label} ${section.keywords}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
};

// ── The sidebar's section list ───────────────────────────────────────────────

export function SettingsNav({ current }: { current?: SettingsSection }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => SECTIONS.filter((section) => matches(section, query)), [query]);
  const hints = useCommandDigits(useMemo(() => shown.map((section) => () => openSettings(section.id)), [shown]));
  return (
    <>
      <div className="px-2 pb-1">
        <button type="button" onClick={closeSettings} className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-fg/90 hover:bg-raised/60">
          <ArrowLeft size={14} className="shrink-0 text-muted" />
          <span className="flex-1">Back to app</span>
          <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">esc</span>
        </button>
      </div>
      <div className="px-2 pb-2">
        <label className="flex items-center gap-2 rounded-lg bg-sunken px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-line-strong">
          <Search size={13} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && shown[0]) openSettings(shown[0].id);
              else if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search settings"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
          />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {GROUPS.map((group) => {
          const sections = shown.filter((section) => section.group === group);
          if (!sections.length) return null;
          return (
            <div key={group} className="mb-3">
              <div className="px-2.5 pt-1 pb-1 text-[12px] font-medium text-faint">{group}</div>
              {sections.map((section) => {
                const Icon = section.icon;
                const digit = shown.indexOf(section) + 1;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => openSettings(section.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${current === section.id ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
                  >
                    <Icon size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    {hints && digit <= 9 && <DigitHint digit={digit} />}
                  </button>
                );
              })}
            </div>
          );
        })}
        {!shown.length && <p className="px-2.5 py-2 text-[12.5px] text-faint">No settings match “{query}”.</p>}
      </nav>
    </>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function SettingsPage({ page }: { page: PageState }) {
  const inset = useApp((state) => state.sidebar.collapsed);
  const section = SECTIONS.find((other) => other.id === page.section) ?? (SECTIONS[0] as SectionInfo);
  const pi = usePiSettings();
  const Icon = section.icon;
  return (
    <div className="page-enter flex h-full min-w-0 flex-col">
      <header className="drag dashed-b titlebar flex shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <span className="text-[13.5px] text-faint">Settings</span>
        <span className="text-[13.5px] text-faint">/</span>
        <Icon size={15} className="text-muted" />
        <span className="text-[13.5px] font-medium text-fg">{section.label}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-6 pb-12 [scrollbar-gutter:stable]">
        <div key={section.id} className="mx-auto flex max-w-2xl flex-col gap-7">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-fg">{section.label}</h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{section.about}</p>
          </div>
          {section.id === "general" ? (
            <GeneralSection pi={pi} />
          ) : section.id === "appearance" ? (
            <AppearanceSection />
          ) : section.id === "shortcuts" ? (
            <ShortcutsSection />
          ) : section.id === "providers" ? (
            <ProvidersSection />
          ) : section.id === "models" ? (
            <ModelsSection pi={pi} />
          ) : section.id === "agent" ? (
            <AgentSection pi={pi} />
          ) : section.id === "features" ? (
            <FeaturesSection />
          ) : section.id === "remote" ? (
            <RemoteSection />
          ) : (
            <ComputerSection />
          )}
        </div>
      </div>
    </div>
  );
}

// ── pi's settings.json ───────────────────────────────────────────────────────

interface Pi {
  state?: PiSettingsState;
  /** The key's value: set in the file, else pi's default. */
  value(key: PiKey): PiValue | undefined;
  /** Set in the file (not at pi's default by omission). */
  isSet(key: PiKey): boolean;
  set(patch: PiPatch): void;
}

/** pi's settings, read again when you come back to the window (you may have edited the file). */
function usePiSettings(): Pi {
  const [state, setState] = useState<PiSettingsState>();
  const load = useCallback(() => {
    void window.studio.settings.pi().then(setState, (error) => toast(`Could not read pi's settings: ${remoteError(error)}`, "error"));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const set = useCallback(
    (patch: PiPatch) => {
      void window.studio.settings.setPi(patch).then(setState, (error) => {
        toast(remoteError(error), "error");
        load();
      });
    },
    [load],
  );
  return {
    state,
    value: (key) => {
      const setting = PI_SETTINGS[key];
      return state?.values[key] ?? ("default" in setting ? setting.default : undefined);
    },
    isSet: (key) => state?.values[key] !== undefined,
    set,
  };
}

/** Where pi's settings are saved, and when the file cannot be changed, why. */
function PiFileNote({ pi }: { pi: Pi }) {
  const path = pi.state?.path;
  if (pi.state?.problem) {
    return (
      <div className="flex gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[12.5px] text-fg">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="selectable break-words">{pi.state.problem}</p>
          <p className="mt-1 text-muted">pi-gna changes nothing in it until it reads again.</p>
        </div>
      </div>
    );
  }
  return (
    <p className="text-[12px] leading-relaxed text-faint">
      Saved in pi's{" "}
      <button type="button" onClick={() => void window.studio.settings.revealPi()} className="font-mono text-muted underline decoration-line-strong underline-offset-2 hover:text-fg">
        {path ? tildify(path, window.studio.homeDir) : "settings.json"}
      </button>
      , which pi in the terminal uses too. New chats start with them; open chats keep theirs. A project's .pi/settings.json can override them.
    </p>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function GeneralSection({ pi }: { pi: Pi }) {
  const update = useApp((state) => state.update);
  const path = pi.state?.path;
  return (
    <>
      <Card>
        <Row title="Version" about={update.phase === "idle" ? "pi-gna looks for a newer release at launch and every few hours (pi-gna > Check for Updates…)." : undefined}>
          <span className="font-mono text-[12px] text-muted">{window.studio.version}</span>
          {update.phase !== "idle" && (
            <button type="button" onClick={() => showUpdate(true)} className="rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90">
              {update.phase === "ready" ? "Restart to update" : update.phase === "failed" ? "Update failed" : `Update to ${update.release.version}`}
            </button>
          )}
        </Row>
        <Row title="pi's settings" about={path ? <span className="font-mono">{tildify(path, window.studio.homeDir)}</span> : "Reading…"}>
          <Button onClick={() => void window.studio.settings.revealPi()}>
            <FolderOpen size={12} /> Show in Finder
          </Button>
        </Row>
      </Card>
      {pi.state?.problem && <PiFileNote pi={pi} />}
    </>
  );
}

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

function AppearanceSection() {
  const theme = useApp((state) => state.settings.theme);
  const wallpaper = useApp((state) => state.settings.wallpaper);
  const loop = useApp((state) => state.settings.wallpaperLoop);
  return (
    <>
      <Card>
        <Row title="Theme" about="System follows macOS's appearance.">
          <Segmented value={theme} options={THEMES} labels={THEME_LABELS} onChange={(next) => void applySettings({ type: "theme", theme: next })} />
        </Row>
      </Card>
      <Card title="Wallpaper" note="Behind a new chat, above the composer. Each one is painted at dusk for the dark theme and by day for the light one.">
        <div className="grid grid-cols-4 gap-3 p-3">
          {WALLPAPERS.map((id) => {
            const style = wallpaperStyle(id, true);
            const on = id === wallpaper;
            return (
              <button key={id} type="button" aria-pressed={on} onClick={() => !on && void applySettings({ type: "wallpaper", wallpaper: id })} className="group flex flex-col gap-1.5 text-left">
                <span
                  style={style}
                  className={`aspect-video w-full rounded-md ${style ? "wallpaper-thumb" : "border border-dashed border-line-strong bg-canvas"} ${on ? "ring-2 ring-accent ring-offset-2 ring-offset-canvas" : ""}`}
                />
                <span className={`text-[12px] ${on ? "text-fg" : "text-muted group-hover:text-fg"}`}>{WALLPAPER_LABELS[id]}</span>
              </button>
            );
          })}
        </div>
        <Row title="Loop" about="Show the next wallpaper at each new chat and each launch, starting from the one picked.">
          <Switch on={loop} onChange={(on) => void applySettings({ type: "wallpaperLoop", loop: on })} />
        </Row>
      </Card>
    </>
  );
}

const SHORTCUTS: { title: string; keys: [string, string][] }[] = [
  {
    title: "App",
    keys: [
      ["⌘N", "New chat"],
      ["⌘,", "Settings"],
      ["⌘1 … ⌘9", "Open a chat in the sidebar (hold ⌘ to see which), or a section here"],
      ["⌘⇧S", "Show or hide the sidebar"],
      ["⌘B", "Show or hide the browser"],
      ["⌘⇧K", "Kanban"],
      ["⌘⇧L", "Laments"],
      ["⌘⇧G", "GitHub"],
      ["⌘⇧A", "ATP"],
      ["⌘⇧U", "Computer use settings"],
      ["esc", "Leave Settings"],
    ],
  },
  {
    title: "Chat",
    keys: [
      ["↩", "Send"],
      ["⇧↩", "New line"],
      ["⌥↩", "Queue as a follow-up, after pi finishes"],
      ["esc esc", "Stop pi (queued messages come back to the composer)"],
      ["⌘U", "Attach files"],
      ["⌥↑ ⌥↓", "Jump to the previous or next turn"],
      ["⌃O", "Expand or collapse every tool call"],
    ],
  },
];

function ShortcutsSection() {
  return (
    <>
      {SHORTCUTS.map((group) => (
        <Card key={group.title} title={group.title}>
          {group.keys.map(([keys, action]) => (
            <div key={`${keys} ${action}`} className="flex items-center gap-4 px-3 py-2">
              <span className="flex-1 text-[13px] text-fg">{action}</span>
              <Kbd>{keys}</Kbd>
            </div>
          ))}
        </Card>
      ))}
    </>
  );
}

const TASK_INFO: Record<Task, { title: string; about: string; feature: Feature }> = {
  triage: { title: "Card triage", about: "Names, tags and briefly looks into every card you add. Quick and cheap, since it runs for each one.", feature: "kanban" },
  orchestrator: { title: "ATP orchestrator", about: "Writes and changes ATP plans with you.", feature: "atp" },
  worker: { title: "ATP worker", about: "Runs one node of a plan, in a fresh chat per node.", feature: "atp" },
};

function ModelsSection({ pi }: { pi: Pi }) {
  const features = useApp((state) => state.settings.features);
  const provider = pi.value("defaultProvider") as string | undefined;
  const id = pi.value("defaultModel") as string | undefined;
  const tasks = TASKS.filter((task) => features[TASK_INFO[task].feature]);
  return (
    <>
      <PiFileNote pi={pi} />
      <Card title="New chats">
        <Row
          title="Default model"
          about="The model a new chat starts on."
          onReset={pi.isSet("defaultModel") || pi.isSet("defaultProvider") ? () => pi.set({ defaultProvider: null, defaultModel: null }) : undefined}
        >
          <ModelChoice value={id ? { provider, id } : undefined} unset="pi picks one" onChange={(model) => pi.set({ defaultProvider: model.provider, defaultModel: model.id })} />
        </Row>
        <Row title="Thinking level" about="The thinking level a new chat starts with." onReset={pi.isSet("defaultThinkingLevel") ? () => pi.set({ defaultThinkingLevel: null }) : undefined}>
          <Choice value={String(pi.value("defaultThinkingLevel"))} options={THINKING_LEVELS} mono onChange={(level) => pi.set({ defaultThinkingLevel: level })} />
        </Row>
      </Card>
      {tasks.length > 0 && (
        <Card title="Chats pi-gna starts" note="For that chat only: new chats keep your default. When pi does not have the model, the chat runs on your default model.">
          {tasks.map((task) => (
            <TaskRow key={task} task={task} />
          ))}
        </Card>
      )}
    </>
  );
}

function TaskRow({ task }: { task: Task }) {
  const custom = useApp((state) => state.settings.models[task]);
  const model = custom ?? TASK_DEFAULTS[task];
  const set = (next: TaskModel | null) => void applySettings({ type: "model", task, model: next });
  return (
    <Row title={TASK_INFO[task].title} about={TASK_INFO[task].about} onReset={custom ? () => set(null) : undefined}>
      <ModelChoice value={model} onChange={(next) => set({ provider: next.provider, id: next.id, thinking: model.thinking })} />
      <Choice value={model.thinking} options={THINKING_LEVELS} mono onChange={(thinking) => set({ ...model, thinking })} />
    </Row>
  );
}

const QUEUE_LABELS = { "one-at-a-time": "One at a time", all: "All at once" };
const TRUST_LABELS = { ask: "Ask", always: "Always", never: "Never" };
const WARMING_LABELS = { off: "Off", streaming: "During runs", idle: "Between runs too" };

function AgentSection({ pi }: { pi: Pi }) {
  /** A row's reset button, while the key is set in the file. */
  const reset = (...keys: PiKey[]) => (keys.some((key) => pi.isSet(key)) ? () => pi.set(Object.fromEntries(keys.map((key) => [key, null]))) : undefined);
  const visuals = useApp((state) => state.settings.visuals);
  const toggle = (key: PiKey) => <Switch on={pi.value(key) === true} onChange={(on) => pi.set({ [key]: on })} />;
  const choice = (key: PiKey, labels: Record<string, string>) => {
    const setting = PI_SETTINGS[key];
    return setting.type === "choice" ? <Segmented value={String(pi.value(key))} options={setting.values} labels={labels} onChange={(value) => pi.set({ [key]: value })} /> : null;
  };
  const number = (key: PiKey) => {
    const setting = PI_SETTINGS[key];
    return setting.type === "integer" ? <NumberField value={pi.value(key) as number} min={setting.min} max={setting.max} onCommit={(value) => pi.set({ [key]: value })} /> : null;
  };
  return (
    <>
      <PiFileNote pi={pi} />
      <Card title="Beta">
        <Row title="Inline visuals" about="Agents may add small interactive HTML visuals (diagrams, comparisons, timelines) to replies. Renders sandboxed, offline. Applies to chats you open afterwards.">
          <Switch on={visuals} onChange={(on) => void applySettings({ type: "visuals", on })} />
        </Row>
      </Card>
      <Card title="Messages while pi works">
        <Row title="Steering" about="Messages you send while pi works, delivered after its current step." onReset={reset("steeringMode")}>
          {choice("steeringMode", QUEUE_LABELS)}
        </Row>
        <Row title="Follow-ups" about="Messages queued for when pi finishes (⌥↩)." onReset={reset("followUpMode")}>
          {choice("followUpMode", QUEUE_LABELS)}
        </Row>
      </Card>
      <Card title="Context">
        <Row title="Compact automatically" about="Summarize older messages when the context fills up." onReset={reset("compaction.enabled")}>
          {toggle("compaction.enabled")}
        </Row>
        <Row title="Reserved tokens" about="Room kept free for the model's reply; compaction starts when less is left." onReset={reset("compaction.reserveTokens")}>
          {number("compaction.reserveTokens")}
        </Row>
        <Row title="Recent tokens kept" about="The most recent context, kept as it is when older messages are summarized." onReset={reset("compaction.keepRecentTokens")}>
          {number("compaction.keepRecentTokens")}
        </Row>
      </Card>
      <Card title="Errors">
        <Row title="Retry automatically" about="Try again when the provider fails with a passing error (overloaded, rate limited)." onReset={reset("retry.enabled")}>
          {toggle("retry.enabled")}
        </Row>
        <Row title="Attempts" about="Retries before pi gives up." onReset={reset("retry.maxRetries")}>
          {number("retry.maxRetries")}
        </Row>
      </Card>
      <Card title="Images">
        <Row title="Resize images" about="Shrink images to at most 2000 × 2000 pixels before sending them." onReset={reset("images.autoResize")}>
          {toggle("images.autoResize")}
        </Row>
        <Row title="Block images" about="Never send images to the model." onReset={reset("images.blockImages")}>
          {toggle("images.blockImages")}
        </Row>
      </Card>
      <Card title="More">
        <Row title="Skill commands" about="Offer every skill as a /skill:name command." onReset={reset("enableSkillCommands")}>
          {toggle("enableSkillCommands")}
        </Row>
        <Row
          title="Cache warming"
          about="Keep the provider's prompt cache warm so the next request costs less, when pi expects it to pay off. Warming between runs costs money while you are away."
          onReset={reset("cacheWarming")}
        >
          {choice("cacheWarming", WARMING_LABELS)}
        </Row>
        <Row title="Trust new projects" about="Whether pi loads a project's own settings, extensions and skills when you have not decided for that project yet." onReset={reset("defaultProjectTrust")}>
          {choice("defaultProjectTrust", TRUST_LABELS)}
        </Row>
      </Card>
    </>
  );
}

const FEATURE_ABOUT: Record<Feature, string> = {
  kanban: "A board of cards per project, chats that resolve them, triage of new cards, and the kanban_* tools.",
  laments: "Where agents file the tools they missed, and the lament tool.",
  github: "A project's issues and pull requests, and GitHub links on cards.",
  atp: "Plans that worker chats run node by node, their orchestrator, and its tools.",
};

function FeaturesSection() {
  const features = useApp((state) => state.settings.features);
  const running = useAtp((state) => Object.keys(state.runners).length);
  const computer = useComputerSettings();
  return (
    <Card>
      {FEATURES.map((feature) => {
        const locked = feature === "atp" && features.atp && running > 0;
        return (
          <Row key={feature} title={FEATURE_LABELS[feature]} about={FEATURE_ABOUT[feature]}>
            <Switch
              on={features[feature]}
              disabled={locked}
              title={locked ? `Stop the running plan${running === 1 ? "" : "s"} first` : undefined}
              onChange={(enabled) => void applySettings({ type: "feature", feature, enabled })}
            />
          </Row>
        );
      })}
      <Row
        title="Computer use"
        about={
          <>
            The computer_* tools, which operate apps on this Mac. Off until you turn it on;{" "}
            <button type="button" onClick={() => openSettings("computer")} className="text-muted underline decoration-line-strong underline-offset-2 hover:text-fg">
              permissions and apps
            </button>
            .
          </>
        }
      >
        <Switch on={computer.enabled} onChange={(on) => void applyComputer({ type: on ? "enable" : "disable" })} />
      </Row>
    </Card>
  );
}
