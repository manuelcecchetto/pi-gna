// The Settings sections, and the sidebar's list of them while Settings is open (SettingsNav). Apart from the page, so
// the sidebar and the command palette do not pull the Settings page into the startup bundle (it loads on first use).
import { ArrowLeft, Blocks, Info, Bot, Cpu, KeyRound, Keyboard, Layers, type IconComponent, Monitor, Palette, Search, Settings2, Smartphone, ToggleRight } from "./icons";
import { useMemo, useState } from "react";
import type { SettingsSection } from "../../../shared/settings";
import { closeSettings, openSettings } from "../state/app";
import { DigitHint, useCommandDigits } from "./primitives";

type Group = "pi-gna" | "pi" | "Integrations";

export interface SectionInfo {
  id: SettingsSection;
  label: string;
  icon: IconComponent;
  group: Group;
  about: string;
  /** What the search finds it by, besides its label. */
  keywords: string;
  /** Wider than the other sections' column, for charts and tables. */
  wide?: boolean;
}

export const SECTIONS: SectionInfo[] = [
  { id: "general", label: "General", icon: Settings2, group: "pi-gna", about: "pi-gna's version, and where pi keeps the settings this page changes.", keywords: "version update settings.json file folder setup onboarding install pi welcome first run" },
  { id: "appearance", label: "Appearance", icon: Palette, group: "pi-gna", about: "How pi-gna looks.", keywords: "theme dark light system mode color colour palette primary secondary accent font typeface size wallpaper background backdrop empty state image logo project custom loop cycle rotate shuffle" },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, group: "pi-gna", about: "Hold ⌘ anywhere to see ⌘1–⌘9 on the chats in the sidebar.", keywords: "keys hotkeys keyboard command" },
  {
    id: "usage",
    label: "Usage",
    icon: Layers,
    group: "pi-gna",
    about: "How pi and pi-gna were used on this Mac: tokens, estimated cost, models, projects, tools and agent health. Read from pi's session files; nothing leaves this Mac.",
    keywords: "tokens cost usage analytics stats models spend",
    wide: true,
  },
  { id: "about", label: "About", icon: Info, group: "pi-gna", about: "Which pi-gna this is, where it comes from, and where to report a problem.", keywords: "version build electron chromium node license mit credits author github source code issues bug report release notes changelog twemoji" },
  {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    group: "pi",
    about: "Sign in to the providers pi runs models on, the way pi's /login does: with your account or subscription, or with an API key.",
    keywords: "login log in sign in sign out logout auth authentication api key keys account subscription oauth credentials claude anthropic chatgpt openai codex copilot",
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: Blocks,
    group: "pi",
    about: "Connect apps over MCP, install pi packages, and choose what pi loads, for you or for this project. Saved in pi's own settings, so pi in the terminal sees the same.",
    keywords: "mcp servers connections packages extensions skills prompts themes install uninstall enable disable built-in codemode tool search llama attio notion granola intercom brevo pi config",
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
        <button type="button" onClick={closeSettings} className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] text-fg/90 hover:bg-raised/60">
          <ArrowLeft size={16} className="shrink-0 text-muted" />
          <span className="flex-1">Back to app</span>
          <span className="font-mono text-[11px] text-faint opacity-0 group-hover:opacity-100">esc</span>
        </button>
      </div>
      <div className="px-2 pb-2">
        <label className="flex items-center gap-2.5 rounded-lg bg-sunken px-2.5 py-1.5 focus-within:ring-1 focus-within:ring-line-strong">
          <Search size={16} className="shrink-0 text-faint" />
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
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint"
          />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {GROUPS.map((group) => {
          const sections = shown.filter((section) => section.group === group);
          if (!sections.length) return null;
          return (
            <div key={group} className="mb-3">
              <div className="px-2.5 pt-1 pb-1 text-[13px] font-medium text-faint">{group}</div>
              {sections.map((section) => {
                const Icon = section.icon;
                const digit = shown.indexOf(section) + 1;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => openSettings(section.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${current === section.id ? "bg-raised text-fg" : "text-fg/90 hover:bg-raised/60"}`}
                  >
                    <Icon size={16} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    {hints && digit <= 9 && <DigitHint digit={digit} />}
                  </button>
                );
              })}
            </div>
          );
        })}
        {!shown.length && <p className="px-2.5 py-2 text-[13.5px] text-faint">No settings match “{query}”.</p>}
      </nav>
    </>
  );
}
