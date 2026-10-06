// The integrated browser: tab strip and toolbar in the DOM, the page itself is a native
// WebContentsView that main draws over the viewport element we report.
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Code2,
  Copy,
  FolderOpen,
  Globe,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MonitorSmartphone,
  PanelTop,
  Plus,
  ExternalLink,
  AppWindow,
  RotateCw,
  RotateCcw,
  SquareArrowOutUpRight,
  Smartphone,
  X,
  SquareKanban,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserTab, HistoryEntry } from "../../../shared/browser";
import { parseLocalTarget, type TabPreview } from "../../../shared/preview";
import { DEVICE_PRESETS, fitViewport, type ViewportRequest, type ViewportSpec } from "../../../shared/viewport";
import { fuzzyFilter } from "../lib/fuzzy";
import { iconForKind, openFileDialog, openPreviewPath } from "../lib/preview";
import { setPane, store, toast, useApp } from "../state/app";
import { type MenuItem, useContextMenu } from "./ContextMenu";
import { CardTab } from "./CardDialog";
import { COLLAPSED_INSET } from "./Sidebar";

const browser = () => window.studio.browser;

const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

export function BrowserPane() {
  const state = useApp((s) => s.browser);
  const pane = useApp((s) => s.pane);
  const lightbox = useApp((s) => s.lightbox);
  const overlay = useApp((s) => s.overlay);
  const sidebar = useApp((s) => s.sidebar);
  const sessions = useApp((s) => s.sessions);
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  const [suggesting, setSuggesting] = useState(false);
  const { open: openMenu, menu } = useContextMenu();
  const viewport = useRef<HTMLDivElement>(null);
  const [dimensionsOpen, setDimensionsOpen] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  // An active viewport keeps the row visible so an agent-set one can never be hidden.
  const showDimensions = Boolean(active) && (dimensionsOpen || Boolean(active?.viewport));
  // Native views draw above the DOM, so hide the page while a DOM overlay must cover it.
  const inWindow = active?.surface === "window";
  // A card tab is drawn by the renderer: its page stays hidden.
  const visible = pane.open && Boolean(active) && !active?.card && !inWindow && !lightbox && !suggesting && !overlay;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const report = () => {
      const r = element.getBoundingClientRect();
      setStage({ width: r.width, height: r.height });
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
    // The native page view follows the viewport; the sidebar moving it must re-report its position.
  }, [visible, pane.full, pane.split, sidebar.width, sidebar.collapsed]);

  useEffect(() => () => browser().layout({ visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }), []);

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-canvas"
      // The native page covers the viewport while visible, so drops only land on the strip, toolbar and start page.
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        for (const file of event.dataTransfer.files) {
          const path = window.studio.pathForFile(file);
          if (path) void openPreviewPath(path, { newTab: true });
        }
      }}
    >
      <div
        className="drag dashed-b titlebar flex shrink-0 items-center gap-1 overflow-hidden px-2"
        style={sidebar.collapsed && pane.full ? { paddingLeft: COLLAPSED_INSET } : undefined}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {state.tabs.map((tab) => (
            <TabPill
              key={tab.id}
              tab={tab}
              active={tab.id === state.activeId}
              agentRunning={Boolean(tab.agent && sessions[tab.agent]?.running)}
              onContextMenu={(event) => openMenu(event, tabMenu(tab, state.tabs))}
            />
          ))}
          <IconButton
            title="New tab (right-click: Open file…)"
            onClick={() => browser().newTab()}
            onContextMenu={(event) => openMenu(event, [[{ label: "New tab", onSelect: () => browser().newTab() }, { label: "Open file…", icon: <FolderOpen size={13} />, onSelect: () => void openFileDialog() }]])}
          >
            <Plus size={14} />
          </IconButton>
        </div>
        {active?.preview && active.preview.modes.length > 1 && <PreviewModes tab={active} />}
        <IconButton title={pane.full ? "Split view" : "Full view"} onClick={() => setPane({ full: !pane.full })}>
          {pane.full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton title="Close browser (⌘B)" onClick={() => setPane({ open: false, full: false })}>
          <X size={15} />
        </IconButton>
      </div>

      {active && !active.preview && !active.card && (
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
          <IconButton
            title={active.viewport ? "Responsive mode is on (Reset to close)" : "Dimensions"}
            active={showDimensions}
            onClick={() => !active.viewport && setDimensionsOpen((v) => !v)}
          >
            <MonitorSmartphone size={15} />
          </IconButton>
          {inWindow ? (
            <IconButton title="Return to pane" onClick={() => void browser().returnToPane(active.id).catch(() => {})}>
              <PanelTop size={15} />
            </IconButton>
          ) : (
            <IconButton title="Pop out into window" onClick={() => void browser().popOut(active.id).catch(() => {})}>
              <AppWindow size={15} />
            </IconButton>
          )}
          <IconButton title="Inspect" onClick={() => browser().inspect(active.id)}>
            <Code2 size={15} />
          </IconButton>
          <IconButton title="Open in default browser" onClick={() => window.studio.openExternal(active.url)}>
            <SquareArrowOutUpRight size={14} />
          </IconButton>
        </div>
      )}

      {active && !active.preview && !active.card && showDimensions && <DimensionsBar key={active.id} tab={active} stage={stage} />}

      <div ref={viewport} className="relative min-h-0 flex-1 bg-sunken">
        {!active && <StartPage />}
        {active && inWindow && <WindowPlaceholder tab={active} />}
        {active?.card && <CardView tab={active} card={active.card} />}
        {active && !active.card && !inWindow && !visible && <div className="grid h-full place-items-center text-[12px] text-faint">{active.title || active.url}</div>}
        {active?.viewport && visible && <DeviceFrame spec={active.viewport} stage={stage} />}
      </div>
      {state.annotating && (
        <div className="shrink-0 border-t border-accent/30 bg-accent-soft px-3 py-1.5 text-[12px] text-fg">
          Click an element in the page to comment on it. Comments are attached to your next prompt. Esc stops.
        </div>
      )}
      {menu}
    </div>
  );
}

