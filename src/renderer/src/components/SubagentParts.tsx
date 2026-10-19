// Small pieces that show a subagent (src/shared/subagents.ts) wherever it appears: its status mark, what it is doing,
// the chip on the call that spawned it and the notice of its result. Shared by the sidebar, the composer's tray, the
// subagent view and the transcript, so they import no app state (the transcript also renders on the phone).
import { ArrowUpRight, Circle, CircleCheck, CircleSlash, CircleX } from "./icons";
import { formatClock, formatTokens } from "../lib/format";
import { useSubagentsUi } from "../lib/subagents-ui";
import { presentTool } from "../lib/tools";
import { isActive, isFailure, type Subagent, type SubagentStatus } from "../../../shared/subagents";
import { Markdown } from "./Markdown";
import { PiSpinner } from "./PiLogo";
import { useNow } from "./primitives";

const STATUS_LABEL: Record<SubagentStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Done",
  aborted: "Aborted",
  stopped: "Stopped",
  error: "Failed",
  unknown: "No outcome",
};

export const statusLabel = (status: SubagentStatus): string => STATUS_LABEL[status];

/** Spinner while it runs; a ring while it waits for a slot; then how it ended. */
export function SubagentMark({ status, size = 12 }: { status: SubagentStatus; size?: number }) {
  const title = STATUS_LABEL[status];
  if (status === "running") return <PiSpinner size={size} />;
  if (status === "queued") return <Circle size={size} aria-label={title} className="shrink-0 text-faint" strokeDasharray="3 3" />;
  if (status === "completed") return <CircleCheck size={size} aria-label={title} className="shrink-0 text-ok" />;
  if (isFailure(status)) return <CircleX size={size} aria-label={title} className="shrink-0 text-bad" />;
  if (status === "stopped") return <CircleSlash size={size} aria-label={title} className="shrink-0 text-faint" />;
  return <Circle size={size} aria-label={title} className="shrink-0 text-faint" />;
}

/** "Running pnpm test", from its latest tool call; undefined before it called one. */
export function subagentActivity(agent: Subagent, cwd: string, home?: string): string | undefined {
  if (!agent.last) return undefined;
  const presentation = presentTool(agent.last.name, agent.last.args, cwd, undefined, home);
  const verb = isActive(agent.status) ? presentation.activeVerb : presentation.verb;
  return [verb, presentation.target].filter(Boolean).join(" ");
}

/** How long it ran, or runs so far (ticking). */
export function SubagentTime({ agent, className }: { agent: Subagent; className?: string }) {
  const active = isActive(agent.status);
  const now = useNow(1000, active);
  const end = agent.endedAt ?? (active ? now : undefined);
  if (end === undefined) return null;
  return <span className={`tabular-nums ${className ?? ""}`}>{formatClock(Math.max(0, end - agent.startedAt))}</span>;
}

/** "12 tools · 33.8k tokens". */
export function subagentStats(agent: Pick<Subagent, "toolUses" | "tokens">): string {
  return [agent.toolUses ? `${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}` : "", agent.tokens ? `${formatTokens(agent.tokens)} tokens` : ""].filter(Boolean).join(" · ");
}

/** On a `subagent`, `get_subagent_result` or `steer_subagent` row: the agent's status now, and a way to open it. */
export function SubagentCallChip({ agent }: { agent: Subagent }) {
  const ui = useSubagentsUi();
  if (!ui) return null;
  return (
    <button
      type="button"
      title={`Open the subagent (${statusLabel(agent.status).toLowerCase()})`}
      onClick={() => ui.open(agent)}
      className="flex shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-[1px] text-[11px] text-muted hover:border-line-strong hover:text-fg"
    >
      <SubagentMark status={agent.status} size={10} />
      {isActive(agent.status) ? <SubagentTime agent={agent} /> : statusLabel(agent.status)}
      <ArrowUpRight size={10} />
    </button>
  );
}

interface NoticeDetails {
  id?: string;
  description?: string;
  status?: string;
  toolUses?: number;
  totalTokens?: number;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  message?: string;
}

/**
 * pi-subagents' notices in the chat: an agent finished (`subagent-notification`) or sent word while it works
 * (`subagent-update`). The card says which agent and how it went, with its result's start; the model reads the full text.
 */
export function SubagentNotice({ customType, details }: { customType: string; details: unknown }) {
  const ui = useSubagentsUi();
  const notice = (details && typeof details === "object" ? details : {}) as NoticeDetails;
  const agent = notice.id ? ui?.agents.find((entry) => entry.id === notice.id) : undefined;
  const update = customType === "subagent-update";
  const status = (update ? "running" : (notice.status ?? "completed")) as SubagentStatus;
  const stats = [subagentStats({ toolUses: notice.toolUses ?? 0, tokens: notice.totalTokens ?? 0 }), notice.durationMs ? formatClock(notice.durationMs) : ""].filter(Boolean).join(" · ");
  const body = update ? notice.message : (notice.error ?? notice.resultPreview);
  return (
    <div className="rounded-xl border border-line bg-panel px-3.5 py-2.5" data-subagent-notice={customType}>
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <SubagentMark status={status} />
        <span className="shrink-0 text-muted">{update ? "Update from" : `Subagent ${statusLabel(status).toLowerCase()}:`}</span>
        <span className="min-w-0 truncate font-medium text-fg">{notice.description ?? "Subagent"}</span>
        {!update && stats && <span className="shrink-0 font-mono text-[11px] text-faint">{stats}</span>}
        {agent && ui && (
          <button type="button" onClick={() => ui.open(agent)} className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-muted hover:text-fg">
            Open <ArrowUpRight size={11} />
          </button>
        )}
      </div>
      {body && (
        <div className={`mt-1.5 line-clamp-4 text-[13px] [&_.prose]:text-[13px] ${notice.error ? "text-bad" : "text-muted"}`}>
          <Markdown text={body} />
        </div>
      )}
    </div>
  );
}
