import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
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
} from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, TextContent, UserMessage } from "../../../shared/protocol";
import { type CardMention, splitCardBlock, splitFileMentions } from "../lib/attachments";
import { formatStamp, formatTokens, tildify } from "../lib/format";
import { railItems } from "../lib/rail";
import type { SessionState } from "../lib/session";
import { type Block, createRunDeriver, layoutRun, needsTimeDivider, type Run } from "../lib/view";
import { loopWallpaper, wallpaperStyle } from "../lib/wallpapers";
import { openLightbox, setExpanded, showBoard, useApp } from "../state/app";
import { ColumnIcon } from "./ColumnIcon";
import { CompactionProgress } from "./CompactionProgress";
import { WorkAccordion } from "./Activity";
import { Markdown } from "./Markdown";
import { Ansi } from "./primitives";
import { TurnRail } from "./TurnRail";

const PAGE = 30;

export function Transcript({ session }: { session: SessionState }) {
  const derive = useMemo(() => createRunDeriver(), []);
  const runs = derive(session);
  const [limit, setLimit] = useState(PAGE);
  const hidden = Math.max(0, runs.length - limit);
  const visible = hidden ? runs.slice(hidden) : runs;
  const home = window.studio.homeDir;

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { viewport, jumped, restoreFromBottom, below, onScroll, onWheel, jumpToLatest } = useTurnScroll(scroller, content, runs);

  if (session.loading) return <div className="flex-1" />; // not the empty state: this chat has a history
  if (!runs.length && !session.running) return <EmptyTranscript session={session} />;

  /** Render a turn from an earlier page, for the turn rail to scroll to. */
  const reveal = (key: string) => {
    const index = runs.findIndex((run) => run.key === key);
    if (index >= 0 && index < hidden) setLimit(runs.length - index);
  };

  const last = visible.at(-1);
  // The newest turn gets at least a screen of height, so your message can sit at the top while the
  // answer streams in below it. Sessions opened from disk keep their natural height until you send.
  const fillKey = last && (last.live || jumped.current === last.key) ? last.key : undefined;
  const fillHeight = Math.max(0, viewport - TOP_GAP - BOTTOM_GAP);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} onWheel={onWheel} className="relative min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className="mx-auto flex max-w-[800px] flex-col gap-10 px-8" style={{ paddingTop: TOP_GAP, paddingBottom: BOTTOM_GAP }}>
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
      <TurnRail items={railItems(runs)} scroller={scroller} column={content} topGap={TOP_GAP} reveal={reveal} sessionPath={session.sessionPath} />
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
/** How close to the end still counts as "at the end" (absorbs fractional scroll offsets). */
const END_SLACK = 1;

const distanceToEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight;

/**
 * Codex-style turn scrolling. Sending a message scrolls it to the top of the view and the answer
 * streams in below. Opening a session shows its end. While a run streams, the view follows it as
 * long as you are at the end (after sending, that is once the answer outgrows the view); scrolling
 * up stops that until you scroll back down or jump to the latest. A jump-to-latest button appears
 * when more content sits below the fold.
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
  /** You are at the end, so new output keeps you there. */
  const pinned = useRef(true);
  /** The newest run is live, so its growth is streaming output. */
  const following = useRef(false);
  /** Content height the view was last positioned for; only a change in it moves the view. */
  const measured = useRef(0);
  const lastScroll = useRef({ top: 0, height: 0 });
  const mounted = runs.length > 0;

  const settle = useCallback(
    (follow: boolean) => {
      const element = scroller.current;
      if (!element) return;
      const changed = element.scrollHeight !== measured.current;
      measured.current = element.scrollHeight;
      if (pinned.current && changed) {
        if (follow) element.scrollTop = element.scrollHeight;
        else pinned.current = distanceToEnd(element) <= END_SLACK; // e.g. you expanded a step at the end
      }
      setBelow(distanceToEnd(element) > 160);
    },
    [scroller],
  );

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const { scrollTop: top, scrollHeight: height } = element;
    // Moving up without the content shrinking is you scrolling up; shrinking content only clamps.
    if (top < lastScroll.current.top && height >= lastScroll.current.height) pinned.current = false;
    else if (distanceToEnd(element) <= END_SLACK) pinned.current = true;
    lastScroll.current = { top, height };
    setBelow(distanceToEnd(element) > 160);
  }, [scroller]);

  // Wheel input arrives before its scroll event, so streaming output cannot pull you back down first.
  const onWheel = useCallback((event: React.WheelEvent) => {
    if (event.deltaY < 0) pinned.current = false;
  }, []);

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

  return { viewport, jumped, restoreFromBottom, below, onScroll, onWheel, jumpToLatest };
}

