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
  ChevronDown,
  ChevronRight,
  Folder,
  FileText,
  Files,
  Angry,
  GitPullRequest,
  Network,
  LayoutGrid,
  MousePointerClick,
  Settings,
  type IconComponent,
} from "./icons";
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserTab, HistoryEntry } from "../../../shared/browser";
import { kindFor, parseLocalTarget, type TabPreview } from "../../../shared/preview";
import { DEVICE_PRESETS, fitViewport, type ViewportRequest, type ViewportSpec } from "../../../shared/viewport";
import { entriesBelow, folderEntries, parentDir, type TreeEntry } from "../lib/file-tree";
import { type FuzzySearch, fuzzyFilter, fuzzySearch } from "../lib/fuzzy";
import { FILES_EVENT, takeFilesPending } from "../lib/file-finder";
import { iconForKind, openFileDialog, openPreviewPath } from "../lib/preview";
import { openSettings, setPane, showPage, store, toast, useApp } from "../state/app";
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
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  const [suggesting, setSuggesting] = useState(false);
  const { open: openMenu, menu } = useContextMenu();
  const viewport = useRef<HTMLDivElement>(null);
  const [dimensionsOpen, setDimensionsOpen] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  // An active viewport keeps the row visible so an agent-set one can never be hidden.
  const showDimensions = Boolean(active) && (dimensionsOpen || Boolean(active?.viewport));
  const inWindow = active?.surface === "window";
  // Card and start tabs are drawn by the renderer: their page stays hidden.
  const drawn = pane.open && Boolean(active) && !active?.card && !active?.start && !inWindow;
  // Native views draw above the DOM, so hide the page while a DOM overlay must cover it, but only once a still of it is
  // on screen in its place: a menu over the page must not blank it out.
  const covered = Boolean(lightbox) || suggesting || overlay;
  const [still, setStill] = useState<{ tab: string; src?: string }>();
  const stillShown = drawn && still !== undefined && still.tab === active?.id;
  const visible = drawn && !(covered && stillShown);

  useEffect(() => {
    if (!covered || !drawn || !active) return;
    const tab = active.id;
    let live = true;
    const show = (src?: string | null) => live && setStill({ tab, src: src ?? undefined });
    void browser().still().then(show, () => show());
    return () => {
      live = false;
    };
  }, [covered, drawn, active?.id]);

  // The still stays under the view a moment after the cover goes, until main has put the view back over it.
  useEffect(() => {
    if (covered) return;
    const timer = setTimeout(() => setStill(undefined), 200);
    return () => clearTimeout(timer);
  }, [covered]);

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
        {/* no-drag: wheel events skip window-drag regions, so the gaps between pills would stall a scroll mid-strip.
            The strip only grows to its tabs; the spacer after it keeps the empty titlebar draggable. */}
        <div className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto">
          {state.tabs.map((tab) => (
            <TabPill
              key={tab.id}
              tab={tab}
              active={tab.id === state.activeId}
              onContextMenu={(event) => openMenu(event, tabMenu(tab, state.tabs))}
            />
          ))}
          <IconButton
            title="New tab: an address, a file or a recent dev server (right-click: Open file…)"
            onClick={() => browser().newTab()}
            onContextMenu={(event) => openMenu(event, [[{ label: "New tab", onSelect: () => browser().newTab() }, { label: "Open file…", icon: <FolderOpen size={13} />, onSelect: () => void openFileDialog() }]])}
          >
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="flex-1 self-stretch" />
        {active?.preview && active.preview.modes.length > 1 && <PreviewModes tab={active} />}
        {active?.preview && commentable(active.preview) && (
          <IconButton title={state.annotating ? "Stop commenting (Esc in page)" : "Comment on elements"} active={state.annotating} onClick={() => browser().annotate(!state.annotating)}>
            <MessageSquarePlus size={14} />
          </IconButton>
        )}
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
          {!active.start && <>
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
          </>}
        </div>
      )}

      {active && !active.preview && !active.card && !active.start && showDimensions && <DimensionsBar key={active.id} tab={active} stage={stage} />}

      <div ref={viewport} className="relative min-h-0 flex-1 bg-sunken">
        {(!active || active.start) && <StartPage key={active?.id} tab={active} />}
        {active && inWindow && <WindowPlaceholder tab={active} />}
        {active?.card && <CardView tab={active} card={active.card} />}
        {stillShown && still.src ? (
          <img src={still.src} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        ) : (
          active && !active.card && !active.start && !inWindow && !visible && <div className="grid h-full place-items-center text-[12px] text-faint">{active.title || active.url}</div>
        )}
        {active?.viewport && visible && <DeviceFrame spec={active.viewport} stage={stage} />}
      </div>
      {state.annotating && (
        <div className="shrink-0 border-t border-accent/30 bg-accent-soft px-3 py-1.5 text-[12px] text-fg">
          Click an element to comment on it: Add keeps it for your next message, Send (⌘⏎) sends it now. Esc stops.
        </div>
      )}
      {menu}
    </div>
  );
}

