// The Settings sections, and the sidebar's list of them while Settings is open (SettingsNav). Apart from the page, so
// the sidebar and the command palette do not pull the Settings page into the startup bundle (it loads on first use).
import { ArrowLeft, Blocks, Info, Bot, Cpu, KeyRound, Keyboard, Layers, type IconComponent, MessagesSquare, Monitor, Palette, Search, Settings2, Smartphone, ToggleRight } from "./icons";
import { useMemo, useState } from "react";
import type { SettingsSection } from "../../../shared/settings";
import { closeSettings, openSettings } from "../state/app";
import { DigitHint, useCommandDigits } from "./primitives";
import { NavRow, RAIL_FADE } from "./SidebarRow";

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
    keywords: "steering follow-up queue messages compaction context summarize retry errors images resize block skills commands cache warming project trust autocomplete suggestions ghost text typeahead",
  },
  {
    id: "import",
    label: "Import chats",
    icon: MessagesSquare,
    group: "pi",
    about: "Bring the chats you had with Codex and Claude Code on this Mac into pi-gna. Each one lands in its project with its own date, and goes on like any chat.",
    keywords: "import migrate codex claude code chats history sessions transcripts conversations openai anthropic move switch",
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
  { id: "computer", label: "Computer use", icon: Monitor, group: "Integrations", about: navigator.userAgent.includes("Linux") ? "The computer_* tools: what pi may operate on this computer, and what the desktop must allow." : "The computer_* tools: what pi may operate on this Mac, and the macOS permissions they need.", keywords: "apps mac accessibility screen recording permissions always allowed denylist" },
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
      <div className="flex flex-col px-[8px] pb-1">
        <NavRow icon={ArrowLeft} label="Back to app" shortcut="esc" onClick={closeSettings} />
      </div>
      <div className="flex flex-col px-[8px] pb-2">
        <label className="flex h-[32px] w-full items-center gap-[8px] overflow-hidden rounded-lg bg-sunken px-[8px] transition-[width] duration-200 ease-out group-data-rail/side:w-[32px] focus-within:ring-1 focus-within:ring-line-strong">
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
            className={`min-w-0 flex-1 bg-transparent text-[13.5px] text-fg outline-none placeholder:text-faint ${RAIL_FADE}`}
          />
        </label>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-4">
        {GROUPS.map((group) => {
          const sections = shown.filter((section) => section.group === group);
          if (!sections.length) return null;
          return (
            <div key={group} className="mb-3 flex flex-col">
              <div className={`px-[8px] pt-1 pb-1 text-[13px] font-medium whitespace-nowrap text-faint ${RAIL_FADE}`}>{group}</div>
              {sections.map((section) => {
                const digit = shown.indexOf(section) + 1;
                return (
                  <NavRow
                    key={section.id}
                    icon={section.icon}
                    label={section.label}
                    active={current === section.id}
                    trailing={hints && digit <= 9 ? <DigitHint digit={digit} /> : undefined}
                    onClick={() => openSettings(section.id)}
                  />
                );
              })}
            </div>
          );
        })}
        {!shown.length && <p className={`px-[8px] py-2 text-[13.5px] text-faint ${RAIL_FADE}`}>No settings match “{query}”.</p>}
      </nav>
    </>
  );
}
