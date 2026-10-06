// The phone's ATP page: a project's plans as on the desktop (Atp.tsx), run by the host. Nodes grouped by status are the
// primary view, the graph (AtpGraph, with touch pan and pinch) the other; a node opens to its instruction, report and
// chats, and the orchestrator is a full chat screen. The run lives in Electron main, so closing the page stops nothing.
import { ChevronRight, Layers, MessagesSquare, Network, Pause, Play, Plus, Search, Square } from "../renderer/src/components/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtpGraph, type GraphHandle, LOOK_LABEL, lookOf, StatusIcon } from "../renderer/src/components/AtpGraph";
import { Markdown } from "../renderer/src/components/Markdown";
import { Elapsed } from "../renderer/src/components/primitives";
import { baseName, formatStamp, relativeTime, tildify } from "../renderer/src/lib/format";
import { useStore } from "../renderer/src/lib/store";
import { type AtpNode, type AtpPlan, type AtpPlanFile, NEW_PLAN_DIR, planName, planProgress } from "../shared/atp";
import type { AtpPlanThreads, AtpRunner } from "../shared/host-api";
import { ARCHITECTS, defaultPlan, groupNodes, PHASES, stalledNode, startLabel } from "./atp-data";
import type { HostClient } from "./client/host-client";
import type { Route } from "./nav";
import { Header } from "./Screens";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sheetRow = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] active:bg-raised";
/** How often the open page looks at the plans again: node status changes land in the plan file, the run's events only say that something changed. */
const POLL_MS = 3000;
/** The plan you looked at last per project, for this page load. */
const lastSelected = new Map<string, string>();
/** Groups that start folded: their nodes need nothing from you. */
const FOLDED = new Set(["done", "closed"]);

const TONE = { ACTIVE: "text-accent border-accent/40", DRAFT: "text-warn border-warn/40" } as Record<string, string>;
const StatusBadge = ({ status }: { status: AtpPlan["status"] }) => (
  <span className={`rounded border px-1 font-mono text-[10px] leading-[15px] tracking-wide ${TONE[status] ?? "text-faint border-line-strong"}`}>{status}</span>
);

/** Done, failed and running shares of the plan's nodes. */
function Progress({ plan }: { plan: AtpPlan }) {
  const progress = planProgress(plan);
  const total = Math.max(1, progress.total);
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-line" data-testid="progress">
      {[
        { value: progress.completed, className: "bg-ok" },
        { value: progress.failed, className: "bg-bad" },
        { value: progress.claimed, className: "bg-accent pulse-dot" },
      ].map((part, index) => (part.value ? <span key={index} className={part.className} style={{ width: `${(part.value / total) * 100}%` }} /> : null))}
    </span>
  );
}

/** The project's plans, looked at again while the page is open (the host's own watch belongs to the desktop window). */
function usePlans(client: HostClient, cwd: string, again: unknown): { files: AtpPlanFile[]; loaded: boolean; refresh: () => void } {
  const [files, setFiles] = useState<AtpPlanFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(() => {
    client.call("atp.plans", { cwd }).then(
      (found) => {
        setFiles(found.plans);
        setLoaded(true);
      },
      (error) => toast(message(error), "error"),
    );
  }, [client, cwd]);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  // A run starting, finishing or moving to another node: look now instead of at the next tick.
  useEffect(() => {
    if (again !== undefined) refresh();
  }, [again, refresh]);
  return { files, loaded, refresh };
}

