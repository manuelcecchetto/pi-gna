import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CircleSlash,
  Copy,
  FileText,
  Folder,
  FoldVertical,
  GitBranch,
  ImageIcon,
  MessageSquare,
  SquareKanban,
  SquareTerminal,
} from "./icons";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, TextContent, UserMessage } from "../../../shared/protocol";
import { type CardMention, splitCardBlock, splitFileMentions } from "../lib/attachments";
import { formatStamp, formatTokens, tildify } from "../lib/format";
import { previewClick } from "../lib/preview";
import { outlineItems, type RailItem, railItems } from "../lib/rail";
import { distanceToEnd, END_SLACK, followsAfterScroll } from "../lib/turn-scroll";
import type { SessionState } from "../../../shared/session-state";
import type { TurnOutline } from "../../../shared/turn-outline";
import { type Block, createRunDeriver, layoutRun, needsTimeDivider, type Run } from "../lib/view";
import { loopWallpaper, wallpaperStyle } from "../lib/wallpapers";
import { imageWallpaperStyle } from "../lib/theme";
import { useChatActions, useChatUi } from "../lib/chat-ui";
import { ColumnIcon } from "./ColumnIcon";
import { CompactionProgress } from "./CompactionProgress";
import { WorkAccordion } from "./Activity";
import { Markdown } from "./Markdown";
import { imageSrc } from "../lib/image-src";
import { Ansi } from "./primitives";
import { findRun, flash, rendered, TurnRail } from "./TurnRail";

const PAGE = 30;

/** Turns the host holds beyond the ones in `session` (a client pages them in); `load` fetches the next page. */
export interface EarlierTurns {
  count: number;
  load: () => Promise<void>;
  /** One line per earlier turn (the desktop): the turn rail shows them before they are loaded. */
  outline?: TurnOutline[];
  /** Load the earlier turns down to this one (a jump to it). */
  reach?: (key: string) => Promise<void>;
  /** The answer of earlier turn `index`, for the rail's card. */
  preview?: (index: number) => Promise<string>;
}

/** What a client with its own turn navigation (the phone's jump list) gets: the turns and a way to scroll to one. */
export interface TurnNav {
  items: RailItem[];
  jump: (key: string) => Promise<void>;
  sessionPath?: string;
}

