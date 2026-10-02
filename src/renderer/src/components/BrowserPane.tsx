// The integrated browser: tab strip and toolbar in the DOM, the page itself is a native
// WebContentsView that main draws over the viewport element we report.
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Code2,
  Globe,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Plus,
  RotateCw,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserTab, HistoryEntry } from "../../../shared/browser";
import { fuzzyFilter } from "../lib/fuzzy";
import { setPane, useApp } from "../state/app";

const browser = () => window.studio.browser;

export function BrowserPane() {
  const state = useApp((s) => s.browser);
  const pane = useApp((s) => s.pane);
  const lightbox = useApp((s) => s.lightbox);
  const sessions = useApp((s) => s.sessions);
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  const [suggesting, setSuggesting] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  // Native views draw above the DOM, so hide the page while a DOM overlay must cover it.
  const visible = pane.open && Boolean(active) && !lightbox && !suggesting;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const report = () => {
      const r = element.getBoundingClientRect();
      browser().layout({ visible, bounds: { x: r.left, y: r.top, width: r.width, height: r.height } });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [visible, pane.full, pane.split]);

  useEffect(() => () => browser().layout({ visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }), []);

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <div className="drag dashed-b flex h-[52px] shrink-0 items-center gap-1 overflow-hidden px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.tabs.map((tab) => (
            <TabPill key={tab.id} tab={tab} active={tab.id === state.activeId} agentRunning={Boolean(tab.agent && sessions[tab.agent]?.running)} />
          ))}
          <IconButton title="New tab" onClick={() => browser().newTab()}>
            <Plus size={14} />
          </IconButton>
        </div>
        <IconButton title={pane.full ? "Split view" : "Full view"} onClick={() => setPane({ full: !pane.full })}>
          {pane.full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton title="Close browser (⌘B)" onClick={() => setPane({ open: false, full: false })}>
          <X size={15} />
        </IconButton>
      </div>

      {active && (
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-2">
          <IconButton title="Back" disabled={!active.canGoBack} onClick={() => browser().command(active.id, "back")}>
            <ArrowLeft size={15} />
          </IconButton>
          <IconButton title="Forward" disabled={!active.canGoForward} onClick={() => browser().command(active.id, "forward")}>
            <ArrowRight size={15} />
          </IconButton>
          <IconButton title={active.loading ? "Stop" : "Reload"} onClick={() => browser().command(active.id, active.loading ? "stop" : "reload")}>
            {active.loading ? <X size={15} /> : <RotateCw size={14} />}
          </IconButton>
          <AddressBar tab={active} onSuggesting={setSuggesting} />
          <IconButton
            title={state.annotating ? "Stop commenting (Esc in page)" : "Comment on elements"}
            active={state.annotating}
            onClick={() => browser().annotate(!state.annotating)}
          >
            <MessageSquarePlus size={15} />
          </IconButton>
          <IconButton title="Inspect" onClick={() => browser().inspect(active.id)}>
            <Code2 size={15} />
          </IconButton>
          <IconButton title="Open in default browser" onClick={() => window.studio.openExternal(active.url)}>
            <SquareArrowOutUpRight size={14} />
          </IconButton>
        </div>
      )}

      <div ref={viewport} className="relative min-h-0 flex-1 bg-sunken">
        {!active && <StartPage />}
        {active && !visible && <div className="grid h-full place-items-center text-[12px] text-faint">{active.title || active.url}</div>}
      </div>
      {state.annotating && (
        <div className="shrink-0 border-t border-accent/30 bg-accent-soft px-3 py-1.5 text-[12px] text-fg">
          Click an element in the page to comment on it. Comments are attached to your next prompt. Esc stops.
        </div>
      )}
    </div>
  );
}

function TabPill({ tab, active, agentRunning }: { tab: BrowserTab; active: boolean; agentRunning: boolean }) {
  const label = tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab";
  return (
    <div
      className={`group flex h-8 max-w-48 min-w-24 shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2.5 text-[12px] ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised/50"}`}
    >
      <button type="button" onClick={() => browser().activate(tab.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={tab.url}>
        {tab.agent ? (
          <Bot size={12} className={`shrink-0 ${agentRunning ? "pulse-dot text-accent" : "text-faint"}`} />
        ) : (
          <Globe size={12} className={`shrink-0 text-faint ${tab.loading ? "pulse-dot" : ""}`} />
        )}
        <span className="truncate">{label}</span>
      </button>
      <button type="button" title="Close tab" onClick={() => browser().closeTab(tab.id)} className="rounded p-0.5 text-faint opacity-0 hover:text-fg group-hover:opacity-100">
        <X size={12} />
      </button>
    </div>
  );
}

function AddressBar({ tab, onSuggesting }: { tab: BrowserTab; onSuggesting: (open: boolean) => void }) {
  const [value, setValue] = useState(tab.url);
  const [focused, setFocused] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState(-1);

  useEffect(() => {
    if (!focused) setValue(tab.url === "about:blank" ? "" : tab.url);
  }, [tab.url, focused]);

  const suggestions = useMemo(
    () => (focused && value.trim() && value !== tab.url ? fuzzyFilter(history, value, (h) => `${h.url} ${h.title}`, 8) : []),
    [focused, value, history, tab.url],
  );
  const open = suggestions.length > 0;
  useEffect(() => onSuggesting(open), [open, onSuggesting]);

  const go = (input: string) => {
    browser().navigate(tab.id, input);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="relative mx-1 min-w-0 flex-1">
      <input
        value={value}
        spellCheck={false}
        placeholder="Search or enter address"
        onChange={(event) => {
          setValue(event.target.value);
          setSelected(-1);
        }}
        onFocus={(event) => {
          setFocused(true);
          event.target.select();
          void browser()
            .history()
            .then(setHistory);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && open) {
            event.preventDefault();
            setSelected((i) => Math.min(suggestions.length - 1, i + 1));
          } else if (event.key === "ArrowUp" && open) {
            event.preventDefault();
            setSelected((i) => Math.max(-1, i - 1));
          } else if (event.key === "Enter") {
            go(suggestions[selected]?.url ?? value);
          } else if (event.key === "Escape") {
            setValue(tab.url);
            event.currentTarget.blur();
          }
        }}
        className="selectable h-7 w-full rounded-lg bg-sunken px-3 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:ring-1 focus:ring-accent/50"
      />
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-xl border border-line-strong bg-panel p-1 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]">
          {suggestions.map((entry, index) => (
            <button
              key={entry.url}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                go(entry.url);
              }}
              className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left ${index === selected ? "bg-raised" : "hover:bg-raised/60"}`}
            >
              <span className="truncate text-[12.5px] text-fg">{entry.title || entry.url}</span>
              <span className="truncate font-mono text-[11px] text-faint">{entry.url}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StartPage() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    void browser()
      .history()
      .then(setHistory);
  }, []);
  const local = history.filter((h) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(h.url)).slice(0, 6);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Globe size={22} className="text-faint" />
      <div className="text-[13px] text-muted">Open a tab, or ask pi to open your dev server.</div>
      <button type="button" onClick={() => browser().newTab()} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg hover:bg-raised">
        New tab
      </button>
      {local.length > 0 && (
        <div className="flex flex-col gap-1">
          {local.map((entry) => (
            <button key={entry.url} type="button" onClick={() => browser().newTab(entry.url)} className="font-mono text-[12px] text-accent hover:underline">
              {entry.url}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconButton({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded-md p-1.5 disabled:opacity-30 ${active ? "bg-accent-soft text-accent" : "text-muted enabled:hover:bg-raised enabled:hover:text-fg"}`}
    >
      {children}
    </button>
  );
}