export function AtpScreen({ client, homeDir, cwd, push, back }: { client: HostClient; homeDir: string; cwd: string; push: (route: Route) => void; back: () => void }) {
  const state = useStore(client.store, (s) => s.global.atp);
  const runners = state?.runners ?? {};
  const held = state?.held ?? [];
  const notes = state?.notes ?? {};
  const { files, loaded, refresh } = usePlans(client, cwd, state?.runners);
  const [selected, setSelected] = useState(() => lastSelected.get(cwd));
  const [view, setView] = useState<"nodes" | "graph">("nodes");
  const [node, setNode] = useState<string>();
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<"plans" | "new">();
  const [busy, setBusy] = useState(false);
  const graph = useRef<GraphHandle>(null);

  const current = files.find((file) => file.path === selected) ?? defaultPlan(files, runners);
  const plan = current?.plan;
  const runner = plan && runners[plan.path];
  const stalled = stalledNode(plan, runner);
  const selectedNode = node ? plan?.nodes.find((other) => other.id === node) : undefined;
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text || !plan) return new Set<string>();
    return new Set(plan.nodes.filter((other) => other.id.toLowerCase().includes(text) || other.title.toLowerCase().includes(text)).map((other) => other.id));
  }, [query, plan]);

  const run = (what: Promise<unknown>) => what.then(refresh, (error) => toast(message(error), "error"));
  const select = (path: string) => {
    lastSelected.set(cwd, path);
    setSelected(path);
    setNode(undefined);
  };

  /** The plan's orchestrator (or a new plan's architect) as a full chat; the chat screen gives its lease back on leave. */
  const openOrchestrator = async (forPlan: string | undefined, prefill?: string) => {
    setBusy(true);
    try {
      if (!forPlan) await client.call("atp.discardNewPlan", { cwd });
      const { handle } = await client.call("atp.orchestrator", { cwd, ...(forPlan ? { plan: forPlan } : {}) });
      push({ screen: "chat", cwd, handle, title: forPlan ? `Orchestrator: ${planName(forPlan)}` : "New plan", orchestrator: true, prefill });
    } catch (error) {
      toast(`Could not start the orchestrator: ${message(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const label = plan ? startLabel(plan, stalled) : undefined;
  const progress = plan && planProgress(plan);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="atp-screen">
      <Header
        title={plan?.name ?? "ATP plans"}
        subtitle={baseName(cwd)}
        onBack={back}
        trailing={
          <>
            {files.length > 0 && (
              <button type="button" onClick={() => setSheet("plans")} className="flex h-11 items-center gap-1 px-2 text-[13px] text-muted" data-testid="plans-button">
                Plans <span className="font-mono text-[11px] text-faint">{files.length}</span>
              </button>
            )}
            <button type="button" aria-label="New plan" onClick={() => setSheet("new")} className="grid h-11 w-11 place-items-center text-muted active:text-fg" data-testid="new-plan">
              <Plus size={20} />
            </button>
          </>
        }
      />
      {!loaded && <div className="p-6 text-center text-[13.5px] text-faint">Loading…</div>}
      {loaded && !files.length && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center" data-testid="atp-empty">
          <Network size={28} className="text-faint" />
          <p className="text-[13.5px] leading-relaxed text-muted">
            No plans in {baseName(cwd)} yet. An architect writes one to <span className="font-mono text-[12px]">{NEW_PLAN_DIR}/&lt;name&gt;.atp.json</span> as a DRAFT; review it, then start it.
          </p>
          <button type="button" onClick={() => setSheet("new")} className="min-h-11 rounded-xl bg-accent px-5 text-[14px] font-medium text-white">
            New plan
          </button>
        </div>
      )}
      {current && !plan && <p className="p-6 text-center text-[13.5px] text-bad">Cannot read {tildify(current.path, homeDir)}: {current.error}</p>}
      {plan && progress && (
        <>
          <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 pt-3 pb-2.5" data-testid="plan-bar">
            <div className="flex min-w-0 items-center gap-2">
              <StatusBadge status={plan.status} />
              <span className="font-mono text-[12px] text-faint" data-testid="plan-count">
                {progress.completed}/{progress.total}
                {progress.total ? ` · ${Math.floor((progress.completed / progress.total) * 100)}%` : ""}
              </span>
              {progress.failed > 0 && <span className="font-mono text-[12px] text-bad">{progress.failed} failed</span>}
              <div className="flex-1" />
              {runner ? (
                <button
                  type="button"
                  disabled={runner.phase === "stopping"}
                  onClick={() => void run(client.call("atp.stop", { plan: plan.path }))}
                  className="flex min-h-10 items-center gap-1.5 rounded-xl border border-line-strong px-4 text-[14px] text-fg disabled:opacity-50"
                  data-testid="stop"
                >
                  <Square size={12} fill="currentColor" /> {runner.phase === "stopping" ? "Stopping…" : "Stop"}
                </button>
              ) : (
                label && (
                  <button
                    type="button"
                    onClick={() => void run(client.call("atp.start", { plan: plan.path, cwd }))}
                    className="flex min-h-10 items-center gap-1.5 rounded-xl bg-accent px-4 text-[14px] font-medium text-white"
                    data-testid="start"
                  >
                    <Play size={12} fill="currentColor" /> {label}
                  </button>
                )
              )}
            </div>
            <Progress plan={plan} />
            {held.includes(plan.path) && (
              <button type="button" onClick={() => void run(client.call("atp.liftHold", { plan: plan.path }))} className="flex min-h-10 items-center gap-2 rounded-xl border border-warn/40 px-3 text-left text-[13px] text-warn" data-testid="lift">
                <Pause size={14} className="shrink-0" /> Paused by the orchestrator while it changes the plan · Lift
              </button>
            )}
            {runner && <RunnerLine runner={runner} onNode={(id) => (setNode(id), graph.current?.reveal(id))} onChat={(handle) => push({ screen: "chat", cwd, handle, title: `ATP ${runner.node ?? ""}: ${runner.title ?? ""}` })} />}
            {stalled && (
              <p className="text-[13px] leading-relaxed text-warn" data-testid="stalled">
                <button type="button" onClick={() => setNode(stalled)} className="font-mono underline decoration-dotted">{stalled}</button> was left claimed when its run stopped. Resume runs it again in a fresh worker chat, or{" "}
                <button type="button" onClick={() => void run(client.call("atp.releaseInterrupted", { plan: plan.path, node: stalled }))} className="underline decoration-dotted" data-testid="release">
                  release it
                </button>{" "}
                to READY.
              </p>
            )}
            {notes[plan.path] && (!runner || notes[plan.path]?.level === "info") && (
              <p className={`text-[13px] leading-relaxed ${notes[plan.path]?.level === "error" ? "text-bad" : "text-muted"}`} data-testid="run-note">
                {notes[plan.path]?.text}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
            {(["nodes", "graph"] as const).map((tab) => (
              <button key={tab} type="button" aria-pressed={view === tab} onClick={() => setView(tab)} className={`min-h-10 rounded-full px-4 text-[14px] capitalize ${view === tab ? "bg-raised text-fg" : "text-muted"}`} data-testid={`tab-${tab}`}>
                {tab}
              </button>
            ))}
            <label className="ml-auto flex min-w-0 flex-1 items-center gap-1.5 rounded-xl bg-sunken px-2.5">
              <Search size={13} className="shrink-0 text-faint" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node" autoCapitalize="none" autoCorrect="off" className="min-h-9 min-w-0 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-faint" data-testid="node-search" />
            </label>
          </div>
          <div className="relative min-h-0 flex-1">
            {!plan.nodes.length ? (
              <p className="p-10 text-center text-[13.5px] text-faint">This plan has no nodes yet.</p>
            ) : view === "nodes" ? (
              <NodeList plan={plan} stalled={stalled} query={query.trim().toLowerCase()} matches={matches} onOpen={setNode} />
            ) : (
              <AtpGraph ref={graph} plan={plan} selected={node} stalled={stalled} matches={matches} onSelect={setNode} />
            )}
          </div>
          <div className="shrink-0 border-t border-line px-3 py-2">
            <button type="button" disabled={busy} onClick={() => void openOrchestrator(plan.path)} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-line-strong text-[15px] text-fg active:bg-raised disabled:opacity-50" data-testid="orchestrator">
              <MessagesSquare size={17} className="text-muted" /> Orchestrator chat
            </button>
          </div>
        </>
      )}
      {selectedNode && plan && (
        <NodeSheet client={client} cwd={cwd} plan={plan} node={selectedNode} runner={runner || undefined} stalled={selectedNode.id === stalled} onNode={setNode} onClose={() => setNode(undefined)} push={push} />
      )}
      {sheet === "plans" && (
        <Sheet title="Plans" onClose={() => setSheet(undefined)} testId="plans-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {files.map((file) => {
              const found = file.plan && planProgress(file.plan);
              return (
                <button key={file.path} type="button" onClick={() => (setSheet(undefined), select(file.path))} className={`${sheetRow} flex-col items-stretch gap-1.5 py-2.5 ${file.path === current?.path ? "bg-raised/60" : ""}`} data-testid="plan-option">
                  <span className="flex min-w-0 items-center gap-2">
                    {runners[file.path] && <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-accent" />}
                    <span className="min-w-0 flex-1 truncate">{file.plan?.name ?? planName(file.path)}</span>
                    {held.includes(file.path) && <Pause size={12} className="shrink-0 text-warn" />}
                  </span>
                  {file.plan && found ? (
                    <>
                      <Progress plan={file.plan} />
                      <span className="flex items-center gap-2 text-[12px] text-faint">
                        <StatusBadge status={file.plan.status} />
                        <span className="font-mono">{found.completed}/{found.total}</span>
                        {found.failed > 0 && <span className="font-mono text-bad">{found.failed} failed</span>}
                        <span className="ml-auto">{relativeTime(file.modifiedAt)}</span>
                      </span>
                    </>
                  ) : (
                    <span className="text-[12px] text-bad">Cannot read it</span>
                  )}
                </button>
              );
            })}
          </div>
        </Sheet>
      )}
      {sheet === "new" && (
        <Sheet title="New plan" onClose={() => setSheet(undefined)} testId="new-plan-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <p className="px-3 pb-2 text-[13px] leading-relaxed text-faint">The architect asks what it needs, then writes the plan to {NEW_PLAN_DIR}/ as a DRAFT.</p>
            {ARCHITECTS.map((architect) => (
              <button key={architect.skill} type="button" disabled={busy} onClick={() => (setSheet(undefined), void openOrchestrator(undefined, `/skill:${architect.skill} `))} className={`${sheetRow} flex-col items-start gap-0.5 py-2.5`} data-testid={`architect-${architect.skill}`}>
                <span className="text-fg">{architect.label}</span>
                <span className="text-[13px] text-faint">{architect.about}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** What the run does now: its phase, the node, how long, and the worker's chat. */
function RunnerLine({ runner, onNode, onChat }: { runner: AtpRunner; onNode: (id: string) => void; onChat: (handle: string) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted" data-testid="runner">
      <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-accent" />
      <span className="shrink-0">{PHASES[runner.phase]}</span>
      {runner.node && (
        <button type="button" onClick={() => onNode(runner.node as string)} className="min-w-0 truncate py-1 font-mono text-fg" data-testid="runner-node">
          {runner.node}
        </button>
      )}
      {runner.phase === "working" && (
        <span className="font-mono text-faint">
          <Elapsed since={runner.since} plain />
        </span>
      )}
      <div className="flex-1" />
      {runner.handle && (
        <button type="button" aria-label="Open the worker's chat" onClick={() => onChat(runner.handle as string)} className="grid h-10 w-10 shrink-0 place-items-center text-muted" data-testid="runner-chat">
          <MessagesSquare size={16} />
        </button>
      )}
    </div>
  );
}

/** The nodes by status; groups of finished nodes start folded, a search unfolds what it finds. */
function NodeList({ plan, stalled, query, matches, onOpen }: { plan: AtpPlan; stalled?: string; query: string; matches: Set<string>; onOpen: (id: string) => void }) {
  const groups = useMemo(() => groupNodes(plan, stalled), [plan, stalled]);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const toggle = (look: string) => setUnfolded((was) => (was.has(look) ? new Set([...was].filter((other) => other !== look)) : new Set([...was, look])));
  const shown = groups.map((group) => ({ ...group, nodes: query ? group.nodes.filter((node) => matches.has(node.id)) : group.nodes })).filter((group) => group.nodes.length);
  return (
    <div className="h-full overflow-y-auto pb-4" data-testid="node-list">
      {query && !shown.length && <p className="p-8 text-center text-[13.5px] text-faint">No node matches.</p>}
      {shown.map(({ look, nodes }) => {
        const open = query !== "" || !FOLDED.has(look) || unfolded.has(look);
        return (
          <section key={look} data-testid={`group-${look}`}>
            <button type="button" aria-expanded={open} onClick={() => toggle(look)} className="sticky top-0 z-10 flex min-h-11 w-full items-center gap-2 border-b border-line bg-canvas px-4 text-left text-[13px] text-muted">
              <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
              {LOOK_LABEL[look]}
              <span className="font-mono text-[11px] text-faint">{nodes.length}</span>
            </button>
            {open &&
              nodes.map((node) => (
                <button key={node.id} type="button" onClick={() => onOpen(node.id)} className="flex min-h-14 w-full items-center gap-3 border-b border-line px-4 py-2 text-left active:bg-raised" data-testid="node-row" data-node={node.id}>
                  <StatusIcon node={node} stalled={look === "stalled"} size={16} />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[15px] leading-snug text-fg">{node.title}</div>
                    <div className="truncate font-mono text-[11px] text-faint">{node.scope ? `${node.id} · ${node.children.length} subtasks` : node.id}</div>
                  </div>
                  {look === "running" && node.startedAt && !Number.isNaN(Date.parse(node.startedAt)) && (
                    <span className="shrink-0 font-mono text-[11px] text-faint">
                      <Elapsed since={Date.parse(node.startedAt)} plain />
                    </span>
                  )}
                  {node.scope && <Layers size={14} className="shrink-0 text-accent" />}
                </button>
              ))}
          </section>
        );
      })}
    </div>
  );
}

/** One node: its state, the chats that worked on it, report, instruction and context, and its neighbours. */
function NodeSheet({
  client,
  cwd,
  plan,
  node,
  runner,
  stalled,
  onNode,
  onClose,
  push,
}: {
  client: HostClient;
  cwd: string;
  plan: AtpPlan;
  node: AtpNode;
  runner?: AtpRunner;
  stalled: boolean;
  onNode: (id: string) => void;
  onClose: () => void;
  push: (route: Route) => void;
}) {
  const [threads, setThreads] = useState<AtpPlanThreads>();
  // The worker chats of a node are known once its first run starts, so look again when the run moves.
  useEffect(() => {
    client.call("atp.threads", { plan: plan.path }).then(setThreads, () => undefined);
  }, [client, plan.path, runner?.handle]);
  const byId = new Map(plan.nodes.map((other) => [other.id, other]));
  const neededBy = plan.nodes.filter((other) => other.dependencies.includes(node.id)).map((other) => other.id);
  const scope = plan.nodes.find((other) => other.scope && other.children.includes(node.id));
  const chats = threads?.workers[node.id] ?? [];
  const live = runner?.node === node.id ? runner.handle : undefined;
  const stamp = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? formatStamp(Date.parse(iso)) : undefined);
  const title = `ATP ${node.id}: ${node.title}`;

  const links = (heading: string, ids: string[]) =>
    ids.length > 0 && (
      <div>
        <div className="mb-1 text-[12px] font-medium text-faint">{heading}</div>
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => {
            const other = byId.get(id);
            return (
              <button key={id} type="button" onClick={() => onNode(id)} className="flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12px] text-muted active:bg-raised" data-testid="node-link">
                {other && <StatusIcon node={other} size={12} />}
                <span className="truncate font-mono">{id}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  const section = (heading: string, text: string | undefined, tone = "text-faint") =>
    text ? (
      <section data-testid={`node-${heading.toLowerCase()}`}>
        <div className={`mb-1 text-[12px] font-medium ${tone}`}>{heading}</div>
        <div className="atp-doc text-[14px] text-fg/90">
          <Markdown text={text} />
        </div>
      </section>
    ) : null;

  return (
    <Sheet title={node.id} onClose={onClose} testId="node-sheet">
      <div className="selectable min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div className="flex items-start gap-2">
          <span className="mt-1"><StatusIcon node={node} stalled={stalled} size={15} /></span>
          <h3 className="min-w-0 flex-1 text-[16px] leading-snug font-medium text-fg">{node.title}</h3>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-faint">
          <span>{node.closed ? `${LOOK_LABEL.closed} · ${node.closed.toLowerCase()}` : LOOK_LABEL[lookOf(node, stalled)]}</span>
          {node.worker && <span>Worker {node.worker}</span>}
          {stamp(node.startedAt) && <span>Started {stamp(node.startedAt)}</span>}
          {stamp(node.completedAt) && <span>Finished {stamp(node.completedAt)}</span>}
          {node.effort && <span>Effort {node.effort}</span>}
        </div>
        {(live || chats.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {live && (
              <button type="button" onClick={() => push({ screen: "chat", cwd, handle: live, title })} className="flex min-h-10 items-center gap-2 rounded-xl border border-accent/50 px-3 text-[13px] text-accent" data-testid="worker-live">
                <MessagesSquare size={14} /> Open the running worker
              </button>
            )}
            {chats.map((path, index) => (
              <button key={path} type="button" onClick={() => push({ screen: "chat", cwd, sessionPath: path, title })} className="flex min-h-10 items-center gap-2 rounded-xl border border-line-strong px-3 text-[13px] text-muted" data-testid="worker-chat">
                <MessagesSquare size={14} /> Worker chat{chats.length > 1 ? ` ${index + 1}` : ""}
              </button>
            ))}
          </div>
        )}
        {section("Report", node.report, node.status === "FAILED" ? "text-bad" : "text-faint")}
        {section("Instruction", node.instruction)}
        {section("Context", node.context)}
        {scope && links("Part of", [scope.id])}
        {node.scope && links("Subtasks", node.children)}
        {links("Depends on", node.dependencies)}
        {links("Needed by", neededBy)}
        {node.artifacts.length > 0 && (
          <section>
            <div className="mb-1 text-[12px] font-medium text-faint">Artifacts</div>
            <ul className="space-y-0.5 font-mono text-[12px] break-all text-muted">
              {node.artifacts.map((artifact) => (
                <li key={artifact}>{artifact}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  );
}