export function Transcript({ session, earlier, turns, onPickProject }: { session: SessionState; earlier?: EarlierTurns; turns?: (nav: TurnNav) => React.ReactNode; /** Makes the project name of the empty state a button (the phone: switch project). */ onPickProject?: () => void }) {
  const derive = useMemo(() => createRunDeriver(), []);
  const runs = derive(session);
  const [limit, setLimit] = useState(PAGE);
  // Turns paged in from the host before the first one stay in view: the limit grows by as many runs.
  const [first, setFirst] = useState(runs[0]?.key);
  if (runs[0]?.key !== first) {
    setFirst(runs[0]?.key);
    const prepended = runs.findIndex((run) => run.key === first);
    if (prepended > 0) setLimit((value) => value + prepended);
  }
  const hidden = Math.max(0, runs.length - limit);
  const visible = hidden ? runs.slice(hidden) : runs;
  const { homeDir: home } = useChatActions();

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { viewport, jumped, restoreFromBottom, pageAnchor, below, onScroll, onWheel, onTouchStart, onTouchMove, jumpToLatest } = useTurnScroll(scroller, content, runs);
  const [paging, setPaging] = useState(false);
  /** A turn a jump paged in from the host: rendered once it is among the runs. */
  const revealing = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const key = revealing.current;
    const index = key === undefined ? -1 : runs.findIndex((run) => run.key === key);
    if (index < 0) return;
    revealing.current = undefined;
    if (index < runs.length - limit) setLimit(runs.length - index);
  });

  if (session.loading) return <div className="flex-1" />; // not the empty state: this chat has a history
  if (!runs.length && !session.running) return <EmptyTranscript session={session} onPickProject={onPickProject} />;

  /** Render a turn from an earlier page, for the turn rail to scroll to; one the host still holds is paged in first. */
  const reveal = async (key: string) => {
    const index = runs.findIndex((run) => run.key === key);
    if (index >= 0) {
      if (index < hidden) setLimit(runs.length - index);
      return;
    }
    if (!earlier?.reach) return;
    revealing.current = key;
    await earlier.reach(key);
  };

  /** The host's earlier turns: the view keeps its place once they are in the transcript (the store notifies a frame later). */
  const loadEarlier = async () => {
    const element = scroller.current;
    if (!earlier || !element || paging) return;
    setPaging(true);
    pageAnchor.current = { fromBottom: element.scrollHeight - element.scrollTop, first: runs[0]?.key };
    try {
      await earlier.load();
    } catch {
      pageAnchor.current = null;
    } finally {
      setPaging(false);
    }
  };

  /** Scroll to a turn (paging it in first when it is on an earlier page) and flash it. */
  const jump = async (key: string) => {
    const root = scroller.current;
    if (!root) return;
    let section = findRun(root, key);
    let behavior: ScrollBehavior = "smooth";
    if (!section) {
      await reveal(key);
      section = await rendered(root, key);
      behavior = "instant";
    }
    if (!section) return;
    root.scrollTo({ top: section.offsetTop - TOP_GAP, behavior });
    flash(section);
  };

  const rail = earlier?.outline?.length ? [...outlineItems(earlier.outline, earlier.preview), ...railItems(runs)] : railItems(runs);
  const last = visible.at(-1);
  // The newest turn gets at least a screen of height, so your message can sit at the top while the
  // answer streams in below it. Sessions opened from disk keep their natural height until you send.
  const fillKey = last && (last.live || jumped.current === last.key) ? last.key : undefined;
  const fillHeight = Math.max(0, viewport - TOP_GAP - BOTTOM_GAP);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={() => {
          onScroll();
          // Near the top the host's earlier page loads by itself; the button stays for when it cannot scroll.
          if (hidden === 0 && earlier && earlier.count > 0 && (scroller.current?.scrollTop ?? Infinity) < 600) void loadEarlier();
        }}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div ref={content} className="mx-auto flex w-full min-w-0 max-w-[800px] flex-col gap-10 px-4 sm:px-8" style={{ paddingTop: TOP_GAP, paddingBottom: BOTTOM_GAP }}>
          {hidden === 0 && earlier && earlier.count > 0 && (
            <button
              type="button"
              disabled={paging}
              onClick={() => void loadEarlier()}
              className="self-center rounded-full border border-line px-3 py-1.5 text-[12px] text-muted hover:text-fg disabled:opacity-60"
            >
              {paging ? "Loading…" : `Show earlier turns (${earlier.count} more)`}
            </button>
          )}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => {
                const element = scroller.current;
                if (element) restoreFromBottom.current = element.scrollHeight - element.scrollTop;
                setLimit((value) => value + PAGE);
              }}
              className="self-center rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:text-fg"
            >
              Show {Math.min(hidden, PAGE)} earlier {hidden === 1 ? "turn" : "turns"}
            </button>
          )}
          {visible.map((run, index) => (
            <RunView
              key={run.key}
              run={run}
              divider={needsTimeDivider(runs[hidden + index - 1], run)}
              cwd={session.cwd}
              home={home}
              status={run.live ? liveStatus(session) : undefined}
              minHeight={run.key === fillKey ? fillHeight : undefined}
            />
          ))}
        </div>
      </div>
      {turns?.({ items: rail, jump, sessionPath: session.sessionPath })}
      <TurnRail items={rail} scroller={scroller} column={content} topGap={TOP_GAP} reveal={reveal} sessionPath={session.sessionPath} />
      {below && (
        <button
          type="button"
          title="Jump to latest"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-line-strong bg-panel text-muted shadow-[0_6px_20px_-6px_rgb(0_0_0/0.5)] hover:text-fg"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  );
}

const TOP_GAP = 24;
const BOTTOM_GAP = 40;

const geometry = (element: HTMLElement) => ({ top: element.scrollTop, height: element.scrollHeight, view: element.clientHeight });

/**
 * Codex-style turn scrolling. Sending a message scrolls it to the top of the view and the answer
 * streams in below. Opening a session shows its end. While a run streams, the view follows it as
 * long as you are at the end (after sending, that is once the answer outgrows the view); scrolling
 * up stops that until you scroll back down or jump to the latest. The jump-to-latest button shows
 * exactly while the view is off the end and not following it: without it, output keeps you at the end.
 */
function useTurnScroll(
  scroller: React.RefObject<HTMLDivElement | null>,
  content: React.RefObject<HTMLDivElement | null>,
  runs: Run[],
) {
  const [viewport, setViewport] = useState(0);
  const [below, setBelow] = useState(false);
  const seen = useRef<string | undefined>(undefined);
  const jumped = useRef<string | undefined>(undefined);
  const restoreFromBottom = useRef<number | null>(null);
  /** Where the view was when the host was asked for earlier turns; applied once the first turn is another one. */
  const pageAnchor = useRef<{ fromBottom: number; first?: string } | null>(null);
  /** You are at the end, so new output keeps you there. */
  const pinned = useRef(true);
  /** The newest run is live, so its growth is streaming output. */
  const following = useRef(false);
  /** Content height the view was last positioned for; only a change in it moves the view. */
  const measured = useRef(0);
  /** View height last positioned for: a phone keyboard or a resized window changes it. */
  const viewed = useRef(0);
  const lastScroll = useRef({ top: 0, height: 0, view: 0 });
  /** Where the finger was at the last touch event. */
  const touchY = useRef<number | null>(null);
  const mounted = runs.length > 0;

  const showBelow = useCallback((element: HTMLElement) => setBelow(!pinned.current && distanceToEnd(geometry(element)) > END_SLACK), []);

  const settle = useCallback(
    (follow: boolean) => {
      const element = scroller.current;
      if (!element) return;
      const changed = element.scrollHeight !== measured.current;
      // Only a shorter view hides the end; a taller one already clamps to it.
      const resized = element.clientHeight < viewed.current;
      measured.current = element.scrollHeight;
      viewed.current = element.clientHeight;
      if (pinned.current && (changed || resized)) {
        // A shorter view (the keyboard opening) keeps the end in sight, as at the end you meant to stay there.
        if (follow || resized) element.scrollTop = element.scrollHeight;
        else pinned.current = distanceToEnd(geometry(element)) <= END_SLACK; // e.g. you expanded a step at the end
      }
      showBelow(element);
    },
    [scroller, showBelow],
  );

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const now = geometry(element);
    pinned.current = followsAfterScroll(pinned.current, lastScroll.current, now);
    lastScroll.current = now;
    showBelow(element);
  }, [scroller, showBelow]);

  // Wheel and touch input arrive before their scroll event, so streaming output cannot pull you back down first.
  // Only a view that can move up stops following: a short transcript has nothing to read above.
  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (event.deltaY < 0 && (scroller.current?.scrollTop ?? 0) > 0) pinned.current = false;
    },
    [scroller],
  );

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    touchY.current = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
  }, []);

  // A finger moving down drags the content up into view: you are scrolling up.
  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      const y = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
      if (y !== null && touchY.current !== null && y > touchY.current && (scroller.current?.scrollTop ?? 0) > 0) pinned.current = false;
      touchY.current = y;
    },
    [scroller],
  );

  const jumpToLatest = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [scroller]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport(element.clientHeight);
      settle(following.current); // async growth (images, code) and a resized view
    });
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
  }, [scroller, content, mounted, settle]);

  const last = runs.at(-1);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (restoreFromBottom.current !== null) {
      element.scrollTop = element.scrollHeight - restoreFromBottom.current; // keep your place when earlier turns load
      restoreFromBottom.current = null;
    }
    const anchor = pageAnchor.current;
    if (anchor && runs[0]?.key !== anchor.first) {
      element.scrollTop = element.scrollHeight - anchor.fromBottom;
      pageAnchor.current = null;
    }
    if (last && last.key !== seen.current) {
      const first = seen.current === undefined;
      seen.current = last.key;
      if (last.live) jumped.current = last.key;
      const section = element.querySelector<HTMLElement>(`[data-run="${CSS.escape(last.key)}"]`);
      pinned.current = true; // opening a session or sending a message puts you at the end
      if (last.live && section && !first) {
        // Your message glides to the top. The live turn is at least a view tall, so that is also the
        // end and the view follows once the answer outgrows it. Recording the new height keeps the
        // added turn itself from cutting the glide short.
        measured.current = element.scrollHeight;
        element.scrollTo({ top: section.offsetTop - TOP_GAP, behavior: "smooth" });
      } else {
        element.scrollTop = element.scrollHeight;
      }
    }
    const live = Boolean(last?.live);
    settle(live || following.current); // also follow the render that ends the run (its footer appears)
    following.current = live;
  });

  return { viewport, jumped, restoreFromBottom, pageAnchor, below, onScroll, onWheel, onTouchStart, onTouchMove, jumpToLatest };
}

