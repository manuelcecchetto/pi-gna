// The ATP page: one project's ATP plans (`*.atp.json`), for big projects that must not get lazy halfway. A plan is
// a graph of nodes that pi-gna runs one fresh worker chat at a time (state/atp.ts); the page draws it (AtpGraph),
// starts and stops the run, shows a node's instruction, report and worker chats, and has the plan's orchestrator
// floating over the graph: a chat to ask how it is going, change the plan, or write a new one with the architect skills.
import {
  ChevronDown,
  ChevronRight,
  FileWarning,
  Maximize2,
  MessageCircle,
  MessageCircleOff,
  MessagesSquare,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ATP_CONFIG, type AtpNode, type AtpPlan, type AtpPlanFile, NEW_PLAN_DIR, planName, planProgress } from "../../../shared/atp";
import { taskModel } from "../../../shared/settings";
import { baseName, formatStamp, relativeTime, tildify } from "../lib/format";
import { ATP_DETAIL, ATP_DOCK, ATP_GRAPH_MIN, type AtpPanels, loadAtpPanels, saveAtpPanels } from "../lib/layout";
import type { SessionState } from "../../../shared/session-state";
import { presentTool } from "../lib/tools";
import { chatPeek, createRunDeriver, type PeekBubble, type Step } from "../lib/view";
import { activate, type PageState, prefill, showPage, toast, useApp } from "../state/app";
import {
  discardNewPlanChat,
  liftHold,
  orchestrator,
  openThread,
  releaseInterrupted,
  releaseOrchestrators,
  type Runner,
  type RunNote,
  startPlan,
  stopPlan,
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
      setNode(undefined);
    },
    [page.cwd],
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
    setNode(id);
  };

  const newPlan = async (skill: string) => {
    select("new");
    await discardNewPlanChat(page.cwd);
    try {
      prefill(await orchestrator(page.cwd, undefined), `/skill:${skill} `);
    } catch (error) {
      toast(`Could not start the architect: ${(error as Error).message}`, "error");
    }
  };

  const dock = (selected === "new" || plan) && (
    <OrchestratorDock cwd={page.cwd} plan={selected === "new" ? undefined : plan?.path} height={panels.dock} onResize={resize("dock")} onInset={setCovered} />
  );

  const switchable = useMemo(() => [...new Set([page.cwd, ...projects.map((other) => other.cwd)])].map((cwd) => ({ cwd, open: 0 })), [projects, page.cwd]);
  const selectedNode = node && plan?.nodes.find((other) => other.id === node);

  return (
    <div className="page-enter flex h-full min-w-0 flex-col">
      <header className="drag dashed-b flex h-[52px] shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
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
                onReveal={(id) => (graph.current?.reveal(id), setNode(id))}
              />
              <div className="flex flex-1" style={{ minHeight: ATP_GRAPH_MIN.height }}>
                <div ref={graphArea} className="relative min-w-0 flex-1">
                  {plan.nodes.length ? (
                    <AtpGraph ref={graph} plan={plan} selected={node} stalled={stalled} matches={matches} onSelect={setNode} inset={covered} />
                  ) : (
                    <p className="p-10 text-center text-[12.5px] text-faint">This plan has no nodes yet.</p>
                  )}
                  {dock}
                </div>
                {selectedNode && (
                  <NodePanel
                    plan={plan}
                    node={selectedNode}
                    cwd={page.cwd}
                    runner={runners[plan.path]}
                    stalled={selectedNode.id === stalled}
                    onSelect={(id) => {
                      setNode(id);
                      graph.current?.reveal(id);
                    }}
                    onClose={() => setNode(undefined)}
                    width={panels.detail}
                    giver={() => graphArea.current}
                    onResize={resize("detail")}
                  />
                )}
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
}: {
  plan: AtpPlan;
  cwd: string;
  runner?: Runner;
  stalled?: string;
  held: boolean;
  note?: RunNote;
  onReveal: (id: string) => void;
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
            <RunnerState runner={runner} onReveal={onReveal} />
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

function RunnerState({ runner, onReveal }: { runner: Runner; onReveal: (id: string) => void }) {
  const session = useApp((state) => (runner.handle ? state.sessions[runner.handle] : undefined));
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
      {session && (
        <button type="button" onClick={() => activate(session.handle)} title="Open the worker's chat" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
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
  width,
  giver,
  onResize,
}: {
  plan: AtpPlan;
  node: AtpNode;
  cwd: string;
  runner?: Runner;
  stalled: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  width: number;
  giver: () => Element | null;
  onResize: (width: number, done: boolean) => void;
}) {
  useNow(60_000);
  const threads = useThreads(plan.path);
  const live = useApp((state) => (runner?.node === node.id && runner.handle ? state.sessions[runner.handle] : undefined));
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
    <aside
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-line bg-panel"
      // Narrowed when the window is too small to leave the graph its minimum; the remembered width stays.
      style={{ width: `clamp(${ATP_DETAIL.min}px, ${width}px, calc(100% - ${ATP_GRAPH_MIN.width}px))` }}
    >
      <ResizeHandle edge="left" bounds={ATP_DETAIL} giver={giver} keep={ATP_GRAPH_MIN.width} onResize={onResize} />
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
                onClick={() => activate(live.handle)}
                className="flex items-center gap-1.5 rounded-lg border border-accent/50 px-2 py-1 text-[12px] text-accent hover:bg-accent-soft"
              >
                <MessagesSquare size={12} /> Open the running worker
              </button>
            )}
            {chats
              .filter((path) => path !== live?.sessionPath)
              .map((path, index) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => openThread(cwd, path, `ATP ${node.id}: ${node.title}`, { role: "worker", plan: plan.path, node: node.id })}
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
    </aside>
  );
}