/**
 * Rendered/Raw switch of the active preview, in the tab strip. A preview has no toolbar row of its own: the viewer's bar is
 * the only header, and the file actions (Copy path, Reveal, Open with default app, Reload, Pop out, Inspect) are in the
 * tab's context menu.
 */
function PreviewModes({ tab }: { tab: BrowserTab }) {
  const preview = tab.preview as TabPreview;
  return (
    <div className="mr-1 flex shrink-0 rounded-md bg-sunken p-0.5 text-[11.5px]">
      {preview.modes.map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => void browser().previewMode(tab.id, mode)}
          className={`rounded px-2 py-0.5 capitalize ${preview.mode === mode ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function WindowPlaceholder({ tab }: { tab: BrowserTab }) {
  const spec = tab.viewport;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <AppWindow size={22} className="text-faint" />
      <div className="text-[13px] text-muted">
        Open in a separate window{spec ? `: ${spec.width}x${spec.height} @${spec.dpr}x` : ""}
      </div>
      <div className="max-w-full truncate font-mono text-[11.5px] text-faint">{tab.title || tab.url}</div>
      <div className="flex gap-2">
        <button type="button" onClick={() => browser().activate(tab.id)} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg hover:bg-raised">
          Focus
        </button>
        <button type="button" onClick={() => void browser().returnToPane(tab.id).catch(() => {})} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg hover:bg-raised">
          Return to pane
        </button>
      </div>
    </div>
  );
}

function tabMenu(tab: BrowserTab, tabs: BrowserTab[]): MenuItem[][] {
  const preview = tab.preview;
  return [
    preview
      ? [
          { label: "Copy path", icon: <Copy size={13} />, onSelect: () => void navigator.clipboard.writeText(preview.path) },
          { label: "Reveal in Finder", icon: <FolderOpen size={13} />, onSelect: () => void browser().previewReveal(tab.id).catch(() => {}) },
          { label: "Open with default app", icon: <ExternalLink size={13} />, onSelect: () => void browser().previewOpen(tab.id).catch((e) => toast(String(e.message ?? e), "error")) },
          { label: "Reload", icon: <RotateCw size={13} />, onSelect: () => browser().command(tab.id, "reload") },
        ]
      :
    [
      { label: "Reload", icon: <RotateCw size={13} />, onSelect: () => browser().command(tab.id, "reload") },
      ...(tab.url && tab.url !== "about:blank"
        ? [{ label: "Copy address", icon: <Copy size={13} />, onSelect: () => void navigator.clipboard.writeText(tab.url) }]
        : []),
      ...(/^https?:/i.test(tab.url)
        ? [{ label: "Open in default browser", icon: <SquareArrowOutUpRight size={13} />, onSelect: () => window.studio.openExternal(tab.url) }]
        : []),
    ],
    [
      tab.surface === "window"
        ? { label: "Return to pane", icon: <PanelTop size={13} />, onSelect: () => void browser().returnToPane(tab.id).catch(() => {}) }
        : { label: "Pop out into window", icon: <AppWindow size={13} />, onSelect: () => void browser().popOut(tab.id).catch(() => {}) },
      ...(tab.surface === "window" ? [{ label: "Close window", icon: <X size={13} />, onSelect: () => browser().closeTab(tab.id) }] : []),
      // Web tabs have Inspect in their toolbar; previews have no toolbar row.
      ...(preview ? [{ label: "Inspect", icon: <Code2 size={13} />, onSelect: () => browser().inspect(tab.id) }] : []),
    ],
    [
      { label: "Close tab", icon: <X size={13} />, onSelect: () => browser().closeTab(tab.id) },
      ...(tabs.length > 1
        ? [{ label: "Close other tabs", onSelect: () => tabs.forEach((other) => other.id !== tab.id && browser().closeTab(other.id)) }]
        : []),
    ],
  ];
}

function TabPill({
  tab,
  active,
  agentRunning,
  onContextMenu,
}: {
  tab: BrowserTab;
  active: boolean;
  agentRunning: boolean;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const card = useApp((s) => (tab.card ? s.board.cards.find((entry) => entry.id === tab.card) : undefined));
  const label = tab.card ? (card?.title ?? tab.card) : (tab.preview?.name ?? (tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab"));
  const FileIcon = tab.preview ? iconForKind(tab.preview.kind) : undefined;
  return (
    <div
      onContextMenu={onContextMenu}
      className={`group flex h-8 max-w-48 min-w-24 shrink-0 items-center gap-1.5 rounded-lg pr-1 pl-2.5 text-[12px] ${active ? "bg-raised text-fg" : "text-muted hover:bg-raised/50"}`}
    >
      <button type="button" onClick={() => browser().activate(tab.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={tab.card ? `Card ${tab.card}` : (tab.preview?.path ?? tab.url)}>
        {tab.surface === "window" ? (
          <AppWindow size={12} className="shrink-0 text-accent" />
        ) : tab.card ? (
          <SquareKanban size={12} className="shrink-0 text-faint" />
        ) : tab.agent ? (
          <Bot size={12} className={`shrink-0 ${agentRunning ? "pulse-dot text-accent" : "text-faint"}`} />
        ) : FileIcon ? (
          <FileIcon size={12} className="shrink-0 text-faint" />
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

/** A Kanban card in a tab: its details beside the chat, from the board the renderer already holds. */
function CardView({ tab, card: id }: { tab: BrowserTab; card: string }) {
  const card = useApp((s) => s.board.cards.find((entry) => entry.id === id));
  const active = useApp((s) => s.active);
  if (!card) return <div className="grid h-full place-items-center text-[12px] text-faint">Card not found: {id}</div>;
  return <CardTab key={card.id} card={card} chat={tab.agent ?? active} onClose={() => browser().closeTab(tab.id)} />;
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
    const target = parseLocalTarget(input, store.get().sessions[store.get().active ?? ""]?.cwd, window.studio.homeDir);
    if (target) void openPreviewPath(target.path, { line: target.line });
    else browser().navigate(tab.id, input);
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
      <button type="button" onClick={() => void openFileDialog()} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg hover:bg-raised">
        Open file…
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
  onContextMenu,
  children,
}: {
  title: string;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
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
      onContextMenu={onContextMenu}
      className={`shrink-0 rounded-md p-1.5 disabled:opacity-30 ${active ? "bg-accent-soft text-accent" : "text-muted enabled:hover:bg-raised enabled:hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

const field = "h-6 rounded-md bg-sunken px-1.5 font-mono text-[11.5px] text-fg outline-none focus:ring-1 focus:ring-accent/50";

// Draws under the native view, which main places at fitViewport's bounds; the same function keeps both in agreement.
function DeviceFrame({ spec, stage }: { spec: ViewportSpec; stage: { width: number; height: number } }) {
  if (stage.width <= 0 || stage.height <= 0) return null;
  const { bounds } = fitViewport(stage, spec);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute rounded-[3px] ring-1 ring-line-strong"
        style={{ left: bounds.x - 1, top: bounds.y - 1, width: bounds.width + 2, height: bounds.height + 2 }}
      />
      {bounds.y >= 16 && (
        <div className="absolute text-center font-mono text-[10px] leading-4 text-faint" style={{ left: bounds.x, width: bounds.width, top: bounds.y - 16 }}>
          {spec.width}
        </div>
      )}
      {bounds.x >= 34 && (
        <div className="absolute -rotate-90 text-center font-mono text-[10px] leading-4 text-faint" style={{ left: bounds.x - 25, top: bounds.y + bounds.height / 2 - 8, width: 32 }}>
          {spec.height}
        </div>
      )}
    </div>
  );
}

function NumberField({ value, onCommit, title, step }: { value: number; onCommit: (n: number) => void; title: string; step?: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0 && n !== value) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <input
      type="number"
      title={title}
      value={draft}
      step={step}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      className={`${field} w-14`}
    />
  );
}

function DimensionsBar({ tab, stage }: { tab: BrowserTab; stage: { width: number; height: number } }) {
  const spec = tab.viewport;
  const apply = (request: ViewportRequest) => void browser().viewport(tab.id, { ...request, source: "user" }).catch(() => {});
  const size = spec ?? { width: Math.round(stage.width) || 1280, height: Math.round(stage.height) || 800, dpr: 1, mobile: false };
  // Carries the device's UA profile, so rotating an iPhone or changing a Pixel's DPR keeps its user agent.
  const current = { width: size.width, height: size.height, dpr: size.dpr, mobile: size.mobile, userAgent: spec?.userAgent };
  const preset = spec ? (DEVICE_PRESETS.find((p) => p.label === spec.label)?.id ?? "custom") : "responsive";
  // Picking Custom only opens the number field; the DPR changes when that field commits.
  const [customDpr, setCustomDpr] = useState(false);
  // A DPR set from elsewhere (Reset, a preset, the agent) closes a Custom pick that never committed.
  useEffect(() => setCustomDpr(false), [spec?.dpr, spec === undefined]);
  const dprPreset = customDpr || ![1, 2, 3].includes(size.dpr) ? "custom" : String(size.dpr);
  const scale = spec ? fitViewport(stage, spec).scale : 1;
  const zoom = scale < 1 ? `Fit ${Math.round(scale * 100)}%` : "100%";

  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1 text-[11.5px] text-muted">
      <Smartphone size={13} className="text-faint" />
      <select
        title="Device preset"
        value={preset}
        onChange={(event) => {
          const v = event.target.value;
          if (v === "responsive") void browser().viewport(tab.id, null);
          else if (v === "custom") apply(current);
          else apply({ preset: v });
        }}
        className={field}
      >
        <option value="responsive">Responsive</option>
        {DEVICE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom</option>
      </select>
      <NumberField title="Width (CSS px)" value={size.width} onCommit={(width) => apply({ ...current, width })} />
      <span className="text-faint">×</span>
      <NumberField title="Height (CSS px)" value={size.height} onCommit={(height) => apply({ ...current, height })} />
      <select
        title="Device pixel ratio"
        value={dprPreset}
        onChange={(event) => {
          const v = event.target.value;
          setCustomDpr(v === "custom");
          if (v !== "custom") apply({ ...current, dpr: Number(v) });
        }}
        className={field}
      >
        {[1, 2, 3].map((d) => (
          <option key={d} value={d}>
            {d}x
          </option>
        ))}
        <option value="custom">Custom</option>
      </select>
      {dprPreset === "custom" && <NumberField title="Custom DPR" step={0.25} value={size.dpr} onCommit={(dpr) => apply({ ...current, dpr })} />}
      <IconButton title="Rotate" onClick={() => apply({ ...current, width: size.height, height: size.width })}>
        <RotateCcw size={13} />
      </IconButton>
      <IconButton title={size.mobile ? "Mobile and touch (on)" : "Mobile and touch (off)"} active={size.mobile} onClick={() => apply({ ...current, mobile: !size.mobile })}>
        <Smartphone size={13} />
      </IconButton>
      {/* The fit is the pane's; a window tab is scaled to its own window, which the renderer cannot measure. */}
      {spec && tab.surface !== "window" && <span className="font-mono text-[11px] text-faint">{zoom}</span>}
      {spec?.source === "agent" && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent">Set by pi</span>}
      <span className="flex-1" />
      {spec && (
        <button type="button" onClick={() => void browser().viewport(tab.id, null)} className="rounded-md px-2 py-0.5 text-fg hover:bg-raised">
          Reset
        </button>
      )}
    </div>
  );
}
