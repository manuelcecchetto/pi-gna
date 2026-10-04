// Projects and Chats: the two list screens above a chat.
import { ChevronLeft, ChevronRight, Pin } from "lucide-react";
import { useStore } from "../renderer/src/lib/store";
import { relativeTime, tildify } from "../renderer/src/lib/format";
import type { Attention } from "../shared/session-state";
import { chatItems, projectItems } from "./chat-list";
import type { HostClient } from "./client/host-client";
import type { Route } from "./nav";

const MARKS: Record<Exclude<Attention, "idle">, { label: string; color: string; pulse?: boolean }> = {
  waiting: { label: "Waiting for you", color: "var(--accent)", pulse: true },
  running: { label: "Working", color: "var(--ok)", pulse: true },
  failed: { label: "Failed", color: "var(--bad)" },
  unread: { label: "New activity", color: "var(--accent)" },
};

export function Mark({ level }: { level?: Attention }) {
  if (!level || level === "idle") return null;
  const mark = MARKS[level];
  return <span role="img" aria-label={mark.label} title={mark.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${mark.pulse ? "animate-pulse" : ""}`} style={{ background: mark.color }} />;
}

export function Header({ title, subtitle, onBack, trailing }: { title: string; subtitle?: string; onBack?: () => void; trailing?: React.ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1">
      {onBack ? (
        <button type="button" aria-label="Back" onClick={onBack} className="grid h-11 w-11 shrink-0 place-items-center text-muted active:text-fg">
          <ChevronLeft size={22} />
        </button>
      ) : (
        <div className="w-3 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium text-fg">{title}</div>
        {subtitle && <div className="truncate font-mono text-[11px] text-faint">{subtitle}</div>}
      </div>
      {trailing}
    </header>
  );
}

const row = "flex min-h-14 w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left active:bg-raised";

export function Projects({ client, homeDir, push, footer }: { client: HostClient; homeDir: string; push: (route: Route) => void; footer?: React.ReactNode }) {
  const projects = useStore(client.store, (s) => s.global.projects);
  const pins = useStore(client.store, (s) => s.global.ui?.pins);
  const attention = useStore(client.store, (s) => s.global.attention);
  const items = projects ? projectItems(projects, pins ?? [], attention) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title="Projects" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!items && <div className="p-6 text-center text-[13.5px] text-faint">Loading…</div>}
        {items?.length === 0 && <div className="p-6 text-center text-[13.5px] text-faint">No sessions yet. Start one on the Mac.</div>}
        {items?.map((item) => (
          <button key={item.cwd} type="button" className={row} onClick={() => push({ screen: "chats", cwd: item.cwd })}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[15px] text-fg">
                {item.pinned && <Pin size={12} className="shrink-0 text-faint" />}
                <span className="truncate">{item.cwd.split("/").filter(Boolean).at(-1) ?? item.cwd}</span>
              </div>
              <div className="truncate font-mono text-[11px] text-faint">{tildify(item.cwd, homeDir)}</div>
            </div>
            <Mark level={item.attention} />
            <span className="shrink-0 text-[12px] text-faint">{item.chats}</span>
            <ChevronRight size={16} className="shrink-0 text-faint" />
          </button>
        ))}
        {footer}
      </div>
    </div>
  );
}

export function Chats({ client, homeDir, cwd, push, back }: { client: HostClient; homeDir: string; cwd: string; push: (route: Route) => void; back: () => void }) {
  const projects = useStore(client.store, (s) => s.global.projects);
  const pins = useStore(client.store, (s) => s.global.ui?.pins);
  const attention = useStore(client.store, (s) => s.global.attention);
  const items = projects ? chatItems(projects, pins ?? [], attention, cwd) : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={cwd.split("/").filter(Boolean).at(-1) ?? cwd} subtitle={tildify(cwd, homeDir)} onBack={back} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items?.length === 0 && <div className="p-6 text-center text-[13.5px] text-faint">No chats in this project.</div>}
        {items?.map((item) => (
          <button key={item.path} type="button" className={row} onClick={() => push({ screen: "chat", cwd, sessionPath: item.path, handle: item.handle, title: item.title })}>
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[15px] text-fg">{item.title}</div>
              {item.time !== undefined && <div className="font-mono text-[11px] text-faint">{relativeTime(item.time)}</div>}
            </div>
            <Mark level={item.attention} />
            <ChevronRight size={16} className="shrink-0 text-faint" />
          </button>
        ))}
      </div>
    </div>
  );
}
