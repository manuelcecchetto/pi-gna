// The ATP page: one project's ATP plans (`*.atp.json`), for big projects that must not get lazy halfway. A plan is
// a graph of nodes that pi-gna runs one fresh worker chat at a time (state/atp.ts); the page draws it (AtpGraph),
// starts and stops the run, shows a node's instruction, report and worker chats, and has the plan's orchestrator
// floating over the graph: a chat to ask how it is going, change the plan, or write a new one with the architect skills.
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileWarning,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from "./icons";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ATP_CONFIG, type AtpNode, type AtpPlan, type AtpPlanFile, NEW_PLAN_DIR, planName, planProgress } from "../../../shared/atp";
import { taskModel } from "../../../shared/settings";
import { baseName, formatStamp, relativeTime, tildify } from "../lib/format";
import { ATP_DETAIL, ATP_DOCK, ATP_GRAPH_MIN, type AtpPanels, loadAtpPanels, saveAtpPanels } from "../lib/layout";
import { activate, earlierTurns, openSettings, type PageState, prefill, releasePageChat, remoteError, showPage, showPageChat, toast, useApp, useAppShallow } from "../state/app";
import { type ChatGlance, chatGlance } from "../lib/projects";
import {
  discardNewPlanChat,
  liftHold,
  orchestrator,
  releaseInterrupted,
  releaseOrchestrators,
  type Runner,
  type RunNote,
  startPlan,
  stopPlan,
  threadHandle,
  useAtp,
  useThreads,
  watchProject,
} from "../state/atp";
import { type GraphHandle, AtpGraph, LOOK_LABEL, lookOf, type NodeLook, StatusIcon } from "./AtpGraph";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { Elapsed, Popover, ResizeHandle, useNow } from "./primitives";
import { ProjectSwitch } from "./ProjectSwitch";
import { COLLAPSED_INSET } from "./Sidebar";
import { Transcript } from "./Transcript";

/** The plan you looked at last per project, for this app run. "new": the architect's chat for a new plan. */
const lastSelected = new Map<string, string>();

const ARCHITECTS = [
  { skill: "atp-architect", label: "Macro plan", about: "Nodes the size of one commit or PR: design, build, test, docs, rollout." },
  { skill: "atp-micro-architect", label: "Micro plan", about: "5-25 minute fresh-context steps, each with exact inputs, outputs and checks." },
] as const;