// ── The orchestrator ─────────────────────────────────────────────────────────

type ChatView = "bubbles" | "full" | "hidden";

/** The last turns the bubbles show. */
const PEEK_TURNS = 2;

/**
 * The plan's orchestrator floats over the graph: its composer at the bottom, and its conversation above it, either
 * as bubbles of the last few turns (the plan stays in view around them) or whole, in a floating panel.
 */
function OrchestratorDock({
  cwd,
  plan,
  height,
  onResize,
  onInset,
}: {
  cwd: string;
  plan?: string;
  height: number;
  onResize: (height: number, done: boolean) => void;
  onInset: (height: number) => void;
}) {
  const room = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<string>();
  useEffect(() => {
    let current = true;
    orchestrator(cwd, plan).then(
      (started) => current && setHandle(started),
      (error: Error) => toast(`Could not start the orchestrator: ${error.message}`, "error"),
    );
    return () => {
      current = false;
    };
  }, [cwd, plan]);
  // A new plan's chat moves to the plan once the architect writes it: keep showing it.
  const adopted = useAtp((state) => (plan ? state.orchestrators[plan] : state.orchestrators[`new:${cwd}`]));
  const session = useApp((state) => {
    const current = adopted ?? handle;
    return current ? state.sessions[current] : undefined;
  });
  // The architect's chat is the page until it writes the plan: it opens whole.
  const [view, setView] = useState<ChatView>(plan === undefined ? "full" : "bubbles");
  const running = Boolean(session?.running);
  useEffect(() => {
    if (running) setView((current) => (current === "hidden" ? "bubbles" : current));
  }, [running]);
  // Pointing at the chat keeps its bubbles up; going into the composer brings them back for a while.
  const [pointing, setPointing] = useState(false);
  const [woken, setWoken] = useState(0);
  const present = Boolean(session);
  // The graph keeps the plan above the composer (the bubbles float over it, like the minimap).
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
  if (!session) return null;
  const talked = session.items.length > 0 || session.running;
  return (
    // Only the composer, the bubbles and the panel take the pointer: the plan pans and zooms around them.
    <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center px-4" style={{ paddingBottom: DOCK_MARGIN }}>
      <div ref={room} className="min-h-6 flex-1" />
      <div
        className="flex min-h-0 w-full max-w-[720px] flex-col gap-2"
        onPointerEnter={() => setPointing(true)}
        onPointerLeave={() => setPointing(false)}
        onFocus={() => setWoken((count) => count + 1)}
      >
        {talked && view === "full" && (
          <div
            className="pointer-events-auto relative flex min-h-0 shrink flex-col overflow-hidden rounded-2xl border border-line-strong bg-canvas/90 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.6)] backdrop-blur-xl"
            style={{ height }}
          >
            <ResizeHandle edge="top" bounds={ATP_DOCK} giver={() => room.current} keep={24} onResize={onResize} />
            <Transcript session={session} />
          </div>
        )}
        {talked && view === "bubbles" && <ChatBubbles session={session} pointing={pointing} woken={woken} onExpand={() => setView("full")} />}
        <div ref={bottom} className="flex flex-col gap-1.5">
          {talked && (
            <div className="flex justify-end px-1 text-faint">
              <span className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-full border border-line bg-panel/80 p-0.5 shadow-[0_6px_16px_-10px_rgb(0_0_0/0.5)] backdrop-blur-md">
                <ViewButton
                  title="The last messages, as bubbles over the plan; they fade once it goes quiet, and point here or at the composer to bring them back"
                  active={view === "bubbles"}
                  onClick={() => (setView("bubbles"), setWoken((count) => count + 1))}
                >
                  <MessageCircle size={12} />
                </ViewButton>
                <ViewButton title="The whole conversation" active={view === "full"} onClick={() => setView("full")}>
                  <Maximize2 size={12} />
                </ViewButton>
                <ViewButton title="Hide the conversation" active={view === "hidden"} onClick={() => setView("hidden")}>
                  <MessageCircleOff size={12} />
                </ViewButton>
                <span className="mx-0.5 h-3 w-px bg-line-strong" />
                <ViewButton title="Open as a chat" onClick={() => activate(session.handle)}>
                  <MessagesSquare size={12} />
                </ViewButton>
              </span>
            </div>
          )}
          <div className="pointer-events-auto">
            <Composer
              key={session.handle}
              session={session}
              floating
              placeholder={plan ? "How is it going? Add, split or rewire nodes…" : "/skill:atp-architect or atp-micro-architect, then what to build…"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The gap under the floating composer. */
const DOCK_MARGIN = 16;

function ViewButton({ title, active = false, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-full ${active ? "bg-raised text-fg" : "text-faint hover:bg-raised hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

/** How long the bubbles stay after the orchestrator goes quiet (or you leave them), before they fade away. */
const FADE_AFTER = 12_000;

/**
 * The last turns as chat bubbles over the plan, like a game's chat: yours on the right, the orchestrator's answers on
 * the left. While it works, a bubble says what it does; long answers clip and open the whole conversation. Once it is
 * quiet they fade away, and come back with its next message, while you point at the chat, or when you go into the
 * composer.
 */
function ChatBubbles({ session, pointing, woken, onExpand }: { session: SessionState; pointing: boolean; woken: number; onExpand: () => void }) {
  const derive = useMemo(() => createRunDeriver(), []);
  const peek = chatPeek(derive(session), PEEK_TURNS);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** At the end, so new messages and streaming keep it there; only scrolling up leaves it. */
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const shown = peek.bubbles.length > 0 || peek.working;
  // On every size change, not render: a bubble learns that it clips (and grows "Show all") after this renders.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !content.current) return;
    const follow = () => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [shown]);

  const latest = peek.bubbles.at(-1);
  const change = `${peek.bubbles.length}:${latest?.key}:${latest?.text.length}:${peek.working}`;
  const awake = peek.working || pointing;
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    setFaded(false);
    if (awake) return;
    const timer = setTimeout(() => setFaded(true), FADE_AFTER);
    return () => clearTimeout(timer);
  }, [change, awake, woken]);

  if (!shown) return null;
  const count = peek.bubbles.length;
  return (
    <div
      ref={scroller}
      onWheel={(event) => {
        if (event.deltaY < 0) pinned.current = false;
      }}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 8) pinned.current = true;
        else if (element.scrollTop < lastTop.current) pinned.current = false;
        lastTop.current = element.scrollTop;
      }}
      data-faded={faded || undefined}
      className="atp-bubbles max-h-[min(42vh,420px)] min-h-0 overflow-y-auto px-1 pt-10"
    >
      <div ref={content} className="flex flex-col gap-2">
        {peek.bubbles.map((bubble, index) => (
          <Bubble key={bubble.key} bubble={bubble} old={count - index > 2} onExpand={onExpand} />
        ))}
        {peek.working && <WorkingBubble step={peek.step} cwd={session.cwd} />}
      </div>
    </div>
  );
}