/** Empty-state backdrop: the wallpaper picked in Settings (styles.css `.hero`), or nothing for none. While they loop,
 * each empty state shows the next one and keeps it while it is open. It picks again when the setting changes: at launch
 * the settings arrive from main after the first render. */
export function HeroBackdrop() {
  const picked = useApp((state) => state.settings.wallpaper);
  const loop = useApp((state) => state.settings.wallpaperLoop);
  const [shown, setShown] = useState(() => ({ picked, loop, id: loopWallpaper(picked, loop) }));
  if (shown.picked !== picked || shown.loop !== loop) setShown({ picked, loop, id: loopWallpaper(picked, loop) });
  const style = wallpaperStyle(shown.id);
  return style ? <div className="hero" style={style} aria-hidden /> : null;
}

function EmptyTranscript({ session }: { session: SessionState }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-end overflow-hidden px-8 pb-8">
      <HeroBackdrop />
      <div className="relative flex flex-col items-center">
        <h1 className="text-[26px] font-medium tracking-tight text-fg">What should we build?</h1>
        <div className="mt-2 font-mono text-[12px] text-faint">{tildify(session.cwd, window.studio.homeDir)}</div>
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
  const parts = userParts(message);
  const [withoutFiles, mentions] = splitFileMentions(parts.text);
  const [withoutCard, card] = splitCardBlock(withoutFiles);
  const [text, comments] = splitComments(withoutCard);
  const images = parts.images;
  const [expanded, setOpen] = useState(false);
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
          {images.map((image, index) => {
            const src = `data:${image.mimeType};base64,${image.data}`;
            return (
              <button key={index} type="button" onClick={() => openLightbox(src)} className="cursor-zoom-in">
                <img alt="" className="h-24 max-w-56 rounded-xl border border-line object-cover" src={src} />
              </button>
            );
          })}
        </div>
      )}
      {text && (
        <div className="flex w-full items-center justify-end gap-3">
          {stamp}
          <div data-user-bubble className="max-w-[78%] rounded-[22px] bg-raised px-5 py-3 text-[14.5px] leading-relaxed text-fg">
            <div className={`selectable whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-[14]" : ""}`}>{text}</div>
            {long && (
              <button type="button" onClick={() => setOpen(!expanded)} className="mt-1 text-[12px] text-muted hover:text-fg">
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
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
                className="flex max-w-72 items-center gap-1.5 rounded-lg border border-line bg-sunken px-2 py-1 font-mono text-[11.5px] text-muted"
              >
                <Icon size={12} className="shrink-0 text-faint" />
                <span className="truncate">{tildify(mention.path, window.studio.homeDir)}</span>
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
  const card = useApp((state) => state.board.cards.find((other) => other.id === mention.id));
  const chip = "flex max-w-72 items-center gap-1.5 rounded-lg border border-line bg-sunken px-2 py-1 text-[12px] text-muted";
  if (!card) {
    return (
      <span title="No longer on the board" className={chip}>
        <SquareKanban size={12} className="shrink-0 text-faint" />
        <span className="truncate">{mention.title}</span>
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

/** Time stamps are noise most of the time: shown while hovering their message, full date in the tooltip. */
function HoverStamp({ at, group }: { at: number; group: "user" | "answer" }) {
  const reveal = group === "user" ? "group-hover/user:opacity-100" : "group-hover/answer:opacity-100";
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
  const override = useApp((state) => state.expanded[id]);
  const all = useApp((state) => state.expandAll);
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