/** Keyed by project (App). */
export function AtpPage({ page }: { page: PageState }) {
  const project = useAtp((state) => state.project);
  const runners = useAtp((state) => state.runners);
  const held = useAtp((state) => state.held);
  const notes = useAtp((state) => state.notes);
  const orchestrators = useAtp((state) => state.orchestrators);
  const projects = useApp((state) => state.projects);
  const inset = useApp((state) => state.sidebar.collapsed);
  const [selected, setSelectedState] = useState(() => lastSelected.get(page.cwd));
  const [node, setNode] = useState<string>();
  /** The side column's tab in front: "chat" (the orchestrator), "node", or `worker:<handle>`. */
  const [front, setFront] = useState("chat");
  const [collapsed, setCollapsed] = useState(false);
  /** Worker chats opened as tabs of the side column. */
  const [workers, setWorkers] = useState<string[]>([]);
  const showNode = useCallback((id: string | undefined) => {
    setNode(id);
    setFront(id ? "node" : "chat");
    if (id) setCollapsed(false);
  }, []);
  const openWorker = useCallback((handle: string) => {
    setWorkers((open) => (open.includes(handle) ? open : [...open, handle]));
    setFront(`worker:${handle}`);
    setCollapsed(false);
  }, []);
  const closeWorker = (handle: string) => {
    setWorkers((open) => open.filter((other) => other !== handle));
    releasePageChat(handle);
  };
  const [query, setQuery] = useState("");
  const graph = useRef<GraphHandle>(null);
  const graphArea = useRef<HTMLDivElement>(null);
  /** How much of the canvas's bottom the orchestrator's composer covers. */
  const [covered, setCovered] = useState(0);
  const [panels, setPanels] = useState(loadAtpPanels);
  const resize = (key: keyof AtpPanels) => (size: number, done: boolean) => {
    const next = { ...panels, [key]: size };
    setPanels(next);
    if (done) saveAtpPanels(next);
  };

  useEffect(() => {
    void watchProject(page.cwd);
    return () => {
      void watchProject(null);
      releaseOrchestrators();
    };
  }, [page.cwd]);

  const files = project?.cwd === page.cwd ? project.plans : [];
  const select = useCallback(
    (path: string | undefined) => {
      if (path) lastSelected.set(page.cwd, path);
      setSelectedState(path);
      showNode(undefined);
    },
    [page.cwd, showNode],
  );
  // By default the plan that runs, else the one changed last.
  const fallback = files.find((file) => runners[file.path]) ?? [...files].sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  const current = selected === "new" ? undefined : (files.find((file) => file.path === selected) ?? fallback);
  const plan = current?.plan;
  // pi-gna's worker holds a node, but nothing here runs it: a run that ended with pi-gna (a crash, a quit).
  const stalled = plan && !runners[plan.path] ? plan.nodes.find((other) => other.status === "CLAIMED" && !other.scope && other.worker === ATP_CONFIG.agentId)?.id : undefined;

  // The architect's chat wrote its plan: show the plan, whose orchestrator that chat now is.
  const newChat = useRef<string>(undefined);
  useEffect(() => {
    if (selected !== "new") return;
    const handle = orchestrators[`new:${page.cwd}`];
    if (handle) newChat.current = handle;
    else if (newChat.current) {
      const adopted = Object.entries(orchestrators).find(([, other]) => other === newChat.current)?.[0];
      newChat.current = undefined;
      if (adopted) select(adopted);
    }
  }, [selected, orchestrators, page.cwd, select]);

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || !plan) return new Set<string>();
    return new Set(plan.nodes.filter((other) => other.id.toLowerCase().includes(text) || other.title.toLowerCase().includes(text)).map((other) => other.id));
  }, [query, plan]);
  const matchIndex = useRef(0);
  const revealNext = () => {
    const ids = plan?.nodes.filter((other) => matches.has(other.id)).map((other) => other.id) ?? [];
    if (!ids.length) return;
    const id = ids[matchIndex.current++ % ids.length] as string;
    graph.current?.reveal(id);
    showNode(id);
  };

  const newPlan = async (skill: string) => {
    select("new");
    await discardNewPlanChat(page.cwd);
    try {
      prefill(await orchestrator(page.cwd, undefined), `/skill:${skill} `);
    } catch (error) {
      toast(`Could not start the architect: ${remoteError(error)}`, "error");
    }
  };

  const switchable = useMemo(() => [...new Set([page.cwd, ...projects.map((other) => other.cwd)])].map((cwd) => ({ cwd, open: 0 })), [projects, page.cwd]);
  const selectedNode = node && plan?.nodes.find((other) => other.id === node);
  const chatPlan = selected === "new" ? undefined : plan?.path;
  const chat = useOrchestrator(page.cwd, chatPlan, selected === "new" || Boolean(plan));
  const glance = useAppShallow((state) => chatGlance(chat.handle ? state.sessions[chat.handle] : undefined));
  // A plan's orchestrator floats over the graph until you talk to it; then its chat is the side column's.
  const docked = Boolean(plan && glance?.talked);
  useEffect(() => {
    if (!docked) return;
    setFront("chat");
    setCollapsed(false);
  }, [docked]);
  const dock = (selected === "new" || plan) && !docked && (
    <OrchestratorDock chat={chat} plan={chatPlan} height={panels.dock} onResize={resize("dock")} onInset={setCovered} />
  );
  // The worker tabs whose chats this window still has (the host closes a finished worker nobody looks at).
  const kept = useApp((state) => workers.filter((handle) => state.sessions[handle]).join(" "));
  const tabs = [...(docked ? ["chat"] : []), ...(selectedNode ? ["node"] : []), ...(kept ? kept.split(" ").map((handle) => `worker:${handle}`) : [])];
  const showing = tabs.includes(front) ? front : selectedNode ? "node" : tabs[0];
  const unread = useUnread(docked ? chat.handle : undefined, docked ? glance : undefined, docked && !collapsed && showing === "chat");
  const shownChat = collapsed ? undefined : showing === "chat" ? chat.handle : showing?.startsWith("worker:") ? showing.slice("worker:".length) : undefined;
  useEffect(() => {
    showPageChat(shownChat);
    return () => showPageChat(undefined);
  }, [shownChat]);
  // Leaving the page (or the plan) closes its worker tabs.
  const open = useRef(workers);
  open.current = workers;
  useEffect(() => {
    if (!plan?.path) return;
    return () => {
      for (const handle of open.current) releasePageChat(handle);
      setWorkers([]);
    };
  }, [plan?.path]);

  return (
    <div className="page-enter flex h-full min-w-0 flex-col">
      <header className="drag dashed-b titlebar flex shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <Network size={15} className="text-muted" />
        <span className="text-[13.5px] font-medium text-fg">ATP</span>
        <ProjectSwitch cwd={page.cwd} options={switchable} openTitle="Open ATP" onPick={(cwd) => showPage("atp", cwd)} />
        <PlanSwitch files={files} current={selected === "new" ? "new" : current?.path} runners={runners} held={held} onSelect={select} />
        <div className="flex-1" />
        {plan && (
          <label className="no-drag flex w-56 items-center gap-1.5 rounded-lg border border-line bg-sunken px-2 py-1 focus-within:border-line-strong">
            <Search size={12} className="shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                matchIndex.current = 0;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") revealNext();
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="Find a node"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            />
            {query && <span className="shrink-0 font-mono text-[10.5px] text-faint">{matches.size}</span>}
          </label>
        )}
        <button
          type="button"
          title="Look for plans again"
          onClick={() => void watchProject(page.cwd)}
          className="no-drag rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg"
        >
          <RefreshCw size={14} />
        </button>
        <NewPlanButton onPick={newPlan} />
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="relative flex min-w-0 flex-1 flex-col">
          {selected === "new" ? (
            <>
              <NewPlanIntro cwd={page.cwd} inset={covered} />
              {dock}
            </>
          ) : current && plan ? (
            <>
              <PlanBar
                plan={plan}
                cwd={page.cwd}
                runner={runners[plan.path]}
                stalled={stalled}
                held={held.includes(plan.path)}
                note={notes[plan.path]}
                onReveal={(id) => (graph.current?.reveal(id), showNode(id))}
                onOpenChat={openWorker}
              />
              <div className="flex flex-1" style={{ minHeight: ATP_GRAPH_MIN.height }}>
                <div ref={graphArea} className="relative min-w-0 flex-1">
                  {plan.nodes.length ? (
                    <AtpGraph ref={graph} plan={plan} selected={node} stalled={stalled} matches={matches} onSelect={showNode} inset={covered} />
                  ) : (
                    <p className="p-10 text-center text-[12.5px] text-faint">This plan has no nodes yet.</p>
                  )}
                  {dock}
                </div>
                {tabs.length > 0 &&
                  (collapsed ? (
                    <button
                      type="button"
                      onClick={() => setCollapsed(false)}
                      title="Show the side panel"
                      className="flex w-9 shrink-0 flex-col items-center gap-2.5 border-l border-line bg-panel pt-2.5 text-faint hover:text-fg"
                    >
                      <ChevronLeft size={14} />
                      <MessagesSquare size={14} />
                      {glance?.running ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> : unread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    </button>
                  ) : (
                    <aside
                      className="relative flex shrink-0 flex-col overflow-hidden border-l border-line bg-panel"
                      // Narrowed when the window is too small to leave the graph its minimum; the remembered width stays.
                      style={{ width: `clamp(${ATP_DETAIL.min}px, ${panels.detail}px, calc(100% - ${ATP_GRAPH_MIN.width}px))` }}
                    >
                      <ResizeHandle edge="left" bounds={ATP_DETAIL} giver={() => graphArea.current} keep={ATP_GRAPH_MIN.width} onResize={resize("detail")} />
                      <div className="dashed-b flex items-center gap-1 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]">
                        {docked && glance && (
                          <ColumnTab active={showing === "chat"} onClick={() => setFront("chat")}>
                            <MessagesSquare size={12} /> Orchestrator
                            {glance.running ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> : unread && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                          </ColumnTab>
                        )}
                        {selectedNode && (
                          <ColumnTab active={showing === "node"} onClick={() => setFront("node")}>
                            <StatusIcon node={selectedNode} stalled={selectedNode.id === stalled} size={11} />
                            <span className="min-w-0 truncate font-mono">{selectedNode.id}</span>
                          </ColumnTab>
                        )}
                        {tabs
                          .filter((tab) => tab.startsWith("worker:"))
                          .map((tab) => (
                            <WorkerTab key={tab} handle={tab.slice("worker:".length)} active={showing === tab} onClick={() => setFront(tab)} onClose={() => closeWorker(tab.slice("worker:".length))} />
                          ))}
                        <div className="flex-1" />
                        {shownChat && (
                          <button type="button" onClick={() => activate(shownChat)} title="Open as a chat" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
                            <SquareArrowOutUpRight size={13} />
                          </button>
                        )}
                        <button type="button" onClick={() => setCollapsed(true)} title="Hide the side panel" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
                          <ChevronRight size={14} />
                        </button>
                      </div>
                      {showing === "node" && selectedNode ? (
                        <NodePanel
                          plan={plan}
                          node={selectedNode}
                          cwd={page.cwd}
                          runner={runners[plan.path]}
                          stalled={selectedNode.id === stalled}
                          onSelect={(id) => {
                            showNode(id);
                            graph.current?.reveal(id);
                          }}
                          onClose={() => showNode(undefined)}
                          onOpenChat={openWorker}
                        />
                      ) : showing === "chat" ? (
                        chat.handle && <SideChat handle={chat.handle} placeholder={PLAN_PLACEHOLDER} />
                      ) : (
                        showing && <SideChat key={showing} handle={showing.slice("worker:".length)} />
                      )}
                    </aside>
                  ))}
              </div>
            </>
          ) : current ? (
            <Unreadable file={current} />
          ) : (
            <Empty cwd={page.cwd} onNew={newPlan} />
          )}
        </section>
      </div>
    </div>
  );
}