/** Empty-state backdrop: the wallpaper picked in Settings (styles.css `.hero`), or nothing for none. While they loop,
 * each empty state shows the next one and keeps it while it is open. It picks again when the setting changes: at launch
 * the settings arrive from main after the first render. A project theme's wallpaper (`look`, an image or a built-in
 * one) replaces it and never loops. */
export function HeroBackdrop() {
  const look = useChatUi((state) => state.look);
  const setting = useChatUi((state) => state.settings.wallpaper);
  const picked = look?.wallpaper ?? setting;
  const loop = useChatUi((state) => state.settings.wallpaperLoop) && !look?.wallpaper;
  const [shown, setShown] = useState(() => ({ picked, loop, id: loopWallpaper(picked, loop) }));
  if (shown.picked !== picked || shown.loop !== loop) setShown({ picked, loop, id: loopWallpaper(picked, loop) });
  const style = look?.wallpaperUrl ? imageWallpaperStyle(look.wallpaperUrl) : wallpaperStyle(shown.id);
  return style ? <div className="hero" style={style} aria-hidden /> : null;
}

function EmptyTranscript({ session, onPickProject }: { session: SessionState; onPickProject?: () => void }) {
  const { homeDir } = useChatActions();
  const logo = useChatUi((state) => state.look?.logo);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-end overflow-hidden px-8 pb-8">
      <HeroBackdrop />
      <div className="relative flex flex-col items-center">
        {logo && <img src={logo} alt="" data-testid="project-logo" className="mb-4 size-16 object-contain" />}
        <h1 className="text-[26px] font-medium tracking-tight text-fg">What should we build?</h1>
        {onPickProject ? (
          <button
            type="button"
            onClick={onPickProject}
            aria-label="Switch project"
            data-testid="switch-project"
            className="mt-3 flex max-w-full items-center gap-1.5 rounded-full border border-line bg-panel px-4 py-2 font-mono text-[13px] text-fg active:opacity-60"
          >
            <span className="min-w-0 truncate">{tildify(session.cwd, homeDir)}</span>
            <ChevronsUpDown size={14} className="shrink-0 text-muted" />
          </button>
        ) : (
          <div className="mt-2 font-mono text-[12px] text-faint">{tildify(session.cwd, homeDir)}</div>
        )}
      </div>
    </div>
  );
}

