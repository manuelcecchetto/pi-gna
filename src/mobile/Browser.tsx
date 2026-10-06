// The phone's browser screen: the Mac's browser tabs, streamed (`GET /api/browser/view/<tab>`, an <img> on a multipart
// stream) and driven with `browser.input`. The page runs on the Mac, with the window hidden or the pane closed. A tap is a
// click, a drag scrolls the page, two fingers zoom the picture locally (the page does not change), a long press is a right
// click. Comment mode turns a tap into an annotation that rides with this phone's next prompt (`chat.send`).
import { AppWindow, ArrowLeft, ArrowRight, Bot, File, Keyboard, MessageSquarePlus, Plus, RotateCw, Smartphone, X, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../renderer/src/lib/store";
import type { Annotation, BrowserTab, HistoryEntry } from "../shared/browser";
import type { BrowserInput } from "../shared/host-api";
import { DEVICE_PRESETS } from "../shared/viewport";
import { annotations, useAnnotations } from "./annotations";
import { agentActive, type Box, classify, isWindowTab, KEYS, LONG_PRESS_MS, pageSize, suggestions, tabAddress, tabTitle, toPagePoint, viewportLabel, wheelDelta } from "./browser-data";
import type { HostClient } from "./client/host-client";
import { clampView, distance, FIT, midpoint, type View, zoomAt } from "./pinch";
import { Header } from "./Screens";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const round = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);
/** A host call whose failure is a toast. */
type Call = (method: string, args: unknown) => Promise<unknown>;
const chip = "flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[13px]";