/** Previews whose page is worth commenting on element by element: rendered Markdown and HTML. */
const commentable = (preview: TabPreview) => preview.mode === "rendered" && (preview.kind === "markdown" || preview.kind === "html");

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
  const close = [
    { label: "Close tab", icon: <X size={13} />, onSelect: () => browser().closeTab(tab.id) },
    ...(tabs.length > 1
      ? [{ label: "Close other tabs", onSelect: () => tabs.forEach((other) => other.id !== tab.id && browser().closeTab(other.id)) }]
      : []),
  ];
  // A start tab has no page yet: nothing to reload, copy or pop out.
  if (tab.start) return [close];
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
    close,
  ];
}

function TabPill({ tab, active, onContextMenu }: { tab: BrowserTab; active: boolean; onContextMenu: (event: React.MouseEvent) => void }) {
  // Whether the tab's agent runs, not its chat: the pane does not render for every streaming frame.
  const agentRunning = useApp((s) => Boolean(tab.agent && s.sessions[tab.agent]?.running));
  const card = useApp((s) => (tab.card ? s.board.cards.find((entry) => entry.id === tab.card) : undefined));
  const label = tab.card ? (card?.title ?? tab.card) : tab.start ? "New tab" : tab.url === "about:blank" && (!tab.title || tab.title === tab.url) ? "New page" : (tab.preview?.name ?? (tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab"));
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
        ) : tab.start ? (
          <Plus size={12} className="shrink-0 text-faint" />
        ) : tab.agent && (agentRunning || !tab.favicon) ? (
          <Bot size={12} className={`shrink-0 ${agentRunning ? "pulse-dot text-accent" : "text-faint"}`} />
        ) : FileIcon ? (
          <FileIcon size={12} className="shrink-0 text-faint" />
        ) : tab.favicon ? (
          <img src={tab.favicon} alt="" draggable={false} className={`size-3.5 shrink-0 rounded-[3px] object-contain ${tab.loading ? "opacity-60" : ""}`} />
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
  const input = useRef<HTMLInputElement>(null);

  // A new tab starts with the cursor in the address bar, unless its file finder (⌘P) already took it.
  useEffect(() => {
    if ((tab.start || !tab.url || tab.url === "about:blank") && !document.activeElement?.closest("[data-finder]")) input.current?.focus();
  }, [tab.id, tab.start]);

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
    if (target) void openPreviewPath(target.path, { line: target.line, into: tab.start ? tab.id : undefined });
    else browser().navigate(tab.id, input);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="relative mx-1 min-w-0 flex-1">
      <input
        ref={input}
        value={value}
        spellCheck={false}
        placeholder={tab.start ? "Enter an address or a file path" : "Search or enter address"}
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
        className="selectable h-7 w-full rounded-full bg-sunken px-3.5 font-mono text-[12px] text-fg outline-none placeholder:text-faint focus:ring-1 focus:ring-accent/50"
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

/** A shortcut as the menu shows it, in a pill. */
function Keys({ keys }: { keys: string }) {
  return <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 font-medium text-[11px] text-muted tracking-wider">{keys}</span>;
}

function Tool({ icon: Icon, label, keys, onClick, children }: { icon: IconComponent; label: string; keys?: string; onClick: () => void; children?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex h-11 min-w-0 items-center gap-3 rounded-xl bg-raised/50 px-3.5 text-left text-[13px] text-fg hover:bg-raised">
      <Icon size={16} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && <Keys keys={keys} />}
      {children}
    </button>
  );
}

/**
 * The launcher of a start tab (`tab`), or of an empty pane (no tab), after the Codex app's new tab: a grid of tools
 * (find a project file, open a file, a blank page, the app's pages) and suggestions (recent dev servers). From a start
 * tab every choice fills that tab; from the empty pane it opens one.
 */
function StartPage({ tab }: { tab?: BrowserTab }) {
  const [files, setFiles] = useState(takeFilesPending);
  useEffect(() => {
    const show = () => {
      takeFilesPending();
      setFiles(true);
    };
    window.addEventListener(FILES_EVENT, show);
    return () => window.removeEventListener(FILES_EVENT, show);
  }, []);
  return files ? <FileFinder tab={tab} onBack={() => setFiles(false)} /> : <Tools tab={tab} onFiles={() => setFiles(true)} />;
}

function Tools({ tab, onFiles }: { tab?: BrowserTab; onFiles: () => void }) {
  const features = useApp((s) => s.settings.features);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  useEffect(() => {
    void browser()
      .history()
      .then(setHistory);
  }, []);
  const local = history.filter((h) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(h.url)).slice(0, 6);
  const openUrl = (url: string) => (tab ? browser().navigate(tab.id, url) : browser().newTab(url));
  const pages = [
    features.kanban && { icon: SquareKanban, label: "Kanban", keys: "⇧⌘K", onClick: () => showPage("kanban") },
    features.github && { icon: GitPullRequest, label: "GitHub", keys: "⇧⌘G", onClick: () => showPage("github") },
    features.laments && { icon: Angry, label: "Laments", keys: "⇧⌘L", onClick: () => showPage("laments") },
    features.atp && { icon: Network, label: "ATP", keys: "⇧⌘A", onClick: () => showPage("atp") },
    { icon: MousePointerClick, label: "Computer Use", keys: "⇧⌘U", onClick: () => openSettings("computer") },
    { icon: Settings, label: "Settings", keys: "⌘,", onClick: () => openSettings() },
  ].filter((page) => page !== false);
  // Two pages fill the first rows beside the file tools; the rest wait behind More tools.
  const [first, rest] = [pages.slice(0, 2), pages.slice(2)];
  return (
    <div className="h-full overflow-y-auto px-6 py-7">
      <div className="flex max-w-3xl flex-col gap-7">
        <section className="flex flex-col gap-3">
          <h2 className="text-[13.5px] font-medium text-fg">Tools</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
            <Tool icon={Files} label="Files" keys="⌘P" onClick={onFiles} />
            {first.map((page) => <Tool key={page.label} {...page} />)}
            <Tool icon={FolderOpen} label="Open file…" keys="⌘O" onClick={() => void openFileDialog(tab?.id)} />
            <Tool icon={FileText} label="New page" onClick={() => openUrl("about:blank")} />
            {rest.length > 0 && (
              <Tool icon={LayoutGrid} label="More tools…" onClick={() => setMore((open) => !open)}>
                <ChevronDown size={15} className={`shrink-0 text-muted transition-transform ${more ? "rotate-180" : ""}`} />
              </Tool>
            )}
            {more && rest.map((page) => <Tool key={page.label} {...page} />)}
          </div>
        </section>
        {local.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="mb-2 text-[13.5px] font-medium text-fg">Suggested</h2>
            {local.map((entry) => (
              <button key={entry.url} type="button" onClick={() => openUrl(entry.url)} className="flex h-9 items-center gap-3 rounded-lg px-3 text-left hover:bg-raised/60">
                <Globe size={15} className="shrink-0 text-muted" />
                <span className="truncate text-[13px] text-fg">{entry.title || entry.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
                {entry.title && <span className="ml-auto shrink-0 font-mono text-[11.5px] text-faint">{entry.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>}
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** Rows a folder shows before the rest wait for a search. */
const FOLDER_LIMIT = 500;

/**
 * A picker over the project files of the chat: it browses folders (Enter or a click opens one, Backspace in an empty
 * search goes up, the path above jumps back), and typing searches the files and folders below the current one.
 * Picking a file previews it.
 */
function FileFinder({ tab, onBack }: { tab?: BrowserTab; onBack: () => void }) {
  const cwd = useApp((s) => (s.active ? s.sessions[s.active]?.cwd : undefined));
  const [all, setAll] = useState<string[] | undefined>();
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAll(undefined);
    setDir("");
    if (cwd) void window.studio.listFiles(cwd).then(setAll, () => setAll([]));
  }, [cwd]);
  // Up to 50k paths below the folder: one searcher for them, built on the first search, and a keystroke paints before
  // its results do (clearing the search shows the folder at once).
  const deferred = useDeferredValue(query.trim());
  const typed = query.trim() && deferred;
  const searching = typed !== "";
  const prefix = dir ? `${dir}/` : "";
  const search = useMemo(() => {
    let searcher: FuzzySearch<TreeEntry> | undefined;
    return (q: string) => (searcher ??= fuzzySearch(entriesBelow(all ?? [], dir), (entry) => entry.path.slice(dir ? dir.length + 1 : 0)))(q, 50);
  }, [all, dir]);
  const entries = useMemo(() => {
    if (!all) return [];
    if (!typed) return folderEntries(all, dir).slice(0, FOLDER_LIMIT);
    return search(typed);
  }, [all, dir, search, typed]);
  useEffect(() => setSelected(0), [typed, dir]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const enter = (folder: string) => {
    setDir(folder);
    setQuery("");
  };
  const pick = (entry: TreeEntry) => (entry.folder ? enter(entry.path) : cwd && void openPreviewPath(`${cwd}/${entry.path}`, { into: tab?.id }));
  const crumbs = dir ? dir.split("/") : [];
  const project = cwd ? cwd.slice(cwd.lastIndexOf("/") + 1) || cwd : "";
  return (
    <div data-finder className="flex h-full flex-col px-6 py-5">
      <div className="flex shrink-0 items-center gap-2 rounded-xl bg-raised/50 px-2 ring-1 ring-line focus-within:ring-accent/50">
        <button type="button" title="Back to tools" onClick={onBack} className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg">
          <ArrowLeft size={15} />
        </button>
        <input
          autoFocus
          value={query}
          spellCheck={false}
          placeholder={cwd ? (dir ? `Search in ${dir}` : "Search files and folders") : "Open a chat in a project to browse its files"}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((i) => Math.min(entries.length - 1, i + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((i) => Math.max(0, i - 1));
            } else if (event.key === "Enter" && entries[selected]) pick(entries[selected]);
            else if (event.key === "Backspace" && !query && dir) {
              event.preventDefault();
              setDir(parentDir);
            } else if (event.key === "Escape") {
              if (query) setQuery("");
              else onBack();
            }
          }}
          className="selectable h-10 min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
        />
        <Keys keys="⌘P" />
      </div>
      {cwd && (
        <nav data-crumbs className="mt-2 flex shrink-0 flex-wrap items-center gap-0.5 px-1 text-[12.5px]">
          {[project, ...crumbs].map((name, index) => {
            const path = crumbs.slice(0, index).join("/");
            const current = index === crumbs.length;
            return (
              <span key={path || "/"} className="flex items-center gap-0.5">
                {index > 0 && <ChevronRight size={12} className="text-faint" />}
                <button
                  type="button"
                  disabled={current}
                  onClick={() => enter(path)}
                  className={`rounded-md px-1.5 py-0.5 ${current ? "text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
                >
                  {name}
                </button>
              </span>
            );
          })}
        </nav>
      )}
      <div ref={list} className="mt-1 min-h-0 flex-1 overflow-y-auto">
        {all === undefined && cwd && <div className="px-3 py-2 text-[12.5px] text-faint">Listing files…</div>}
        {all && entries.length === 0 && <div className="px-3 py-2 text-[12.5px] text-faint">{searching ? "Nothing matches." : "This folder is empty."}</div>}
        {entries.map((entry, index) => {
          const Icon = entry.folder ? Folder : iconForKind(kindFor(entry.path));
          const relative = entry.path.slice(prefix.length);
          const slash = relative.lastIndexOf("/");
          return (
            <button
              key={entry.path}
              type="button"
              data-index={index}
              title={entry.path}
              onClick={() => pick(entry)}
              onMouseMove={() => setSelected(index)}
              className={`flex h-8 w-full items-center gap-3 rounded-lg px-3 text-left ${index === selected ? "bg-raised" : ""}`}
            >
              <Icon size={14} className={`shrink-0 ${entry.folder ? "text-accent" : "text-muted"}`} />
              <span className="shrink-0 text-[13px] text-fg">{relative.slice(slash + 1)}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{slash > 0 ? relative.slice(0, slash) : ""}</span>
              {entry.folder && <ChevronRight size={13} className="shrink-0 text-faint" />}
            </button>
          );
        })}
      </div>
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
