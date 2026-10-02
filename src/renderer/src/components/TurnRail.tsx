// Turn rail, Codex-style (its "user message navigation rail", verified against the Codex app bundle):
// a short line per message you sent, left of the transcript. Hover magnifies the neighbours and shows
// the message with a preview of its answer; click jumps there, dragging scrubs through the chat, and
// ⌥↑/⌥↓ step between messages. Lines of turns on screen are brighter, bookmarked ones stay lit.
import { Bookmark } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toggleBookmark, useBookmarks } from "../lib/bookmarks";
import { renderMarkdown } from "../lib/markdown";
import { adjacentTurn, nearDistance, RAIL_MIN_ITEMS, type RailItem } from "../lib/rail";

/** Room the rail needs left of the transcript text; narrower windows hide it (the keys still work). */
const GUTTER = 48;
const OPEN_DELAY = 150;
const CLOSE_DELAY = 120;
const HIGHLIGHT = "color-mix(in srgb, var(--fg) 16%, var(--raised))";

type Jump = (key: string, behavior: ScrollBehavior) => Promise<void>;

interface Props {
  items: RailItem[];
  scroller: React.RefObject<HTMLDivElement | null>;
  /** The centered transcript column, to measure the gutter. */
  column: React.RefObject<HTMLDivElement | null>;
  /** Where a jump puts the message: this far below the top, like sending one does. */
  topGap: number;
  /** Render a turn from an earlier page so it can be scrolled to. */
  reveal: (key: string) => void;
  sessionPath?: string;
}

export function TurnRail({ items, scroller, column, topGap, reveal, sessionPath }: Props) {
  const fits = useGutter(scroller, column);
  const latest = useRef(0);

  const jump: Jump = useCallback(
    async (key, behavior) => {
      const root = scroller.current;
      if (!root) return;
      const ticket = ++latest.current;
      let section = findRun(root, key);
      if (!section) {
        reveal(key);
        section = await rendered(root, key);
        behavior = "instant";
      }
      if (!section || ticket !== latest.current) return;
      root.scrollTo({ top: section.offsetTop - topGap, behavior });
      flash(section);
    },
    [scroller, topGap, reveal],
  );

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || !event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    // While you write, ⌥↑/⌥↓ keep moving the caret by paragraph.
    const target = event.target;
    if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.value) return;
    const root = scroller.current;
    if (!root || root.offsetParent === null) return;
    const base = root.getBoundingClientRect().top + topGap;
    const tops = items.map((item) => findRun(root, item.key)?.getBoundingClientRect().top ?? null).map((top) => (top === null ? null : top - base));
    const index = adjacentTurn(tops, event.key === "ArrowUp" ? "previous" : "next");
    const item = index === undefined ? undefined : items[index];
    if (!item) return;
    event.preventDefault();
    void jump(item.key, "smooth");
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  if (!fits || items.length < RAIL_MIN_ITEMS) return null;
  return <Rail items={items} scroller={scroller} topGap={topGap} jump={jump} sessionPath={sessionPath} />;
}