/** Re-renders every second while `active`, so "agent is using this" fades without an event. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

export function AnnotationChips({ onRemove }: { onRemove?: (id: string) => void }) {
  const list = useAnnotations();
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" data-testid="annotation-chips">
      {list.map((a) => (
        <span key={a.id} className="flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border border-accent/40 px-2 text-[12.5px] text-muted" data-testid="annotation-chip" title={`${a.label} on ${a.url}`}>
          <MessageSquarePlus size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 truncate">{a.comment}</span>
          <button type="button" aria-label="Remove comment" onClick={() => (onRemove ?? annotations.remove)(a.id)} className="grid h-8 w-6 shrink-0 place-items-center">
            <X size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function BrowserScreen({ client, handle, initialTab, back }: { client: HostClient; handle?: string; initialTab?: string; back: () => void }) {
  const state = useStore(client.store, (s) => s.global.browser);
  const [all, setAll] = useState(!handle);
  const allTabs = state?.tabs ?? [];
  const tabs = all ? allTabs : allTabs.filter((t) => t.agent === handle);
  const now = useNow(allTabs.some((t) => t.agentAt !== undefined));
  // The phone keeps its own selection: the Mac ignores activating a tab of a chat it is not showing.
  const [picked, setPicked] = useState(initialTab);
  const tab = tabs.find((t) => t.id === picked) ?? tabs.find((t) => t.id === state?.activeId) ?? tabs.find((t) => agentActive(t, now)) ?? tabs[0];
  const [commenting, setCommenting] = useState(false);
  const [sheet, setSheet] = useState<"viewport" | "keys">();

  const call: Call = (method, args) => (client.call as (m: string, a: unknown) => Promise<unknown>)(method, args).catch((e) => toast(failure(e), "error"));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="browser-screen">
      <Header
        title={all ? "Browser" : "This chat's tabs"}
        subtitle={tab ? viewportLabel(tab) : undefined}
        onBack={back}
        trailing={
          <>
            {handle && (
              <button type="button" aria-pressed={all} data-testid="all-tabs" onClick={() => setAll((on) => !on)} className={`h-11 shrink-0 px-2 text-[13px] ${all ? "text-accent" : "text-muted"}`}>
                All tabs
              </button>
            )}
            <button type="button" aria-label="Comment mode" aria-pressed={commenting} data-testid="comment-mode" disabled={!tab} onClick={() => setCommenting((on) => !on)} className={`grid h-11 w-11 shrink-0 place-items-center disabled:opacity-40 ${commenting ? "text-accent" : "text-muted"}`}>
              <MessageSquarePlus size={20} />
            </button>
            <button type="button" aria-label="Viewport" data-testid="viewport-open" disabled={!tab} onClick={() => setSheet("viewport")} className="grid h-11 w-11 shrink-0 place-items-center text-muted disabled:opacity-40">
              <Smartphone size={20} />
            </button>
          </>
        }
      />
      <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-line px-2 py-1.5" data-testid="tab-strip">
        {tabs.map((t) => {
          const active = t.id === tab?.id;
          return (
            <div key={t.id} className={`${chip} ${active ? "border-accent/60 text-fg" : "border-line text-muted"}`} data-testid="browser-tab" data-active={active}>
              <button
                type="button"
                onClick={() => {
                  setPicked(t.id);
                  void call("browser.activate", { id: t.id });
                }}
                className="flex min-h-9 max-w-40 items-center gap-1.5"
              >
                {t.preview && <File size={13} className="shrink-0 text-faint" data-testid="preview-icon" />}
                {!t.preview && t.favicon && <img src={t.favicon} alt="" className="size-3.5 shrink-0 rounded-[3px] object-contain" />}
                <span className="truncate">{tabTitle(t)}</span>
                {t.agent && (
                  <span className={`flex items-center gap-0.5 rounded px-1 text-[11px] ${agentActive(t, now) ? "bg-accent/20 text-accent" : "text-faint"}`} data-testid="agent-badge" title={agentActive(t, now) ? "The agent is using this tab" : "Opened by an agent"}>
                    <Bot size={11} />
                  </span>
                )}
                {isWindowTab(t) && (
                  <span className="flex items-center gap-0.5 rounded px-1 text-[11px] text-faint" data-testid="window-badge" title="A window on the Mac: viewable here, not movable">
                    <AppWindow size={11} />
                    window
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-faint">{viewportLabel(t)}</span>
              </button>
              <button type="button" aria-label="Close tab" onClick={() => void call("browser.closeTab", { id: t.id })} className="grid h-9 w-6 shrink-0 place-items-center text-faint">
                <X size={13} />
              </button>
            </div>
          );
        })}
        <button type="button" aria-label="New tab" data-testid="new-tab" onClick={() => void call("browser.newTab", handle ? { agent: handle } : {}).then((tab) => tab && setPicked((tab as { id: string }).id))} className={`${chip} border-line text-muted`}>
          <Plus size={15} />
        </button>
      </div>
      {tab ? <>
          <AddressBar key={tab.id} client={client} tab={tab} call={call} />
          <Frame key={`frame:${tab.id}`} client={client} tab={tab} commenting={commenting} />
        </> : <div className="p-6 text-center text-[13.5px] text-faint">No tabs open. Tap + for a new one.</div>}
      {tab && (
        <div className="shrink-0 border-t border-line pb-[env(safe-area-inset-bottom)]">
          <AnnotationChips />
          <TextBar client={client} tab={tab} onKeys={() => setSheet("keys")} />
        </div>
      )}
      {sheet === "viewport" && tab && (
        <Sheet title="Viewport" onClose={() => setSheet(undefined)} testId="viewport-sheet">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {[{ id: "", label: "Responsive" }, ...DEVICE_PRESETS].map((p) => {
              const current = (tab.viewport?.label ?? "Responsive") === p.label;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid="viewport-option"
                  onClick={() => {
                    setSheet(undefined);
                    void call("browser.viewport", { id: tab.id, request: p.id ? { preset: p.id } : null });
                  }}
                  className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-3 text-left ${current ? "text-accent" : "text-fg"}`}
                >
                  <span>{p.label}</span>
                  {"width" in p && <span className="text-[12.5px] text-faint">{p.width} × {p.height}</span>}
                </button>
              );
            })}
          </div>
        </Sheet>
      )}
      {sheet === "keys" && tab && (
        <Sheet title="Keys" onClose={() => setSheet(undefined)} testId="keys-sheet">
          <div className="grid grid-cols-4 gap-2 px-4 pb-3">
            {KEYS.map((k) => (
              <button key={k.key} type="button" data-testid={`key-${k.key}`} onClick={() => void client.call("browser.input", { id: tab.id, input: { type: "key", key: k.key } }).catch((e) => toast(failure(e), "error"))} className="min-h-12 rounded-xl border border-line text-[15px] active:bg-raised">
                {k.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** Typing into the focused element on the Mac, and the keys a phone keyboard lacks. */
