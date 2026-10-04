// The Laments page: one project's laments, which agents file with the lament tool when a tool or capability they
// needed was missing, unavailable or failing. Worst first, each with the emoji of its severity; open one to read its
// reports, open the chat that filed it, have a new chat fix it in a git worktree (Fix), and mark it resolved once
// the fix is in (a repeat reopens it).
import { Angry, ChevronRight, CircleCheck, MessagesSquare, RotateCcw, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Lament, type LamentFix, type LamentReport, lamentSeverity, projectLaments, SEVERITIES, SEVERITY, type Severity } from "../../../shared/laments";
import { findSummary } from "../lib/board";
import { baseName, formatStamp, relativeTime } from "../lib/format";
import { fixChat, lamentProjects, lamentSnippet, reportChat } from "../lib/laments";
import { applyLament, fixLament, openSession, type PageState, sessionTitle, showPage, useApp } from "../state/app";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Markdown } from "./Markdown";
import { useNow } from "./primitives";
import { ProjectSwitch } from "./ProjectSwitch";
import { COLLAPSED_INSET } from "./Sidebar";

type Menu = { lament: Lament; at: { x: number; y: number }; confirmDelete?: boolean };

const FIX_HINT = "A new chat fixes it in a git worktree, on a branch of its own; you merge it and mark the lament resolved";
const RESOLVE_HINT = "You fixed it: no chat runs, the lament moves to Resolved";

