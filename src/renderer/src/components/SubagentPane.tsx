// A subagent's own view, in place of its chat: its transcript, read from its session file and again every second while
// it runs, with Steer and Stop below (through the chat's `/subagent`); how it ended once it is done.
import { useEffect, useMemo, useRef, useState } from "react";
import { createSession, type Item, type SessionState } from "../../../shared/session-state";
import { isActive, type Subagent, SUBAGENTS_STATUS, type SubagentTranscript } from "../../../shared/subagents";
import { formatClock } from "../lib/format";
import { activate, openSession, type Subview, useApp } from "../state/app";
import { closeSubagent, liveHandleOf, steerSubagent, stopSubagent, useSubagents } from "../state/subagents";
import { ArrowUp, ChevronLeft, Square } from "./icons";
import { COLLAPSED_INSET } from "./Sidebar";
import { statusLabel, SubagentMark, subagentActivity, subagentStats, SubagentTime } from "./SubagentParts";
import { Transcript } from "./Transcript";

const home = () => window.studio.homeDir;

const POLL_MS = 1000;

/** A subagent's transcript from its file: read once, and every second while it runs (only when the file grew). */
function useTranscript(file: string | undefined, active: boolean): SubagentTranscript | undefined {
  const [transcript, setTranscript] = useState<{ file: string; value: SubagentTranscript }>();
  const size = useRef<number | undefined>(undefined);
  useEffect(() => {
    size.current = undefined;
    setTranscript(undefined);
  }, [file]);
  useEffect(() => {
    if (!file) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const answer = await window.studio.subagentTranscript(file, size.current);
        if (stopped) return;
        size.current = answer.size;
        if (answer.transcript) setTranscript({ file, value: answer.transcript });
      } catch {
        // Gone or unreadable: what was read stays on screen.
      }
      if (!stopped && active) timer = setTimeout(() => void read(), POLL_MS);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [file, active]);
  return transcript && transcript.file === file ? transcript.value : undefined;
}

export function SubagentPane({ view }: { view: Subview }) {
  const inset = useApp((state) => state.sidebar.collapsed);
  const handle = useApp((state) => Object.values(state.sessions).find((session) => session.sessionPath === view.chat && session.phase !== "exited")?.handle);
  const live = useApp((state) => (handle ? state.sessions[handle]?.statuses[SUBAGENTS_STATUS] : undefined));
  const agents = useSubagents(view.chat, live);
  const agent = agents.find((entry) => entry.id === view.agent);
  const active = agent ? isActive(agent.status) : false;
  const transcript = useTranscript(agent?.file, active);
  const session = useMemo<SessionState | undefined>(() => {
    if (!transcript || !agent?.file) return undefined;
    return {
      ...createSession(`subagent-${agent.id}`, transcript.cwd, agent.file),
      phase: "ready",
      items: transcript.items as Item[],
      modelRef: transcript.modelRef,
      thinkingLevel: transcript.thinkingLevel as SessionState["thinkingLevel"],
      running: active,
      runStartedAt: active ? agent.startedAt : undefined,
      prompted: true,
    };
  }, [transcript, agent?.file, agent?.id, agent?.startedAt, active]);

  const back = () => {
    const open = liveHandleOf(view.chat);
    if (open) activate(open);
    else {
      closeSubagent();
      openSession({ path: view.chat, cwd: view.cwd, title: view.title });
    }
  };

  return (
    <div className="relative flex h-full min-w-0 flex-col" data-subagent-pane={view.agent}>
      <header className="drag dashed-b titlebar flex shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <button type="button" onClick={back} title="Back to the chat" className="no-drag flex min-w-0 shrink items-center gap-1 rounded-md py-1 pr-1.5 text-[13.5px] text-muted hover:text-fg">
          <ChevronLeft size={15} className="shrink-0" />
          <span className="max-w-60 truncate">{view.title}</span>
        </button>
        <span className="text-faint">/</span>
        {agent && <SubagentMark status={agent.status} />}
        <span className="min-w-0 truncate text-[13.5px] font-medium text-fg">{agent?.description ?? "Subagent"}</span>
        {agent && (
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">
            <span>{[agent.type, agent.model?.split("/").at(-1)].filter(Boolean).join(" · ")}</span>
          </span>
        )}
      </header>
      {session ? (
        <Transcript session={session} />
      ) : (
        <div className="grid flex-1 place-items-center text-[13px] text-faint">
          {!agent ? "This subagent is not in the chat's files." : agent.file ? "Reading its transcript…" : agent.status === "queued" ? "Waiting for a free slot…" : "Starting…"}
        </div>
      )}
      {agent && <SubagentBar agent={agent} handle={handle} onBack={back} cwd={view.cwd} />}
    </div>
  );
}

/** Below the transcript: steer or stop the agent while it runs; how it ended once it is done. */
function SubagentBar({ agent, handle, onBack, cwd }: { agent: Subagent; handle?: string; onBack: () => void; cwd: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const active = isActive(agent.status);
  const stats = subagentStats(agent);
  const send = async () => {
    if (!handle || sending || !text.trim()) return;
    setSending(true);
    if (await steerSubagent(handle, agent, text)) setText("");
    setSending(false);
  };

  if (active && handle) {
    return (
      <div className="mx-auto flex w-full max-w-[800px] flex-col gap-1.5 px-8 pb-5">
        <div className="flex items-center gap-2 px-1 text-[12px] text-faint">
          <span className="min-w-0 truncate font-mono">{subagentActivity(agent, cwd, home()) ?? statusLabel(agent.status)}</span>
          <span className="ml-auto shrink-0 font-mono">{stats}</span>
          <SubagentTime agent={agent} className="shrink-0 font-mono" />
        </div>
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel px-3 py-2 focus-within:border-line-strong">
          <textarea
            value={text}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
            placeholder="Steer this subagent: it reads your message after its current step"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-[14px] text-fg outline-none placeholder:text-faint"
            style={{ fieldSizing: "content" } as React.CSSProperties}
          />
          <button type="button" onClick={() => void stopSubagent(handle, agent)} title="Stop this subagent" className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[12.5px] text-muted hover:border-bad/50 hover:text-bad">
            <Square size={11} /> Stop
          </button>
          <button type="button" onClick={() => void send()} disabled={!text.trim() || sending} title="Steer (Enter)" className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-canvas disabled:opacity-40">
            <ArrowUp size={14} />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-[800px] items-center gap-2 px-8 pt-1 pb-5 text-[12.5px]">
      <SubagentMark status={agent.status} />
      <span className={agent.error ? "min-w-0 truncate text-bad" : "text-muted"}>
        {active
          ? "Its chat is not open here, so this view does not follow it."
          : agent.error
            ? agent.error
            : agent.status === "unknown"
              ? "No outcome was recorded: its chat stopped while it worked."
              : agent.endedAt
                ? `${statusLabel(agent.status)} in ${formatClock(agent.endedAt - agent.startedAt)}`
                : statusLabel(agent.status)}
      </span>
      {stats && <span className="shrink-0 font-mono text-[11px] text-faint">{stats}</span>}
      <button type="button" onClick={onBack} className="ml-auto shrink-0 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-muted hover:bg-raised hover:text-fg">
        {active ? "Open the chat" : "Back to the chat"}
      </button>
    </div>
  );
}