function NewPlanButton({ onPick }: { onPick: (skill: string) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="no-drag relative">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised">
        <Plus size={13} />
        New plan
      </button>
      <Popover open={open} onClose={close} className="top-full right-0 mt-1 w-80 p-1">
        {ARCHITECTS.map((architect) => (
          <button
            key={architect.skill}
            type="button"
            onClick={() => {
              setOpen(false);
              onPick(architect.skill);
            }}
            className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-raised"
          >
            <span className="flex items-baseline gap-2 text-[13px] text-fg">
              {architect.label}
              <span className="font-mono text-[10.5px] text-faint">{architect.skill}</span>
            </span>
            <span className="text-[12px] leading-snug text-muted">{architect.about}</span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

// ── The plans ────────────────────────────────────────────────────────────────

/** The plan you look at, next to the project in the header: a menu of the project's plans. */
function PlanSwitch({
  files,
  current,
  runners,
  held,
  onSelect,
}: {
  files: AtpPlanFile[];
  current: string | undefined;
  runners: Record<string, Runner>;
  held: string[];
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const home = window.studio.homeDir;
  if (!files.length && current !== "new") return null;
  const file = files.find((other) => other.path === current);
  return (
    <>
      <ChevronRight size={13} className="shrink-0 text-faint" />
      <div className="no-drag relative min-w-0">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={file ? tildify(file.path, home) : undefined}
          className="flex max-w-80 min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-fg hover:bg-raised"
        >
          {file && runners[file.path] && <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
          <span className="truncate">{current === "new" ? "New plan" : file ? (file.plan?.name ?? planName(file.path)) : "Plans"}</span>
          {file && held.includes(file.path) && <Pause size={11} className="shrink-0 text-warn" />}
          <ChevronDown size={12} className="shrink-0 text-faint" />
        </button>
        <Popover open={open} onClose={close} className="top-full left-0 mt-1 flex max-h-[70vh] w-80 flex-col gap-0.5 overflow-y-auto p-1">
          {current === "new" && (
            <div className="rounded-lg bg-raised/60 px-2.5 py-2 text-[12.5px] text-fg">
              New plan
              <div className="text-[11.5px] text-faint">The architect is writing it</div>
            </div>
          )}
          {files.map((option) => {
            const progress = option.plan && planProgress(option.plan);
            const runner = runners[option.path];
            return (
              <button
                key={option.path}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSelect(option.path);
                }}
                title={tildify(option.path, home)}
                className={`flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left hover:bg-raised ${option.path === current ? "bg-raised/60" : ""}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {runner ? <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{option.plan?.name ?? planName(option.path)}</span>
                  {held.includes(option.path) && <Pause size={11} className="shrink-0 text-warn" />}
                </span>
                {progress ? (
                  <>
                    <ProgressBar plan={option.plan as AtpPlan} />
                    <span className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-faint">
                      <ProjectStatus status={(option.plan as AtpPlan).status} />
                      <span className="font-mono">
                        {progress.completed}/{progress.total}
                      </span>
                      {progress.failed > 0 && <span className="font-mono text-bad">{progress.failed} failed</span>}
                      <span className="ml-auto">{relativeTime(option.modifiedAt)}</span>
                    </span>
                  </>
                ) : (
                  <span className="flex items-center gap-1 text-[11px] text-bad">
                    <FileWarning size={11} /> Cannot read it
                  </span>
                )}
              </button>
            );
          })}
        </Popover>
      </div>
    </>
  );
}

function ProjectStatus({ status }: { status: AtpPlan["status"] }) {
  const tone = status === "ACTIVE" ? "text-accent border-accent/40" : status === "DRAFT" ? "text-warn border-warn/40" : "text-faint border-line-strong";
  return <span className={`rounded border px-1 font-mono text-[9.5px] leading-[14px] tracking-wide ${tone}`}>{status}</span>;
}

/** Done, failed and running shares of the plan's nodes. */
function ProgressBar({ plan }: { plan: AtpPlan }) {
  const progress = planProgress(plan);
  const total = Math.max(1, progress.total);
  const parts = [
    { value: progress.completed, className: "bg-ok" },
    { value: progress.failed, className: "bg-bad" },
    { value: progress.claimed, className: "bg-accent pulse-dot" },
  ];
  return (
    <span className="flex h-1 w-full overflow-hidden rounded-full bg-line">
      {parts.map((part, index) => (part.value ? <span key={index} className={part.className} style={{ width: `${(part.value / total) * 100}%` }} /> : null))}
    </span>
  );
}

/** Above the graph: the plan, its progress, and its run (start, stop, what it does now, why it stopped). */
function PlanBar({
  plan,
  cwd,
  runner,
  stalled,
  held,
  note,
  onReveal,
  onOpenChat,
}: {
  plan: AtpPlan;
  cwd: string;
  runner?: Runner;
  stalled?: string;
  held: boolean;
  note?: RunNote;
  onReveal: (id: string) => void;
  onOpenChat: (handle: string) => void;
}) {
  const home = window.studio.homeDir;
  const worker = useApp((state) => taskModel(state.settings, "worker"));
  const progress = planProgress(plan);
  const finished = progress.total > 0 && progress.completed === progress.total;
  const percent = progress.total ? Math.floor((progress.completed / progress.total) * 100) : 0;
  return (
    <div className="dashed-b flex shrink-0 flex-col gap-2 px-5 pt-3 pb-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="min-w-0 truncate text-[14px] font-medium text-fg" title={tildify(plan.path, home)}>
          {plan.name}
        </span>
        <ProjectStatus status={plan.status} />
        <div className="flex-1" />
        {held && (
          <button
            type="button"
            onClick={() => void liftHold(plan.path)}
            title="The orchestrator paused the plan while it changes it; no node is claimed until it resumes"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-warn/40 px-2 py-0.5 text-[12px] text-warn hover:bg-warn/10"
          >
            <Pause size={12} /> Paused by the orchestrator · Lift
          </button>
        )}
        {runner ? (
          <>
            <RunnerState runner={runner} onReveal={onReveal} onOpenChat={onOpenChat} />
            <button
              type="button"
              disabled={runner.phase === "stopping"}
              onClick={() => void stopPlan(plan.path)}
              title="Abort the worker; its node goes back to READY"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised disabled:opacity-50"
            >
              <Square size={11} fill="currentColor" /> {runner.phase === "stopping" ? "Stopping…" : "Stop"}
            </button>
          </>
        ) : (
          !finished &&
          plan.status !== "ARCHIVED" && (
            <button
              type="button"
              onClick={() => void startPlan(plan.path, cwd)}
              title={`Run the plan one node at a time, each in a fresh ${worker.id} (${worker.thinking}) worker chat that commits its node`}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-[12.5px] font-medium text-white hover:opacity-90"
            >
              <Play size={11} fill="currentColor" /> {stalled ? "Resume" : plan.status === "DRAFT" ? "Start" : "Run"}
            </button>
          )
        )}
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <StatusCounts plan={plan} stalled={stalled} onReveal={onReveal} />
        <div className="flex-1" />
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {progress.completed}/{progress.total} · <span className="text-muted">{percent}%</span>
        </span>
      </div>
      <ProgressBar plan={plan} />
      {stalled && (
        <p className="text-[12px] text-warn">
          <button type="button" onClick={() => onReveal(stalled)} className="font-mono underline decoration-dotted">
            {stalled}
          </button>{" "}
          was left claimed when its run stopped. Resume runs it again in a fresh worker chat, or{" "}
          <button type="button" onClick={() => void releaseInterrupted(plan.path, stalled)} className="underline decoration-dotted hover:text-fg">
            release it
          </button>{" "}
          to READY.
        </p>
      )}
      {note && !runner && <p className={`text-[12px] ${note.level === "error" ? "text-bad" : "text-muted"}`}>{note.text}</p>}
      {note && runner && note.level === "info" && <p className="text-[12px] text-faint">{note.text}</p>}
    </div>
  );
}

const COUNT_ORDER: NodeLook[] = ["running", "stalled", "failed", "ready", "done", "scope", "locked", "closed"];
const COUNT_DOT: Record<NodeLook, string> = {
  running: "bg-accent pulse-dot",
  stalled: "bg-warn",
  failed: "bg-bad",
  ready: "border border-dashed border-accent",
  done: "bg-ok",
  scope: "border border-accent/60",
  locked: "bg-faint/50",
  closed: "border border-faint/50",
};

/** The plan's nodes by status; a count shows its nodes one after another. */
function StatusCounts({ plan, stalled, onReveal }: { plan: AtpPlan; stalled?: string; onReveal: (id: string) => void }) {
  const groups = useMemo(() => {
    const byLook = new Map<NodeLook, string[]>();
    for (const node of plan.nodes) {
      const look = lookOf(node, node.id === stalled);
      byLook.set(look, [...(byLook.get(look) ?? []), node.id]);
    }
    return COUNT_ORDER.flatMap((look) => (byLook.get(look)?.length ? [{ look, ids: byLook.get(look) as string[] }] : []));
  }, [plan.nodes, stalled]);
  const turn = useRef<Partial<Record<NodeLook, number>>>({});
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {groups.map(({ look, ids }) => (
        <button
          key={look}
          type="button"
          onClick={() => {
            const index = turn.current[look] ?? 0;
            turn.current[look] = index + 1;
            onReveal(ids[index % ids.length] as string);
          }}
          title={`Show the ${LOOK_LABEL[look].toLowerCase()} nodes one by one`}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-raised hover:text-fg"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${COUNT_DOT[look]}`} />
          <span className="font-mono text-fg">{ids.length}</span>
          {LOOK_LABEL[look].toLowerCase()}
        </button>
      ))}
    </div>
  );
}

const PHASES: Record<Runner["phase"], string> = {
  starting: "Starting",
  claiming: "Claiming the next node",
  working: "Working on",
  nudging: "Asking the worker to finish",
  committing: "Committing",
  held: "Waiting for the orchestrator",
  stopping: "Stopping",
};

function RunnerState({ runner, onReveal, onOpenChat }: { runner: Runner; onReveal: (id: string) => void; onOpenChat: (handle: string) => void }) {
  // Whether the worker's chat is open here, not the chat: it streams while the runner works.
  const chat = useApp((state) => (runner.handle && state.sessions[runner.handle] ? runner.handle : undefined));
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
      <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <span className="shimmer shrink-0">{PHASES[runner.phase]}</span>
      {runner.node && (
        <button type="button" onClick={() => onReveal(runner.node as string)} className="min-w-0 truncate font-mono text-fg hover:underline" title={runner.title}>
          {runner.node}
        </button>
      )}
      {runner.phase === "working" && (
        <span className="font-mono text-faint">
          <Elapsed since={runner.since} plain />
        </span>
      )}
      {chat && (
        <button type="button" onClick={() => onOpenChat(chat)} title="Open the worker's chat" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
          <MessagesSquare size={13} />
        </button>
      )}
    </span>
  );
}

// ── A node ───────────────────────────────────────────────────────────────────

function NodePanel({
  plan,
  node,
  cwd,
  runner,
  stalled,
  onSelect,
  onClose,
  onOpenChat,
}: {
  plan: AtpPlan;
  node: AtpNode;
  cwd: string;
  runner?: Runner;
  stalled: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Opens a worker chat as a tab of the side column. */
  onOpenChat: (handle: string) => void;
}) {
  useNow(60_000);
  const threads = useThreads(plan.path);
  // The running worker's chat by handle and session file, not the chat: it streams while the runner works.
  const live = useApp((state) => (runner?.node === node.id && runner.handle && state.sessions[runner.handle] ? runner.handle : undefined));
  const livePath = useApp((state) => (live ? state.sessions[live]?.sessionPath : undefined));
  const neededBy = plan.nodes.filter((other) => other.dependencies.includes(node.id));
  const scope = plan.nodes.find((other) => other.scope && other.children.includes(node.id));
  const chats = threads?.workers[node.id] ?? [];
  const byId = new Map(plan.nodes.map((other) => [other.id, other]));
  const stamp = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? formatStamp(Date.parse(iso)) : undefined);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const links = (title: string, ids: string[]) =>
    ids.length > 0 && (
      <div>
        <div className="mb-1 text-[11.5px] font-medium text-faint">{title}</div>
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => {
            const other = byId.get(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(id)}
                title={other?.title}
                className="flex max-w-full items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11.5px] text-muted hover:border-line-strong hover:text-fg"
              >
                {other && <StatusIcon node={other} size={11} />}
                <span className="truncate font-mono">{id}</span>
              </button>
            );
          })}
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="dashed-b flex items-center gap-2 px-3.5 py-2.5">
        <StatusIcon node={node} stalled={stalled} />
        <span className="text-[12px] text-muted">{node.closed ? `${LOOK_LABEL.closed} · ${node.closed.toLowerCase()}` : LOOK_LABEL[lookOf(node, stalled)]}</span>
        <span className="selectable min-w-0 truncate font-mono text-[11.5px] text-faint">{node.id}</span>
        <div className="flex-1" />
        <button type="button" onClick={onClose} title="Close (Esc)" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
          <X size={14} />
        </button>
      </div>
      <div className="selectable min-h-0 flex-1 space-y-4 overflow-y-auto px-3.5 py-3">
        <h3 className="text-[15px] leading-snug font-medium text-fg">{node.title}</h3>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-faint">
          {node.worker && <span>Worker {node.worker}</span>}
          {stamp(node.startedAt) && <span>Started {stamp(node.startedAt)}</span>}
          {stamp(node.completedAt) && <span>Finished {stamp(node.completedAt)}</span>}
          {node.effort && <span>Effort {node.effort}</span>}
        </div>
        {(live || chats.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {live && (
              <button
                type="button"
                onClick={() => onOpenChat(live)}
                className="flex items-center gap-1.5 rounded-lg border border-accent/50 px-2 py-1 text-[12px] text-accent hover:bg-accent-soft"
              >
                <MessagesSquare size={12} /> Open the running worker
              </button>
            )}
            {chats
              .filter((path) => path !== livePath)
              .map((path, index) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => onOpenChat(threadHandle(cwd, path, `ATP ${node.id}: ${node.title}`, { role: "worker", plan: plan.path, node: node.id }))}
                  className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg"
                >
                  <MessagesSquare size={12} /> Worker chat{chats.length > 1 ? ` ${index + 1}` : ""}
                </button>
              ))}
          </div>
        )}
        {node.report && (
          <section>
            <div className={`mb-1 text-[11.5px] font-medium ${node.status === "FAILED" ? "text-bad" : "text-faint"}`}>Report</div>
            <div className="atp-doc text-[13px] text-fg/90">
              <Markdown text={node.report} />
            </div>
          </section>
        )}
        {node.instruction && (
          <section>
            <div className="mb-1 text-[11.5px] font-medium text-faint">Instruction</div>
            <div className="atp-doc text-[13px] text-fg/90">
              <Markdown text={node.instruction} />
            </div>
          </section>
        )}
        {node.context && (
          <section>
            <div className="mb-1 text-[11.5px] font-medium text-faint">Context</div>
            <div className="atp-doc text-[12.5px] text-muted">
              <Markdown text={node.context} />
            </div>
          </section>
        )}
        {scope && links("Part of", [scope.id])}
        {node.scope && links("Subtasks", node.children)}
        {links("Depends on", node.dependencies)}
        {links("Needed by", neededBy.map((other) => other.id))}
        {node.artifacts.length > 0 && (
          <section>
            <div className="mb-1 text-[11.5px] font-medium text-faint">Artifacts</div>
            <ul className="space-y-0.5 font-mono text-[11.5px] text-muted">
              {node.artifacts.map((artifact) => (
                <li key={artifact} className="truncate" title={artifact}>
                  {artifact}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// ── The orchestrator ─────────────────────────────────────────────────────────

const PLAN_PLACEHOLDER = "How is it going? Add, split or rewire nodes…";

interface Orchestrator {
  /** The chat while this window has it. Its session streams: the parts that show it select it (SideChat, OrchestratorDock). */
  handle?: string;
  /** A start that failed (most often: the orchestrator model is not available). */
  failed?: string;
  retry: () => void;
}

/** The plan's orchestrator (without a plan: the architect's chat for a new one), started while the page shows it. */
function useOrchestrator(cwd: string, plan: string | undefined, shown: boolean): Orchestrator {
  const [handle, setHandle] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!shown) return;
    let current = true;
    setHandle(undefined);
    setFailed(undefined);
    orchestrator(cwd, plan).then(
      (started) => current && setHandle(started),
      (error: unknown) => current && setFailed(remoteError(error)),
    );
    return () => {
      current = false;
    };
  }, [cwd, plan, attempt, shown]);
  // A new plan's chat moves to the plan once the architect writes it: keep showing it.
  const adopted = useAtp((state) => (plan ? state.orchestrators[plan] : state.orchestrators[`new:${cwd}`]));
  const open = useApp((state) => {
    const current = adopted ?? handle;
    return current && state.sessions[current] ? current : undefined;
  });
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return shown ? { handle: open, failed, retry } : { retry };
}

/** A chat you are not looking at settled with something new (an answer streams into an item it already has). */
function useUnread(handle: string | undefined, glance: ChatGlance | undefined, looking: boolean): boolean {
  const mark = glance?.mark ?? "";
  const [seen, setSeen] = useState({ handle, mark });
  // Another chat (another plan's) starts out read.
  const fresh = seen.handle !== handle;
  useEffect(() => {
    if (looking || fresh) setSeen({ handle, mark });
  }, [looking, fresh, handle, mark]);
  return Boolean(glance && !looking && !fresh && !glance.running && mark !== seen.mark);
}

function ColumnTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

/**
 * A chat in the side column (the orchestrator once you talked to it, a worker): the whole conversation and its composer.
 * It selects the chat itself, so its streaming renders this column, not the page.
 */
function SideChat({ handle, placeholder }: { handle: string; placeholder?: string }) {
  const session = useApp((state) => state.sessions[handle]);
  if (!session) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Transcript session={session} earlier={earlierTurns(session)} />
      <div className="px-3 pb-3">
        <Composer key={session.handle} handle={session.handle} floating placeholder={placeholder} />
      </div>
    </div>
  );
}

function WorkerTab({ handle, active, onClick, onClose }: { handle: string; active: boolean; onClick: () => void; onClose: () => void }) {
  const node = useApp((state) => state.sessions[handle]?.atp?.node);
  const running = useApp((state) => Boolean(state.sessions[handle]?.running));
  return (
    <span className={`group flex min-w-0 shrink-0 items-center rounded-md ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}>
      <button type="button" aria-pressed={active} onClick={onClick} title={node ? `Worker chat of ${node}` : "Worker chat"} className="flex min-w-0 items-center gap-1.5 py-1 pl-2 text-[12px]">
        <MessagesSquare size={12} />
        <span className="max-w-32 truncate font-mono">{node ?? "Worker"}</span>
        {running && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
      <button type="button" onClick={onClose} title="Close" className="rounded p-1 text-faint hover:text-fg">
        <X size={11} />
      </button>
    </span>
  );
}

/**
 * The orchestrator's composer floating over the graph, before you talk to a plan's orchestrator (then it moves to the
 * side column). The architect's chat for a new plan is the page until it writes the plan, so it stays here, its
 * conversation in a floating panel above the composer.
 */
function OrchestratorDock({
  chat,
  plan,
  height,
  onResize,
  onInset,
}: {
  chat: Orchestrator;
  plan?: string;
  height: number;
  onResize: (height: number, done: boolean) => void;
  onInset: (height: number) => void;
}) {
  const room = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const { handle, failed, retry } = chat;
  const session = useApp((state) => (handle ? state.sessions[handle] : undefined));
  const present = Boolean(session) || failed !== undefined;
  // The graph keeps the plan above the composer.
  useLayoutEffect(() => {
    const element = bottom.current;
    if (!element) return;
    const report = () => onInset(Math.ceil(element.getBoundingClientRect().height) + DOCK_MARGIN);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onInset(0);
    };
  }, [present, onInset]);
  if (!session) {
    if (failed === undefined) return null;
    // A failed start stays in the dock with a way out, instead of a toast that leaves the page without a composer.
    return (
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-end px-4" style={{ paddingBottom: DOCK_MARGIN }}>
        <div
          ref={bottom}
          role="alert"
          className="pointer-events-auto flex w-full max-w-[720px] items-start gap-3 rounded-2xl border border-bad/40 bg-panel/90 px-4 py-3 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.6)] backdrop-blur-xl"
        >
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-bad" />
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="text-fg">The orchestrator could not start</div>
            <div className="selectable mt-0.5 break-words text-muted">{failed}</div>
          </div>
          <button type="button" onClick={retry} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised">
            <RefreshCw size={12} /> Try again
          </button>
          <button type="button" onClick={() => openSettings("models")} className="shrink-0 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised">
            Orchestrator model…
          </button>
        </div>
      </div>
    );
  }
  const talked = session.items.length > 0 || session.running;
  return (
    // Only the panel and the composer take the pointer: the plan pans and zooms around them.
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center px-4" style={{ paddingBottom: DOCK_MARGIN }}>
      <div ref={room} className="min-h-6 flex-1" />
      <div className="flex min-h-0 w-full max-w-[720px] flex-col gap-2">
        {talked && (
          <div
            className="pointer-events-auto relative flex min-h-0 shrink flex-col overflow-hidden rounded-2xl border border-line-strong bg-canvas/90 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.6)] backdrop-blur-xl"
            style={{ height }}
          >
            <ResizeHandle edge="top" bounds={ATP_DOCK} giver={() => room.current} keep={24} onResize={onResize} />
            <Transcript session={session} earlier={earlierTurns(session)} />
          </div>
        )}
        <div ref={bottom} className="pointer-events-auto">
          <Composer
            key={session.handle}
            handle={session.handle}
            floating
            placeholder={plan ? PLAN_PLACEHOLDER : "/skill:atp-architect or atp-micro-architect, then what to build…"}
          />
        </div>
      </div>
    </div>
  );
}

/** The gap under the floating composer. */
const DOCK_MARGIN = 16;

// ── Empty and broken ─────────────────────────────────────────────────────────

/** Until the architect's chat starts: then the chat, floating over this, is the page. */
function NewPlanIntro({ cwd, inset }: { cwd: string; inset: number }) {
  const handle = useAtp((state) => state.orchestrators[`new:${cwd}`]);
  const talked = useApp((state) => {
    const session = handle ? state.sessions[handle] : undefined;
    return Boolean(session && (session.items.length > 0 || session.running));
  });
  // The architect works in a git worktree of the project (none outside git), so the plan stays off the checkout.
  const where = useApp((state) => (handle ? state.sessions[handle]?.cwd : undefined));
  const home = window.studio.homeDir;
  if (talked) return <div className="flex-1" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-10 text-center" style={{ paddingBottom: inset }}>
      <Network size={28} className="text-faint" />
      <p className="max-w-lg text-[13px] leading-relaxed text-muted">
        Describe what to build in the composer below. The architect asks what it needs, then writes the plan to{" "}
        <span className="font-mono text-[12px]">
          {baseName(cwd)}/{NEW_PLAN_DIR}/&lt;name&gt;.atp.json
        </span>{" "}
        {where && where !== cwd && (
          <>
            in its own git worktree (<span className="font-mono text-[12px]">{tildify(where, home)}</span>), where the plan also runs,{" "}
          </>
        )}
        as a DRAFT. It shows up here; review it, then start it.
      </p>
    </div>
  );
}

function Empty({ cwd, onNew }: { cwd: string; onNew: (skill: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-10 text-center">
      <Network size={32} className="text-faint" />
      <p className="max-w-lg text-[13px] leading-relaxed text-muted">
        No ATP plans in {baseName(cwd) || "this project"}. An ATP plan breaks a big project into a graph of nodes; pi-gna runs them one at a time, each in a fresh
        worker chat that must finish, fail or split its node and commit it before the next one starts, so nothing gets skipped halfway.
      </p>
      <div className="flex gap-2">
        {ARCHITECTS.map((architect) => (
          <button
            key={architect.skill}
            type="button"
            onClick={() => onNew(architect.skill)}
            title={architect.about}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] text-fg hover:bg-raised"
          >
            <Plus size={13} /> {architect.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Unreadable({ file }: { file: AtpPlanFile }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 text-center">
      <FileWarning size={28} className="text-bad" />
      <p className="selectable max-w-lg text-[12.5px] text-muted">
        pi-gna cannot read <span className="font-mono">{tildify(file.path, window.studio.homeDir)}</span>: {file.error}
      </p>
    </div>
  );
}