/** Keyed by project (App), so another project starts on its open laments, none expanded. */
export function LamentsPage({ page }: { page: PageState }) {
  const laments = useApp((state) => state.laments);
  const projects = useApp((state) => state.projects);
  const inset = useApp((state) => state.sidebar.collapsed);
  useNow(60_000); // relative times
  const [resolved, setResolved] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [menu, setMenu] = useState<Menu>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const open = useMemo(() => projectLaments(laments, page.cwd), [laments, page.cwd]);
  const done = useMemo(() => projectLaments(laments, page.cwd, true), [laments, page.cwd]);
  const switchable = useMemo(() => lamentProjects(laments, projects, page.cwd), [laments, projects, page.cwd]);
  const shown = resolved ? done : open;

  const menuSections = (lament: Lament, confirmDelete?: boolean): MenuItem[][] => {
    if (confirmDelete) {
      return [
        [{ label: "Delete this lament", icon: <Trash2 size={13} />, danger: true, onSelect: () => void applyLament({ type: "remove", id: lament.id }) }],
        [{ label: "Cancel", onSelect: () => undefined }],
      ];
    }
    const latest = lament.reports.findLast((report) => report.chat);
    const chat = latest && reportChat(projects, latest);
    const fix = lament.fixes?.at(-1);
    const fixer = fix && fixChat(projects, fix);
    return [
      [
        ...(chat ? [{ label: "Open the chat that filed it", icon: <MessagesSquare size={13} />, hint: chat.title, onSelect: () => openSession(chat) }] : []),
        ...(fixer ? [{ label: "Open the Fix chat", icon: <Wrench size={13} />, hint: fix?.branch ?? fixer.title, onSelect: () => openSession(fixer) }] : []),
      ],
      [
        ...(lament.resolvedAt ? [] : [{ label: "Fix", icon: <Wrench size={13} />, hint: FIX_HINT, onSelect: () => void fixLament(lament) }]),
        lament.resolvedAt
          ? { label: "Reopen", icon: <RotateCcw size={13} />, onSelect: () => void applyLament({ type: "resolve", id: lament.id, resolved: false }) }
          : { label: "Mark resolved", icon: <CircleCheck size={13} />, hint: RESOLVE_HINT, onSelect: () => void applyLament({ type: "resolve", id: lament.id, resolved: true }) },
        // A second menu asks first: a lament's reports cannot be brought back.
        { label: "Delete…", icon: <Trash2 size={13} />, danger: true, onSelect: () => setMenu({ lament, at: menu?.at ?? { x: 0, y: 0 }, confirmDelete: true }) },
      ],
    ];
  };

  return (
    <div className="page-enter flex h-full min-w-0 flex-col">
      <header className="drag dashed-b flex h-[52px] shrink-0 items-center gap-2 px-5" style={inset ? { paddingLeft: COLLAPSED_INSET } : undefined}>
        <Angry size={15} className="text-muted" />
        <span className="text-[13.5px] font-medium text-fg">Laments</span>
        <ProjectSwitch cwd={page.cwd} options={switchable} openTitle="Open laments" onPick={(cwd) => showPage("laments", cwd)} />
        <div className="flex-1" />
        <div className="no-drag flex items-center gap-0.5 rounded-lg border border-line p-0.5">
          {[
            { label: "Open", count: open.length, value: false },
            { label: "Resolved", count: done.length, value: true },
          ].map((tab) => (
            <button
              key={tab.label}
              type="button"
              aria-pressed={resolved === tab.value}
              onClick={() => setResolved(tab.value)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12.5px] ${resolved === tab.value ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
            >
              {tab.label}
              <span className="font-mono text-[11px] text-faint">{tab.count}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {shown.length === 0 && <Empty project={baseName(page.cwd) || "this project"} resolved={resolved} />}
          {shown.map((lament) => (
            <LamentView
              key={lament.id}
              lament={lament}
              expanded={expanded === lament.id}
              onToggle={() => setExpanded(expanded === lament.id ? undefined : lament.id)}
              onMenu={(at) => setMenu({ lament, at })}
            />
          ))}
        </div>
      </div>

      {menu && <ContextMenu at={menu.at} sections={menuSections(menu.lament, menu.confirmDelete)} onClose={closeMenu} />}
    </div>
  );
}

export function SeverityMark({ severity, size = 18 }: { severity: Severity; size?: number }) {
  const { emoji, label, about } = SEVERITY[severity];
  return (
    <span role="img" aria-label={label} title={`${label}: ${about}`} className="shrink-0 leading-none select-none" style={{ fontSize: size }}>
      {emoji}
    </span>
  );
}

function Empty({ project, resolved }: { project: string; resolved: boolean }) {
  if (resolved) return <p className="px-2 py-6 text-center text-[12.5px] text-faint">No resolved laments for {project} yet.</p>;
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="text-[40px] leading-none select-none">😌</span>
      <p className="max-w-md text-[12.5px] leading-relaxed text-faint">
        Nothing to lament in {project}. When a chat needs a tool or capability that is missing, unavailable or failing, it files a lament here with its
        workaround, so you know what to fix.
      </p>
      <div className="flex gap-4 text-[12px] text-muted">
        {SEVERITIES.map((severity) => (
          <span key={severity} className="flex items-center gap-1.5" title={SEVERITY[severity].about}>
            <SeverityMark severity={severity} size={14} />
            {SEVERITY[severity].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function LamentView({ lament, expanded, onToggle, onMenu }: { lament: Lament; expanded: boolean; onToggle: () => void; onMenu: (at: { x: number; y: number }) => void }) {
  const severity = lamentSeverity(lament);
  const repeats = lament.reports.length - 1;
  const fixing = lament.resolvedAt ? undefined : lament.fixes?.at(-1);
  return (
    <article
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`rounded-xl border bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.12)] transition-colors ${expanded ? "border-line-strong" : "border-line hover:border-line-strong"}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left + 12, y: rect.bottom - 4 });
          }
        }}
        className="flex w-full items-start gap-3 rounded-xl px-3.5 py-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <SeverityMark severity={severity} size={22} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 text-[13.5px] leading-snug text-fg ${expanded ? "" : "line-clamp-2"}`}>{lament.title}</span>
            {fixing && (
              <span className="flex shrink-0 items-center self-center text-muted" title={fixing.branch ? `A Fix chat works on it, on branch ${fixing.branch}` : "A Fix chat works on it"}>
                <Wrench size={11} />
              </span>
            )}
            {repeats > 0 && (
              <span className="shrink-0 rounded-full border border-line px-1.5 font-mono text-[10.5px] leading-4 text-muted" title={`Hit ${lament.reports.length} times`}>
                ×{lament.reports.length}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10.5px] text-faint" title={formatStamp(lament.updatedAt)}>
              {relativeTime(lament.updatedAt)}
            </span>
          </div>
          {!expanded && <div className="mt-0.5 truncate text-[12px] text-faint">{lamentSnippet(lament)}</div>}
        </div>
        <ChevronRight size={14} className={`mt-1 shrink-0 text-faint transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && <LamentDetail lament={lament} />}
    </article>
  );
}

function LamentDetail({ lament }: { lament: Lament }) {
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!deleting) return;
    const timer = setTimeout(() => setDeleting(false), 4000);
    return () => clearTimeout(timer);
  }, [deleting]);
  return (
    <div className="dashed-t px-3.5 pt-3 pb-3">
      <ol className="flex flex-col gap-4 pl-[34px]">
        {[...lament.reports].reverse().map((report, index) => (
          <ReportView key={`${report.at}-${index}`} report={report} first={index === lament.reports.length - 1} />
        ))}
      </ol>
      {lament.fixes?.length ? (
        <ul className="mt-4 flex flex-col gap-1 pl-[34px]">
          {[...lament.fixes].reverse().map((fix) => (
            <FixView key={fix.chat.path} fix={fix} />
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex items-center gap-1.5 pl-[34px]">
        {!lament.resolvedAt && (
          <button
            type="button"
            title={FIX_HINT}
            onClick={() => void fixLament(lament)}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised"
          >
            <Wrench size={13} className="text-muted" />
            Fix
          </button>
        )}
        <button
          type="button"
          title={lament.resolvedAt ? undefined : RESOLVE_HINT}
          onClick={() => void applyLament({ type: "resolve", id: lament.id, resolved: !lament.resolvedAt })}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-fg hover:bg-raised"
        >
          {lament.resolvedAt ? <RotateCcw size={13} className="text-muted" /> : <CircleCheck size={13} className="text-ok" />}
          {lament.resolvedAt ? "Reopen" : "Mark resolved"}
        </button>
        <span className="flex-1 pl-1 text-[11.5px] text-faint">
          {lament.resolvedAt ? `Resolved ${formatStamp(lament.resolvedAt)}; the next repeat reopens it` : `Filed ${formatStamp(lament.createdAt)}`}
        </span>
        <span className="selectable font-mono text-[11px] text-faint">{lament.id}</span>
        <button
          type="button"
          onClick={() => {
            if (!deleting) return setDeleting(true);
            void applyLament({ type: "remove", id: lament.id });
          }}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] ${deleting ? "bg-bad/15 text-bad" : "text-faint hover:bg-raised hover:text-bad"}`}
        >
          <Trash2 size={13} />
          {deleting ? "Delete this lament?" : "Delete"}
        </button>
      </div>
    </div>
  );
}

/** A chat the lament's Fix started: open it, with its branch. */
function FixView({ fix }: { fix: LamentFix }) {
  const projects = useApp((state) => state.projects);
  const sessions = useApp((state) => state.sessions);
  const live = Object.values(sessions).find((session) => session.sessionPath === fix.chat.path);
  const chat = fixChat(projects, fix);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11.5px] text-faint">
      <Wrench size={11} />
      <span>Fix started {formatStamp(fix.at)}</span>
      <button type="button" onClick={() => openSession(chat)} className="flex min-w-0 items-center gap-1 rounded px-1 hover:bg-raised hover:text-fg" title="Open this chat">
        · <MessagesSquare size={11} /> <span className="max-w-64 truncate">{live ? sessionTitle(live) : chat.title}</span>
      </button>
      {fix.branch && <span className="selectable font-mono text-[11px]">· {fix.branch}</span>}
    </li>
  );
}

function ReportView({ report, first }: { report: LamentReport; first: boolean }) {
  const projects = useApp((state) => state.projects);
  const sessions = useApp((state) => state.sessions);
  const chat = reportChat(projects, report);
  const live = report.chat && Object.values(sessions).find((session) => session.sessionPath === report.chat?.path);
  const title = live ? sessionTitle(live) : report.chat && (findSummary(projects, report.chat.path)?.title ?? "a chat");
  return (
    <li className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-faint">
        <SeverityMark severity={report.severity} size={12} />
        <span>{SEVERITY[report.severity].label}</span>
        <span>· {first ? "filed" : "hit again"} {formatStamp(report.at)}</span>
        {chat && (
          <button type="button" onClick={() => openSession(chat)} className="flex min-w-0 items-center gap-1 rounded px-1 hover:bg-raised hover:text-fg" title="Open this chat">
            · <MessagesSquare size={11} /> <span className="max-w-64 truncate">{title}</span>
          </button>
        )}
      </div>
      <div className="lament-report mt-1 text-fg/90">
        <Markdown text={report.text} />
      </div>
    </li>
  );
}