function Rail({
  items,
  scroller,
  topGap,
  jump,
  sessionPath,
}: {
  items: RailItem[];
  scroller: React.RefObject<HTMLDivElement | null>;
  topGap: number;
  jump: Jump;
  sessionPath?: string;
}) {
  const bookmarks = useBookmarks(sessionPath);
  const marked = useMemo(() => new Set(bookmarks), [bookmarks]);
  const inView = useInView(scroller, items, topGap);
  /** The marker under the pointer or being scrubbed: magnified, and the card shows its turn. */
  const [hot, setHot] = useState<number | null>(null);
  const [card, setCard] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [fade, setFade] = useState("");
  const nav = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrub = useRef<{ pointerId: number; index: number; moved: boolean } | null>(null);
  /** A drag ends with a click on the marker it started from; that click must not jump back. */
  const dragged = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);

  const hover = (index: number) => {
    clearTimeout(timer.current);
    setHot(index);
    if (!card) timer.current = setTimeout(() => setCard(true), OPEN_DELAY);
  };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCard(false);
      setHot(null);
    }, CLOSE_DELAY);
  };
  const indexAt = (element: Element | null): number | undefined => {
    const button = element?.closest<HTMLElement>("[data-rail-index]");
    return button && list.current?.contains(button) ? Number(button.dataset.railIndex) : undefined;
  };
  const endScrub = (event: React.PointerEvent) => {
    const state = scrub.current;
    if (state?.pointerId !== event.pointerId) return;
    scrub.current = null;
    setScrubbing(false);
    dragged.current = state.moved;
    setTimeout(() => {
      dragged.current = false;
    }, 0);
    if (!nav.current?.matches(":hover")) leave();
  };

  // When the rail itself scrolls, keep the turns on screen visible (the first wins), or the one being
  // scrubbed. Not while you hover: the rail must not move under the pointer.
  const shown = items.flatMap((item, index) => (inView.has(item.key) ? [index] : []));
  const [from, to] = scrubbing && hot !== null ? [hot, hot] : hot === null ? [shown[0] ?? -1, shown.at(-1) ?? -1] : [-1, -1];
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    for (const index of [to, from]) {
      const button = index < 0 ? undefined : (element.children[index] as HTMLElement | undefined);
      if (!button) continue;
      if (button.offsetTop < element.scrollTop) element.scrollTop = button.offsetTop;
      else if (button.offsetTop + button.offsetHeight > element.scrollTop + element.clientHeight) {
        element.scrollTop = button.offsetTop + button.offsetHeight - element.clientHeight;
      }
    }
    setFade(edges(element));
  }, [from, to, items.length]);

  // The card sits right of the hot marker, kept inside the transcript area.
  useLayoutEffect(() => {
    const host = nav.current;
    const card = box.current;
    const button = hot === null ? undefined : (list.current?.children[hot] as HTMLElement | undefined);
    if (!host || !card || !button) return;
    const marker = button.getBoundingClientRect();
    const bounds = (host.offsetParent ?? document.body).getBoundingClientRect();
    const half = card.offsetHeight / 2;
    const center = Math.min(Math.max(marker.top + marker.height / 2, bounds.top + 8 + half), bounds.bottom - 8 - half);
    card.style.top = `${center - host.getBoundingClientRect().top}px`;
  });

  const hotItem = hot === null ? undefined : items[hot];
  return (
    <nav
      ref={nav}
      aria-label="Your messages"
      className="turn-rail absolute top-1/2 left-3 z-20 -translate-y-1/2"
      onPointerEnter={() => clearTimeout(timer.current)}
      onPointerLeave={() => {
        if (!scrub.current) leave();
      }}
    >
      <div
        ref={list}
        className="turn-rail-list"
        data-fade={fade || undefined}
        data-scrubbing={scrubbing || undefined}
        onScroll={(event) => setFade(edges(event.currentTarget))}
        onPointerDown={(event) => {
          const index = indexAt(event.target as Element);
          if (event.button !== 0 || index === undefined) return;
          scrub.current = { pointerId: event.pointerId, index, moved: false };
          (event.target as Element).closest("button")?.setPointerCapture(event.pointerId);
          setScrubbing(true);
          setHot(index);
        }}
        onPointerMove={(event) => {
          const state = scrub.current;
          if (state?.pointerId !== event.pointerId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const y = Math.min(Math.max(event.clientY, rect.top), rect.bottom - 1);
          const index = indexAt(document.elementFromPoint(rect.left + rect.width / 2, y));
          const item = index === undefined ? undefined : items[index];
          if (index === undefined || !item || index === state.index) return;
          scrub.current = { ...state, index, moved: true };
          clearTimeout(timer.current);
          setHot(index);
          setCard(true);
          void jump(item.key, "instant");
        }}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onLostPointerCapture={endScrub}
      >
        {items.map((item, index) => {
          const bookmarked = marked.has(item.at);
          return (
            <button
              key={item.key}
              type="button"
              tabIndex={-1}
              data-rail-index={index}
              data-hot={hot === index || undefined}
              aria-current={inView.has(item.key) ? "true" : undefined}
              aria-label={`Jump to message ${index + 1}${bookmarked ? ", bookmarked" : ""}`}
              className="turn-rail-item"
              onPointerEnter={() => {
                if (!scrub.current) hover(index);
              }}
              onClick={() => {
                if (dragged.current) return;
                void jump(item.key, "smooth");
              }}
            >
              <span className="turn-rail-marker" data-near={nearDistance(index, hot)} data-bookmarked={bookmarked || undefined}>
                <span className="turn-rail-line" />
                {bookmarked && <span className="turn-rail-dot" />}
              </span>
            </button>
          );
        })}
      </div>
      {card && hotItem && (
        <div
          ref={box}
          role="tooltip"
          className="turn-rail-card absolute left-full ml-1 w-[320px] max-w-[calc(100vw-1rem)] -translate-y-1/2 rounded-xl border border-line-strong bg-panel p-2.5 text-[13px] leading-5 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.5)]"
        >
          <RailCard
            item={hotItem}
            bookmarked={marked.has(hotItem.at)}
            onBookmark={sessionPath ? (on) => toggleBookmark(sessionPath, hotItem.at, on) : undefined}
          />
        </div>
      )}
    </nav>
  );
}

