// The phone's Laments page: one project's laments as on the desktop (Laments.tsx), worst first. A row opens to its
// reports and the chats that filed them; the actions sheet starts a Fix chat on the Mac, marks resolved/reopens, deletes.
import { ChevronRight, CircleCheck, MessagesSquare, MoreHorizontal, RotateCcw, Trash2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { Markdown } from "../renderer/src/components/Markdown";
import { baseName, formatStamp, relativeTime } from "../renderer/src/lib/format";
import { fixChat, lamentSnippet, reportChat } from "../renderer/src/lib/laments";
import { useStore } from "../renderer/src/lib/store";
import { type Lament, type LamentOp, lamentSeverity, projectLaments, SEVERITY, type Severity } from "../shared/laments";
import type { HostClient } from "./client/host-client";
import type { Route } from "./nav";
import { Header } from "./Screens";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sheetRow = "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] active:bg-raised";

function Mark({ severity, size }: { severity: Severity; size: number }) {
  const { emoji, label } = SEVERITY[severity];
  return (
    <span role="img" aria-label={label} className="shrink-0 leading-none select-none" style={{ fontSize: size }}>
      {emoji}
    </span>
  );
}

export function LamentsScreen({ client, cwd, push, back }: { client: HostClient; cwd: string; push: (route: Route) => void; back: () => void }) {
  const laments = useStore(client.store, (s) => s.global.laments);
  const projects = useStore(client.store, (s) => s.global.projects) ?? [];
  const [resolved, setResolved] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; confirmDelete?: boolean }>();
  const open = useMemo(() => (laments ? projectLaments(laments, cwd) : []), [laments, cwd]);
  const done = useMemo(() => (laments ? projectLaments(laments, cwd, true) : []), [laments, cwd]);
  const shown = resolved ? done : open;
  const target = menu && [...open, ...done].find((lament) => lament.id === menu.id);

  const apply = (op: LamentOp) => client.call("laments.apply", { op }).catch((e) => toast(message(e), "error"));
  const openChat = (ref: { path: string; cwd: string }, title: string) => push({ screen: "chat", cwd: ref.cwd, sessionPath: ref.path, title });
  const fix = (lament: Lament) =>
    client.call("chat.startTask", { target: { kind: "fix", lament: lament.id } }).then(
      (started) => {
        for (const notice of started.notices) toast(notice.text, notice.level);
        push({ screen: "chat", cwd: lament.cwd, handle: started.handle, title: `Fix: ${lament.title}` });
      },
      (e) => toast(message(e), "error"),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="laments-screen">
      <Header title="Laments" subtitle={baseName(cwd)} onBack={back} />
      <div className="flex shrink-0 gap-2 border-b border-line px-4 py-2">
        {[
          { label: "Open", count: open.length, value: false },
          { label: "Resolved", count: done.length, value: true },
        ].map((tab) => (
          <button
            key={tab.label}
            type="button"
            aria-pressed={resolved === tab.value}
            onClick={() => setResolved(tab.value)}
            className={`flex min-h-10 items-center gap-2 rounded-full px-4 text-[14px] ${resolved === tab.value ? "bg-raised text-fg" : "text-muted"}`}
            data-testid={`tab-${tab.label.toLowerCase()}`}
          >
            {tab.label}
            <span className="font-mono text-[11px] text-faint">{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-6">
        {!laments && <div className="p-6 text-center text-[13.5px] text-faint">Loading…</div>}
        {laments && shown.length === 0 && (
          <p className="px-4 py-10 text-center text-[13.5px] leading-relaxed text-faint" data-testid="laments-empty">
            {resolved ? `No resolved laments for ${baseName(cwd)} yet.` : `Nothing to lament in ${baseName(cwd)}. Chats file a lament here when a tool or capability is missing or failing.`}
          </p>
        )}
        <div className="flex flex-col gap-2">
          {shown.map((lament) => {
            const isOpen = expanded === lament.id;
            const fixing = lament.resolvedAt ? undefined : lament.fixes?.at(-1);
            return (
              <article key={lament.id} className="rounded-xl border border-line bg-panel" data-testid="lament">
                <div className="flex items-start">
                  <button type="button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? undefined : lament.id)} className="flex min-w-0 flex-1 items-start gap-3 rounded-xl px-3.5 py-3 text-left" data-testid="lament-row">
                    <Mark severity={lamentSeverity(lament)} size={22} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={`min-w-0 flex-1 text-[15px] leading-snug text-fg ${isOpen ? "" : "line-clamp-2"}`}>{lament.title}</span>
                        {fixing && <Wrench size={12} className="shrink-0 self-center text-muted" aria-label="A Fix chat works on it" />}
                        {lament.reports.length > 1 && <span className="shrink-0 rounded-full border border-line px-1.5 font-mono text-[11px] text-muted">×{lament.reports.length}</span>}
                        <span className="shrink-0 font-mono text-[11px] text-faint">{relativeTime(lament.updatedAt)}</span>
                      </div>
                      {!isOpen && <div className="mt-0.5 truncate text-[13px] text-faint">{lamentSnippet(lament)}</div>}
                    </div>
                    <ChevronRight size={15} className={`mt-1 shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  </button>
                  <button type="button" aria-label="Actions" onClick={() => setMenu({ id: lament.id })} className="grid h-12 w-11 shrink-0 place-items-center text-muted" data-testid="lament-actions">
                    <MoreHorizontal size={18} />
                  </button>
                </div>
                {isOpen && (
                  <div className="border-t border-line px-3.5 py-3" data-testid="lament-detail">
                    <ol className="flex flex-col gap-4">
                      {[...lament.reports].reverse().map((report, index) => {
                        const chat = reportChat(projects, report);
                        return (
                          <li key={`${report.at}-${index}`} className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-faint">
                              <Mark severity={report.severity} size={12} />
                              <span>{SEVERITY[report.severity].label}</span>
                              <span>· {index === lament.reports.length - 1 ? "filed" : "hit again"} {formatStamp(report.at)}</span>
                              {chat && (
                                <button type="button" onClick={() => openChat(chat, chat.title)} className="flex min-w-0 items-center gap-1 py-1 text-accent" data-testid="report-chat">
                                  · <MessagesSquare size={12} /> <span className="max-w-48 truncate">{chat.title}</span>
                                </button>
                              )}
                            </div>
                            <div className="lament-report mt-1 text-fg/90">
                              <Markdown text={report.text} />
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                    {lament.fixes?.length ? (
                      <ul className="mt-4 flex flex-col gap-1">
                        {[...lament.fixes].reverse().map((f) => {
                          const chat = fixChat(projects, f);
                          return (
                            <li key={f.chat.path} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-faint">
                              <Wrench size={12} />
                              <span>Fix started {formatStamp(f.at)}</span>
                              <button type="button" onClick={() => openChat(chat, chat.title)} className="flex min-w-0 items-center gap-1 py-1 text-accent" data-testid="fix-chat">
                                · <MessagesSquare size={12} /> <span className="max-w-48 truncate">{chat.title}</span>
                              </button>
                              {f.branch && <span className="font-mono">· {f.branch}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    <div className="mt-3 text-[12px] text-faint">{lament.resolvedAt ? `Resolved ${formatStamp(lament.resolvedAt)}; the next repeat reopens it` : `Filed ${formatStamp(lament.createdAt)}`}</div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {menu && target && (
        <Sheet title={menu.confirmDelete ? "Delete this lament?" : target.title.slice(0, 60)} onClose={() => setMenu(undefined)} testId="lament-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {menu.confirmDelete ? (
              <>
                <p className="px-3 pb-2 text-[13.5px] text-faint">Its reports cannot be brought back.</p>
                <button type="button" className={`${sheetRow} text-bad`} onClick={() => { setMenu(undefined); void apply({ type: "remove", id: target.id }); }} data-testid="confirm-delete">
                  <Trash2 size={17} /> Delete
                </button>
                <button type="button" className={`${sheetRow} text-fg`} onClick={() => setMenu(undefined)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {!target.resolvedAt && (
                  <button type="button" className={`${sheetRow} text-fg`} onClick={() => { setMenu(undefined); void fix(target); }} data-testid="action-fix">
                    <Wrench size={17} className="text-muted" /> Fix
                  </button>
                )}
                <button type="button" className={`${sheetRow} text-fg`} onClick={() => { setMenu(undefined); void apply({ type: "resolve", id: target.id, resolved: !target.resolvedAt }); }} data-testid="action-resolve">
                  {target.resolvedAt ? <RotateCcw size={17} className="text-muted" /> : <CircleCheck size={17} className="text-ok" />}
                  {target.resolvedAt ? "Reopen" : "Mark resolved"}
                </button>
                <button type="button" className={`${sheetRow} text-bad`} onClick={() => setMenu({ id: target.id, confirmDelete: true })} data-testid="action-delete">
                  <Trash2 size={17} /> Delete…
                </button>
              </>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