// Nearly opaque rather than blurred glass: the list's fade (a mask) leaves backdrop-filter nothing to blur.
const BUBBLE_SURFACE = "pointer-events-auto shadow-[0_10px_28px_-14px_rgb(0_0_0/0.6)]";

/** `old`: an earlier turn's bubble, dimmed until you point at it. */
function Bubble({ bubble, old, onExpand }: { bubble: PeekBubble; old: boolean; onExpand: () => void }) {
  const user = bubble.from === "user";
  const tone = user
    ? "rounded-br-md bg-raised/95 text-fg"
    : bubble.error
      ? "rounded-bl-md border border-bad/30 bg-panel/95 text-bad"
      : "rounded-bl-md border border-line bg-panel/95 text-fg";
  return (
    <div className={`bubble-in flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={`atp-bubble max-w-[85%] min-w-0 rounded-[18px] px-3.5 py-2 text-[13px] leading-relaxed transition-colors ${old ? "text-muted! hover:text-fg!" : ""} ${BUBBLE_SURFACE} ${tone}`}
      >
        <Clipped tail={bubble.streaming} onExpand={onExpand}>
          {user || bubble.error ? <div className="selectable break-words whitespace-pre-wrap">{bubble.text}</div> : <Markdown text={bubble.text} streaming={bubble.streaming} />}
        </Clipped>
      </div>
    </div>
  );
}

const CLIP = 168;

/** A bubble's text up to CLIP px; a longer one fades out (at the top while it streams, to show the newest text). */
function Clipped({ tail, onExpand, children }: { tail: boolean; onExpand: () => void; children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const element = inner.current;
    if (element) setOver(element.offsetHeight > CLIP + 1);
  });
  const fade = tail ? "linear-gradient(to bottom, transparent, black 3em)" : "linear-gradient(to top, transparent, black 3em)";
  return (
    <>
      <div className={`overflow-hidden ${tail ? "flex flex-col justify-end" : ""}`} style={{ maxHeight: CLIP, maskImage: over ? fade : undefined }}>
        <div ref={inner} className="shrink-0">
          {children}
        </div>
      </div>
      {over && !tail && (
        <button type="button" onClick={onExpand} className="mt-1 text-[11.5px] text-muted hover:text-fg">
          Show all
        </button>
      )}
    </>
  );
}

function WorkingBubble({ step, cwd }: { step?: Step; cwd: string }) {
  const doing =
    step?.kind === "tool"
      ? (() => {
          const tool = presentTool(step.call.name, step.call.arguments, cwd, undefined, window.studio.homeDir);
          return [tool.activeVerb, tool.target].filter(Boolean).join(" ");
        })()
      : step?.kind === "thinking"
        ? "Thinking"
        : "Working";
  return (
    <div className="bubble-in flex justify-start">
      <div className={`flex max-w-[85%] min-w-0 items-center gap-2 rounded-full border border-line bg-panel/95 px-3 py-1.5 text-[12px] text-muted ${BUBBLE_SURFACE}`}>
        <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span className="shimmer truncate">{doing}</span>
      </div>
    </div>
  );
}

// ── Empty and broken ─────────────────────────────────────────────────────────

/** Until the architect's chat starts: then the chat, floating over this, is the page. */
function NewPlanIntro({ cwd, inset }: { cwd: string; inset: number }) {
  const handle = useAtp((state) => state.orchestrators[`new:${cwd}`]);
  const talked = useApp((state) => {
    const session = handle ? state.sessions[handle] : undefined;
    return Boolean(session && (session.items.length > 0 || session.running));
  });
  if (talked) return <div className="flex-1" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-10 text-center" style={{ paddingBottom: inset }}>
      <Network size={28} className="text-faint" />
      <p className="max-w-lg text-[13px] leading-relaxed text-muted">
        Describe what to build in the composer below. The architect asks what it needs, then writes the plan to{" "}
        <span className="font-mono text-[12px]">
          {baseName(cwd)}/{NEW_PLAN_DIR}/&lt;name&gt;.atp.json
        </span> as a DRAFT. It shows up here; review it, then start it.
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