/** Your message on one line, then the first lines of the answer (Codex's tooltip). */
function RailCard({ item, bookmarked, onBookmark }: { item: RailItem; bookmarked: boolean; onBookmark?: (on: boolean) => void }) {
  // Only the first lines show; long answers are cut before rendering.
  const html = useMemo(() => (item.preview ? renderMarkdown(item.preview.slice(0, 1500)) : ""), [item.preview]);
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{item.label}</span>
        {onBookmark && (
          <button
            type="button"
            aria-pressed={bookmarked}
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark turn"}
            title={bookmarked ? "Remove bookmark" : "Bookmark turn"}
            onClick={() => onBookmark(!bookmarked)}
            className={`shrink-0 rounded-md p-0.5 hover:bg-raised ${bookmarked ? "text-fg" : "text-faint hover:text-fg"}`}
          >
            <Bookmark size={15} fill={bookmarked ? "currentColor" : "none"} />
          </button>
        )}
      </div>
      {html ? (
        <div className="rail-preview mt-1" dangerouslySetInnerHTML={{ __html: html }} />
      ) : item.live ? (
        <div className="shimmer mt-1 w-fit">Working…</div>
      ) : null}
    </>
  );
}

/** Whether the transcript column leaves room for the rail on its left. */
function useGutter(scroller: React.RefObject<HTMLDivElement | null>, column: React.RefObject<HTMLDivElement | null>): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const root = scroller.current;
    const inner = column.current;
    if (!root || !inner) return;
    const measure = () => setFits(inner.offsetLeft + parseFloat(getComputedStyle(inner).paddingLeft) >= GUTTER);
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    measure();
    return () => observer.disconnect();
  }, [scroller, column]);
  return fits;
}

/** Keys of the turns on screen (below the jump position). */
function useInView(scroller: React.RefObject<HTMLDivElement | null>, items: RailItem[], topGap: number): ReadonlySet<string> {
  const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set());
  const keys = items.map((item) => item.key).join("\0");
  useEffect(() => {
    const root = scroller.current;
    const sections = root?.querySelector("[data-run]")?.parentElement;
    if (!root || !sections) return;
    const wanted = new Set(keys.split("\0"));
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.run;
          if (!key) continue;
          if (entry.isIntersecting) visible.add(key);
          else visible.delete(key);
        }
        setInView((current) => (current.size === visible.size && [...visible].every((key) => current.has(key)) ? current : new Set(visible)));
      },
      { root, rootMargin: `-${topGap}px 0px 0px 0px` },
    );
    // Earlier pages render later; observing an observed section again is a no-op.
    const observeAll = () => {
      for (const section of sections.querySelectorAll<HTMLElement>(":scope > [data-run]")) {
        if (wanted.has(section.dataset.run ?? "")) observer.observe(section);
      }
    };
    observeAll();
    const mutations = new MutationObserver(observeAll);
    mutations.observe(sections, { childList: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [scroller, keys, topGap]);
  return inView;
}

function findRun(root: HTMLElement, key: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-run="${CSS.escape(key)}"]`);
}

/** Wait (up to 1.5 s) for a revealed turn to render. */
function rendered(root: HTMLElement, key: string): Promise<HTMLElement | null> {
  const started = performance.now();
  return new Promise((resolve) => {
    const check = () => {
      const section = findRun(root, key);
      if (section || !root.isConnected || performance.now() - started > 1500) resolve(section);
      else requestAnimationFrame(check);
    };
    check();
  });
}

/** Briefly light up the message you jumped to. */
function flash(section: HTMLElement): void {
  const bubble = section.querySelector<HTMLElement>("[data-user-bubble]");
  if (!bubble || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  bubble.animate([{ backgroundColor: HIGHLIGHT }, { backgroundColor: HIGHLIGHT, offset: 0.35 }, { backgroundColor: "var(--raised)" }], {
    duration: 900,
    easing: "cubic-bezier(0.23, 1, 0.32, 1)",
  });
}

/** Which ends of the rail fade out because more markers are scrolled past them. */
function edges(element: HTMLElement): string {
  const top = element.scrollTop > 0;
  const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
  return [top ? "top" : "", bottom ? "bottom" : ""].filter(Boolean).join(" ");
}
