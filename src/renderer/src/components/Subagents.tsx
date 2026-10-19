// The desktop's subagent lists (src/shared/subagents.ts): the tree under a chat in the sidebar, the tray above a chat's
// composer while its agents work, and the chat's agents for its transcript. The agent's own view is SubagentPane.
import { useMemo, useState } from "react";
import type { SessionState } from "../../../shared/session-state";
import { isActive, liveSubagents, type Subagent, SUBAGENTS_STATUS } from "../../../shared/subagents";
import { createStore, useStore } from "../lib/store";
import { SubagentsProvider } from "../lib/subagents-ui";
import { sessionTitle, store, useApp } from "../state/app";
import { openSubagent, stopSubagent, useSubagents } from "../state/subagents";
import { Bot, ChevronRight, Square } from "./icons";
import { statusLabel, SubagentMark, subagentActivity, subagentStats, SubagentTime } from "./SubagentParts";

const home = () => window.studio.homeDir;

/** The chat's subagents for its transcript: the chips on its calls and the notices open them. */
export function ChatSubagents({ session, children }: { session: SessionState; children: React.ReactNode }) {
  const chat = session.sessionPath;
  const agents = useSubagents(chat, session.statuses[SUBAGENTS_STATUS], Boolean(chat));
  const title = sessionTitle(session);
  const ui = useMemo(() => (chat ? { agents, open: (agent: Subagent) => openSubagent(chat, agent, session.cwd, title) } : undefined), [agents, chat, session.cwd, title]);
  return <SubagentsProvider value={ui}>{children}</SubagentsProvider>;
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

/** Trees you opened or closed by hand, by chat file; the rest follow `autoOpen`. */
const trees = createStore<Record<string, boolean>>({});
const TREE_FIRST = 6;

/** Whether a chat's tree shows: as you left it, else while it is the chat on screen or one of its agents works. */
export function useTreeOpen(chat: string | undefined, autoOpen: boolean): [boolean, (open: boolean) => void] {
  const set = useStore(trees, (all) => (chat ? all[chat] : undefined));
  return [set ?? autoOpen, (open) => chat && trees.set((all) => ({ ...all, [chat]: open }))];
}

/** The disclosure beside a chat row that has subagents. */
export function TreeToggle({ open, count, onToggle }: { open: boolean; count: number; onToggle: (open: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!open)}
      title={`${open ? "Hide" : "Show"} ${count} subagent${count === 1 ? "" : "s"}`}
      aria-expanded={open}
      className="absolute top-[8.5px] -left-[3px] z-10 grid size-3.5 place-items-center rounded text-faint hover:text-fg"
    >
      <ChevronRight size={10} className={`transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

/** A chat's subagents under its sidebar row. */
export function SubagentTree({ chat, live, cwd, title }: { chat: string; live?: string; cwd: string; title: string }) {
  const agents = useSubagents(chat, live);
  const shown = useApp((state) => (state.subview?.chat === chat && !state.page ? state.subview.agent : undefined));
  const [all, setAll] = useState(false);
  if (!agents.length) return null;
  const rows = all ? agents : agents.slice(0, TREE_FIRST);
  return (
    <div className="mb-0.5 ml-[19px] flex flex-col border-l border-line pl-1" data-subagent-tree={chat}>
      {rows.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => openSubagent(chat, agent, cwd, title)}
          title={`${agent.description} · ${statusLabel(agent.status).toLowerCase()}`}
          className={`flex min-w-0 items-center gap-2 rounded-md py-[3px] pr-2.5 pl-2 text-left text-[13px] ${agent.id === shown ? "bg-raised text-fg" : "text-muted hover:bg-raised/50 hover:text-fg"}`}
        >
          <SubagentMark status={agent.status} size={11} />
          <span className="min-w-0 flex-1 truncate">{agent.description}</span>
          <SubagentTime agent={agent} className="shrink-0 font-mono text-[10.5px] text-faint" />
        </button>
      ))}
      {agents.length > TREE_FIRST && (
        <button type="button" onClick={() => setAll(!all)} className="px-2 py-0.5 text-left text-[12px] text-faint hover:text-muted">
          {all ? "Show fewer" : `${agents.length - TREE_FIRST} more`}
        </button>
      )}
    </div>
  );
}

// ── Composer tray ────────────────────────────────────────────────────────────

const trays = createStore<Record<string, boolean>>({});

/**
 * Above a chat's composer while its subagents work: each one, what it does now, and its progress. Agents that finished
 * during the chat's current run stay until the run ends, so a fan-out reads "2 running · 3 done".
 */
export function SubagentTray({ handle }: { handle: string }) {
  const live = useApp((state) => state.sessions[handle]?.statuses[SUBAGENTS_STATUS]);
  const chat = useApp((state) => state.sessions[handle]?.sessionPath);
  const cwd = useApp((state) => state.sessions[handle]?.cwd ?? "");
  const running = useApp((state) => state.sessions[handle]?.running ?? false);
  const runStartedAt = useApp((state) => state.sessions[handle]?.runStartedAt);
  const collapsed = useStore(trays, (all) => all[handle] ?? false);
  const agents = useMemo(
    () => liveSubagents(live).filter((agent) => isActive(agent.status) || (running && runStartedAt !== undefined && (agent.endedAt ?? 0) >= runStartedAt)),
    [live, running, runStartedAt],
  );
  if (!agents.length) return null;
  const active = agents.filter((agent) => isActive(agent.status)).length;
  const done = agents.length - active;
  const open = (agent: Subagent) => {
    const session = store.get().sessions[handle];
    if (chat && session) openSubagent(chat, agent, cwd, sessionTitle(session));
  };
  return (
    <div className="rounded-xl border border-line bg-panel/70 px-1.5 py-1" data-subagent-tray>
      <button type="button" onClick={() => trays.set((all) => ({ ...all, [handle]: !collapsed }))} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px]">
        <Bot size={13} className="shrink-0 text-muted" />
        <span className="text-fg/90">Subagents</span>
        <span className="text-faint">{[active ? `${active} running` : "", done ? `${done} done` : ""].filter(Boolean).join(" · ")}</span>
        <ChevronRight size={12} className={`ml-auto shrink-0 text-faint transition-transform ${collapsed ? "" : "rotate-90"}`} />
      </button>
      {!collapsed &&
        agents.map((agent) => (
          <div key={agent.id} className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-[3px] text-[12.5px] hover:bg-raised/60">
            <button type="button" onClick={() => open(agent)} title="Open the subagent" className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <SubagentMark status={agent.status} size={11} />
              <span className="max-w-[45%] shrink-0 truncate text-fg/90">{agent.description}</span>
              <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">{subagentActivity(agent, cwd, home()) ?? (agent.status === "queued" ? "waiting for a slot" : "starting")}</span>
              <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-faint">{subagentStats(agent)}</span>
              <SubagentTime agent={agent} className="w-9 shrink-0 text-right font-mono text-[11px] text-faint" />
            </button>
            {isActive(agent.status) && (
              <button type="button" onClick={() => void stopSubagent(handle, agent)} title="Stop this subagent" className="shrink-0 rounded p-0.5 text-faint opacity-0 hover:text-bad group-hover:opacity-100 focus-visible:opacity-100">
                <Square size={11} />
              </button>
            )}
          </div>
        ))}
    </div>
  );
}