function TextBar({ client, tab, onKeys }: { client: HostClient; tab: BrowserTab; onKeys: () => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text) return;
    const sent = text;
    setText("");
    client.call("browser.input", { id: tab.id, input: { type: "text", text: sent } }).catch((e) => {
      setText((current) => current || sent);
      toast(failure(e), "error");
    });
  };
  return (
    <form className="flex items-center gap-1.5 px-2 py-1.5" onSubmit={(event) => (event.preventDefault(), send())}>
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Type into the focused field" autoCapitalize="none" autoCorrect="off" enterKeyHint="send" data-testid="type-field" className="min-h-10 min-w-0 flex-1 rounded-xl bg-sunken px-3 text-[16px] text-fg outline-none placeholder:text-faint" />
      <button type="submit" disabled={!text} data-testid="type-send" className="min-h-10 rounded-xl border border-line px-3 text-[14px] text-muted disabled:opacity-40">
        Type
      </button>
      <button type="button" aria-label="Keys" data-testid="keys-open" onClick={onKeys} className="grid h-10 w-10 place-items-center rounded-xl border border-line text-muted">
        <Keyboard size={18} />
      </button>
    </form>
  );
}

function AddressBar({ client, tab, call }: { client: HostClient; tab: BrowserTab; call: Call }) {
  const preview = tab.preview;
  const [value, setValue] = useState(tabAddress(tab));
  const [focused, setFocused] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // The page's own navigation shows in the bar unless the user is typing.
  useEffect(() => {
    if (!focused) setValue(tabAddress(tab));
  }, [tab, focused]);
  const shown = focused && !preview ? suggestions(history, value) : [];
  const go = (input: string) => {
    setFocused(false);
    (document.activeElement as HTMLElement | null)?.blur();
    void call("browser.navigate", { id: tab.id, input });
  };
  const nav = "grid h-10 w-10 shrink-0 place-items-center rounded-lg text-muted disabled:opacity-30";
  return (
    <div className="relative shrink-0 border-b border-line px-1 py-1">
      <form className="flex items-center gap-0.5" onSubmit={(event) => (event.preventDefault(), go(value))}>
        <button type="button" aria-label="Back" disabled={!tab.canGoBack} data-testid="nav-back" onClick={() => void call("browser.command", { id: tab.id, command: "back" })} className={nav}>
          <ArrowLeft size={18} />
        </button>
        <button type="button" aria-label="Forward" disabled={!tab.canGoForward} data-testid="nav-forward" onClick={() => void call("browser.command", { id: tab.id, command: "forward" })} className={nav}>
          <ArrowRight size={18} />
        </button>
        <button type="button" aria-label={tab.loading ? "Stop" : "Reload"} data-testid="nav-reload" onClick={() => void call("browser.command", { id: tab.id, command: tab.loading ? "stop" : "reload" })} className={nav}>
          {tab.loading ? <X size={18} /> : <RotateCw size={17} />}
        </button>
        <input
          value={value}
          readOnly={!!preview}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => {
            setFocused(true);
            event.currentTarget.select();
            if (!preview) client.call("browser.history", {}).then(setHistory, () => undefined);
          }}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="go"
          aria-label="Address"
          data-testid="address"
          className="selectable min-h-10 min-w-0 flex-1 rounded-xl bg-sunken px-3 text-[15px] text-fg outline-none"
        />
      </form>
      {preview && preview.modes.length > 1 && (
        <div className="flex gap-1 px-2 pt-1" role="group" aria-label="Preview mode" data-testid="preview-modes">
          {preview.modes.map((mode) => (
            <button key={mode} type="button" aria-pressed={mode === preview.mode} onClick={() => void call("browser.previewMode", { id: tab.id, mode })} className={`min-h-9 rounded-lg border px-3 text-[13px] capitalize ${mode === preview.mode ? "border-accent/60 text-fg" : "border-line text-muted"}`}>
              {mode}
            </button>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div className="absolute inset-x-1 top-full z-30 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-lg" data-testid="suggestions">
          {shown.map((entry) => (
            <button key={entry.url} type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => go(entry.url)} className="flex min-h-11 w-full flex-col justify-center px-3 text-left active:bg-raised" data-testid="suggestion">
              <span className="truncate text-[14px] text-fg">{entry.title || entry.url}</span>
              <span className="truncate text-[11.5px] text-faint">{entry.url}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface One {
  id: number;
  start: { x: number; y: number };
  last: { x: number; y: number };
  at: number;
  moved: number;
  /** The long press already fired. */
  pressed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** The stream and its gestures. */
function Frame({ client, tab, commenting }: { client: HostClient; tab: BrowserTab; commenting: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [stream, setStream] = useState<string | null>();
  const [retry, setRetry] = useState(0);
  const [lost, setLost] = useState(false);
  const [view, setView] = useState<View>(FIT);
  const [pick, setPick] = useState<{ x: number; y: number } | undefined>(undefined);
  const page = pageSize(tab);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setRoom({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setRoom({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  // The page drawn as large as the room allows, at its own aspect.
  const fit = room.width && room.height ? Math.min(room.width / page.width, room.height / page.height) : 0;
  const drawn = { width: Math.floor(page.width * fit), height: Math.floor(page.height * fit) };
  const size = { w: drawn.width, h: drawn.height };
  const asked = { w: round(drawn.width, 50), h: round(drawn.height, 50) };

  useEffect(() => {
    let alive = true;
    setLost(false);
    client.call("browser.view", { id: tab.id, on: true }).then(
      (result) => alive && setStream(result?.stream ?? null),
      (e) => alive && (setStream(null), toast(failure(e), "error")),
    );
    return () => {
      alive = false;
      client.call("browser.view", { id: tab.id, on: false }).catch(() => undefined);
    };
  }, [client, tab.id, retry]);

  // The zoom belongs to one picture size.
  useEffect(() => setView(FIT), [tab.id, page.width, page.height]);

  const input = (action: BrowserInput) => client.call("browser.input", { id: tab.id, input: action }).catch((e) => (toast(failure(e), "error"), null));
  const box = (): Box | undefined => {
    const r = img.current?.getBoundingClientRect();
    return r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : undefined;
  };

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const one = useRef<One | undefined>(undefined);
  const pinch = useRef<{ dist: number; view: View } | undefined>(undefined);
  const scroll = useRef({ dx: 0, dy: 0, at: { x: 0, y: 0 }, inflight: false });

  const flush = () => {
    const s = scroll.current;
    if (s.inflight || (!s.dx && !s.dy)) return;
    const { dx, dy, at } = s;
    s.dx = s.dy = 0;
    s.inflight = true;
    void input({ type: "scroll", x: at.x, y: at.y, dx, dy }).finally(() => {
      s.inflight = false;
      flush();
    });
  };

  const down = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      if (one.current) clearTimeout(one.current.timer);
      one.current = undefined;
      const [a, b] = [...pointers.current.values()];
      if (a && b) pinch.current = { dist: distance(a, b), view };
      return;
    }
    if (pointers.current.size > 2) return;
    const start = { x: event.clientX, y: event.clientY };
    const g: One = { id: event.pointerId, start, last: start, at: Date.now(), moved: 0, pressed: false };
    // A long press is a right click, unless the point is being commented on.
    if (!commenting) {
      g.timer = setTimeout(() => {
        const frame = box();
        if (g.moved > 10 || !frame || one.current !== g) return;
        g.pressed = true;
        const p = toPagePoint(start, frame, page);
        void input({ type: "longPress", ...p });
      }, LONG_PRESS_MS);
    }
    one.current = g;
  };

  const move = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = area.current?.getBoundingClientRect();
    if (pinch.current && pointers.current.size >= 2 && rect) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const mid = midpoint(a, b);
      const next = zoomAt(pinch.current.view, pinch.current.view.scale * (distance(a, b) / Math.max(1, pinch.current.dist)), { x: mid.x - center.x, y: mid.y - center.y });
      setView(clampView(next, size));
      return;
    }
    const g = one.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.last.x;
    const dy = event.clientY - g.last.y;
    g.last = { x: event.clientX, y: event.clientY };
    g.moved = Math.max(g.moved, Math.hypot(g.last.x - g.start.x, g.last.y - g.start.y));
    if (g.moved <= 10 || g.pressed) return;
    clearTimeout(g.timer);
    if (view.scale > 1.01) {
      // Zoomed in: a drag pans the picture; reset the zoom to scroll the page.
      setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }, size));
      return;
    }
    const frame = box();
    if (!frame) return;
    const s = scroll.current;
    const delta = wheelDelta({ dx, dy }, frame, page);
    s.dx += delta.dx;
    s.dy += delta.dy;
    s.at = toPagePoint(g.start, frame, page);
    flush();
  };

  const up = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = undefined;
      return;
    }
    const g = one.current;
    if (!g || g.id !== event.pointerId) return;
    clearTimeout(g.timer);
    one.current = undefined;
    if (g.pressed || classify(g.moved, Date.now() - g.at) !== "tap") return;
    const frame = box();
    if (!frame) return;
    const p = toPagePoint(g.start, frame, page);
    // Later than the click that follows this touch, or that click would land on the new sheet's backdrop and close it.
    if (commenting) setTimeout(() => setPick(p), 250);
    else void input({ type: "tap", ...p });
  };

  const cancel = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (one.current) clearTimeout(one.current.timer);
    one.current = undefined;
    if (pointers.current.size < 2) pinch.current = undefined;
  };

  const src = stream && drawn.width ? `${stream}?w=${asked.w}&h=${asked.h}&dpr=${Math.min(3, window.devicePixelRatio || 2)}&r=${retry}` : undefined;
  // Removing an <img> does not end its download: a stream left open holds one of the page's few connections to the
  // Mac, and a handful of them stall every later call. Clearing the src of the picture that goes away ends it.
  useEffect(() => {
    const el = img.current;
    return () => el?.removeAttribute("src");
  }, [src, lost]);
  return (
    <div className="relative min-h-0 flex-1 bg-black" data-testid="frame-area">
      <div ref={area} className="absolute inset-0 touch-none select-none overflow-hidden" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onContextMenu={(event) => event.preventDefault()}>
        {src && !lost && (
          <img
            ref={img}
            key={`${tab.id}:${asked.w}x${asked.h}:${retry}`}
            src={src}
            alt={`${tabTitle(tab)} on the Mac`}
            draggable={false}
            onError={(event) => event.currentTarget.isConnected && setLost(true)}
            data-testid="frame"
            className={`pointer-events-none absolute bg-white ${commenting ? "outline outline-2 outline-accent" : ""}`}
            style={{ width: drawn.width, height: drawn.height, left: (room.width - drawn.width) / 2, top: (room.height - drawn.height) / 2, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        )}
        {stream === null && <div className="absolute inset-0 grid place-items-center p-6 text-center text-[13.5px] text-faint">This tab is not available.</div>}
        {lost && (
          <div className="absolute inset-0 grid place-items-center">
            <button type="button" onClick={() => (setLost(false), setRetry((n) => n + 1))} className="rounded-xl border border-line px-4 py-2.5 text-[14px] text-fg" data-testid="stream-retry">
              The stream stopped. Retry
            </button>
          </div>
        )}
      </div>
      {view.scale > 1.01 && (
        <button type="button" aria-label="Reset zoom" data-testid="zoom-reset" onClick={() => setView(FIT)} className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-black/60 text-white">
          <ZoomOut size={18} />
        </button>
      )}
      {commenting && <div className="pointer-events-none absolute inset-x-0 top-0 bg-accent/90 px-3 py-1 text-center text-[12px] text-white">Tap an element to comment on it</div>}
      {pick && <CommentSheet client={client} tab={tab} point={pick} onClose={() => setPick(undefined)} />}
    </div>
  );
}

function CommentSheet({ client, tab, point, onClose }: { client: HostClient; tab: BrowserTab; point: { x: number; y: number }; onClose: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!comment.trim() || busy) return;
    setBusy(true);
    try {
      const result = await client.call("browser.input", { id: tab.id, input: { type: "pick", ...point, comment: comment.trim() } });
      const annotation: Annotation | undefined = result?.annotation;
      if (!annotation) throw new Error("No element there");
      annotations.add(annotation);
      toast("Comment added. It goes with your next message.");
      onClose();
    } catch (error) {
      toast(failure(error), "error");
      setBusy(false);
    }
  };
  return (
    <Sheet title="Comment on the element" onClose={onClose} testId="comment-sheet">
      <form className="flex flex-col gap-3 px-4 pb-3" onSubmit={(event) => (event.preventDefault(), void submit())}>
        <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="What should change here?" data-testid="comment-text" className="w-full resize-none rounded-xl bg-sunken px-3 py-2.5 text-[16px] text-fg outline-none placeholder:text-faint" />
        <button type="submit" disabled={!comment.trim() || busy} data-testid="comment-add" className="min-h-12 rounded-xl bg-accent text-[15px] font-medium text-white disabled:opacity-40">
          Add comment
        </button>
      </form>
    </Sheet>
  );
}