/** Live states worth calling out next to "Working for…". */
function liveStatus(session: SessionState): string | undefined {
  if (session.dialogs.length) return "waiting for you";
  if (session.retry) return `retrying (${session.retry.attempt}/${session.retry.maxAttempts})`;
  return undefined;
}

const RunView = memo(function RunView({
  run,
  cwd,
  home,
  status,
  minHeight,
  divider,
}: {
  run: Run;
  cwd: string;
  home: string;
  status?: string;
  minHeight?: number;
  divider: boolean;
}) {
  const layout = useMemo(() => layoutRun(run), [run]);
  const renderBlock = (block: Block) => <BlockView block={block} cwd={cwd} home={home} />;
  return (
    <section data-run={run.key} className="flex flex-col gap-4" style={minHeight ? { minHeight } : undefined}>
      {run.user && <UserMessageView message={run.user.message} divider={divider} />}
      {(layout.work.length > 0 || run.live) && (
        <WorkAccordion run={run} layout={layout} cwd={cwd} home={home} status={status} renderBlock={renderBlock} />
      )}
      {layout.final.length > 0 && (
        <div className="group/answer flex flex-col gap-4">
          {layout.final.map((block) => (
            <BlockView key={block.key} block={block} cwd={cwd} home={home} />
          ))}
          {!run.live && <AnswerFooter blocks={layout.final} />}
        </div>
      )}
    </section>
  );
});

function userParts(message: UserMessage): { text: string; images: ImageContent[] } {
  if (typeof message.content === "string") return { text: message.content, images: [] };
  return {
    text: message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    images: message.content.filter((block): block is ImageContent => block.type === "image"),
  };
}

/**
 * Your messages: a right-aligned bubble (no avatar), Codex-style. The time shows on hover; a centered
 * divider marks the first message and messages after a long break.
 */
function UserMessageView({ message, divider }: { message: UserMessage; divider: boolean }) {
  const { openLightbox, homeDir, links } = useChatActions();
  const parts = userParts(message);
  const [withoutFiles, mentions] = splitFileMentions(parts.text);
  const [withoutCard, card] = splitCardBlock(withoutFiles);
  const [text, comments] = splitComments(withoutCard);
  const images = parts.images;
  const [expanded, setOpen] = useState(false);
  const [tapped, setTapped] = useState(false);
  const long = text.split("\n").length > 14 || text.length > 1400;
  const stamp = <HoverStamp at={message.timestamp} group="user" />;
  return (
    <div className="group/user flex flex-col items-end gap-2">
      {divider && (
        <div title={new Date(message.timestamp).toLocaleString()} className="self-center pb-2 text-[12px] text-faint">
          {formatStamp(message.timestamp)}
        </div>
      )}
      {card && (
        <div className="flex w-full items-center justify-end gap-3">
          {!text && !images.length && stamp}
          <SentCard mention={card} />
        </div>
      )}
      {images.length > 0 && (
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {!text && stamp}
          {images.map(imageSrc).map((src, index, all) => (
            <button key={index} type="button" onClick={() => openLightbox(src, all)} className="cursor-zoom-in">
              <img alt="" loading="lazy" decoding="async" className="h-24 max-w-56 rounded-xl border border-line object-cover" src={src} />
            </button>
          ))}
        </div>
      )}
      {text && (
        <div className="flex w-full items-center justify-end gap-3">
          {stamp}
          <div data-user-bubble onClick={() => setTapped((on) => !on)} className="max-w-[78%] touch:max-w-[88%] rounded-[22px] bg-raised px-5 touch:px-4 py-3 text-[14.5px] leading-relaxed text-fg">
            <div className={`selectable whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-[14]" : ""}`}>{text}</div>
            {long && (
              <button type="button" onClick={(event) => (event.stopPropagation(), setOpen(!expanded))} className="mt-1 text-[12px] text-muted hover:text-fg">
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        </div>
      )}
      {tapped && (
        <div className="hidden items-center gap-3 text-[12px] text-faint touch:flex" data-testid="user-stamp">
          <span>{new Date(message.timestamp).toLocaleString()}</span>
          <CopyText text={text} label="Copy message" />
        </div>
      )}
      {mentions.length > 0 && (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-1.5">
          {mentions.map((mention) => {
            const Icon = mention.isDir ? Folder : mention.image ? ImageIcon : FileText;
            return (
              <span
                key={mention.path}
                title={mention.path}
                onClick={mention.isDir ? undefined : previewClick(links, mention.path)}
                className={`flex max-w-72 items-center gap-1.5 rounded-lg border border-line bg-sunken px-2 py-1 font-mono text-[11.5px] text-muted ${mention.isDir ? "" : "cursor-pointer hover:bg-raised hover:text-fg"}`}
              >
                <Icon size={12} className="shrink-0 text-faint" />
                <span className="truncate">{tildify(mention.path, homeDir)}</span>
              </span>
            );
          })}
        </div>
      )}
      {comments && (
        <div className="w-[78%]">
          <Disclosure id={`${message.timestamp}:comments`} icon={<MessageSquare size={13} />} label={`Browser comments (${comments.count})`}>
            <pre className="code selectable whitespace-pre-wrap text-muted">{comments.body}</pre>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

/** The card a message was about (its <kanban-card> block): opens it on the board while it is there. */
function SentCard({ mention }: { mention: CardMention }) {
  const card = useChatUi((state) => state.board.cards.find((other) => other.id === mention.id));
  const { showBoard } = useChatActions();
  const chip = "flex max-w-72 items-center gap-1.5 rounded-lg border border-line bg-sunken px-2 py-1 text-[12px] text-muted";
  if (!card || !showBoard) {
    return (
      <span title={card ? undefined : "No longer on the board"} className={chip}>
        <SquareKanban size={12} className="shrink-0 text-faint" />
        <span className="truncate">{card?.title ?? mention.title}</span>
      </span>
    );
  }
  return (
    <button type="button" onClick={() => showBoard(card.cwd, card.id)} title={`On the board: ${card.title}`} className={`${chip} hover:bg-raised hover:text-fg`}>
      <ColumnIcon column={card.column} size={12} />
      <span className="truncate">{card.title}</span>
    </button>
  );
}

/** Copy and time under a finished answer. */
function AnswerFooter({ blocks }: { blocks: Block[] }) {
  const texts = blocks.filter((block): block is Extract<Block, { kind: "text" }> => block.kind === "text");
  const [copied, setCopied] = useState(false);
  const last = texts.at(-1);
  if (!last) return null;
  const copy = () => {
    void navigator.clipboard.writeText(texts.map((block) => block.text).join("\n\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="-mt-1 flex items-center gap-3 text-[12px] text-faint">
      <button type="button" onClick={copy} title="Copy answer" className="rounded-md p-1 hover:bg-raised hover:text-fg">
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <HoverStamp at={last.at} group="answer" />
    </div>
  );
}

/** A small copy button that says so for a moment. */
function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex items-center gap-1 rounded-md p-1 hover:text-fg"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Time stamps are noise most of the time: shown while hovering their message, full date in the tooltip. */
function HoverStamp({ at, group }: { at: number; group: "user" | "answer" }) {
  // No hover on a touch screen: a message's stamp would only take room from its bubble.
  // Tapping a message shows its time (the user bubble's own line); an answer's time is always there.
  const reveal = group === "user" ? "group-hover/user:opacity-100 touch:hidden" : "group-hover/answer:opacity-100 touch:opacity-100";
  return (
    <span title={new Date(at).toLocaleString()} className={`shrink-0 text-[12px] text-faint opacity-0 transition-opacity ${reveal}`}>
      {formatStamp(at)}
    </span>
  );
}

function splitComments(text: string): [string, { body: string; count: number } | undefined] {
  const match = text.match(/\n*<browser-comments>\n?([\s\S]*?)\n?<\/browser-comments>/);
  if (!match) return [text, undefined];
  const body = (match[1] ?? "").trim();
  return [text.replace(match[0], "").trim(), { body, count: (body.match(/^\d+\. /gm) ?? []).length }];
}

function BlockView({ block, cwd, home }: { block: Block; cwd: string; home: string }) {
  switch (block.kind) {
    case "text":
      return <Markdown text={block.text} streaming={block.streaming} visuals />;
    case "activity":
      return null; // rendered inside the work accordion
    case "error":
      return (
        <div className="flex gap-2.5 rounded-xl border border-bad/30 bg-bad/5 px-3.5 py-2.5 text-[13px] text-fg">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-bad" />
          <span className="selectable whitespace-pre-wrap break-words">{block.text}</span>
        </div>
      );
    case "aborted":
      return (
        <div className="flex items-center gap-2 text-[12px] text-faint">
          <CircleSlash size={12} /> Interrupted
        </div>
      );
    case "notice":
      return (
        <div className={`flex gap-2 text-[12.5px] ${block.level === "error" ? "text-bad" : "text-muted"}`}>
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="selectable whitespace-pre-wrap break-words">{block.text}</span>
        </div>
      );
    case "bash":
      return (
        <Disclosure
          id={block.key}
          icon={<SquareTerminal size={13} />}
          label={
            <span className="truncate font-mono text-[12px]">
              ! {block.message.command}
              {block.message.exitCode ? <span className="text-bad"> · exit {block.message.exitCode}</span> : null}
            </span>
          }
        >
          <pre className="code selectable max-h-96 overflow-auto whitespace-pre-wrap text-muted">
            <Ansi text={block.message.output} />
          </pre>
        </Disclosure>
      );
    case "custom": {
      const content = block.message.content;
      const text = typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      return (
        <div title={block.message.customType} className="rounded-xl border border-line bg-panel px-3.5 py-2.5">
          <Markdown text={text} />
        </div>
      );
    }
    case "compaction":
      if (block.status === "running") return <CompactionProgress item={block} />;
      if (block.status === "error") return (
        <div className="flex gap-2.5 rounded-xl border border-bad/30 bg-bad/5 px-3.5 py-2.5 text-[13px] text-bad" data-compaction="error">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="selectable whitespace-pre-wrap break-words">Compaction failed: {block.errorMessage}</span>
        </div>
      );
      if (block.status === "aborted") return (
        <div className="flex items-center gap-2 text-[12.5px] text-faint" data-compaction="aborted">
          <CircleSlash size={13} /> Context compaction interrupted
        </div>
      );
      return (
        <Disclosure id={block.key} icon={<FoldVertical size={13} />} label={`Context compacted · ${formatTokens(block.tokensBefore)} tokens before compaction`} divider>
          <div className="px-3.5 py-3">
            <Markdown text={block.summary} />
          </div>
        </Disclosure>
      );
    case "branch":
      return (
        <Disclosure id={block.key} icon={<GitBranch size={13} />} label="Branch summary" divider>
          <div className="px-3.5 py-3">
            <Markdown text={block.summary} />
          </div>
        </Disclosure>
      );
  }
}

function Disclosure({
  id,
  icon,
  label,
  divider,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  divider?: boolean;
  children: React.ReactNode;
}) {
  const override = useChatUi((state) => state.expanded[id]);
  const all = useChatUi((state) => state.expandAll);
  const { setExpanded } = useChatActions();
  const open = override ?? all;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(id, !open)}
        className={`group flex w-full items-center gap-2 py-1 text-left text-[12.5px] text-muted hover:text-fg ${divider ? "dashed-b" : ""}`}
      >
        <span className="text-faint">{icon}</span>
        {label}
        <ChevronRight size={12} className={`ml-auto shrink-0 text-faint transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="mt-2 overflow-hidden rounded-xl border border-line bg-sunken">{children}</div>}
    </div>
  );
}
