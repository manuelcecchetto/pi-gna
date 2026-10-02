import {
  AlertTriangle,
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
  SquareTerminal,
} from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, TextContent, UserMessage } from "../../../shared/protocol";
import { splitFileMentions } from "../lib/attachments";
import { formatStamp, formatTokens, tildify } from "../lib/format";
import type { SessionState } from "../lib/session";
import { type Block, createRunDeriver, layoutRun, type Run } from "../lib/view";
import { openLightbox, prefill, setExpanded, useApp } from "../state/app";
import { WorkAccordion } from "./Activity";
import { Markdown } from "./Markdown";
import { PI_COLORS, PiLogo } from "./PiLogo";
import { Ansi } from "./primitives";

const PAGE = 30;

export function Transcript({ session }: { session: SessionState }) {
  const derive = useMemo(() => createRunDeriver(), []);
  const runs = derive(session);
  const [limit, setLimit] = useState(PAGE);
  const hidden = Math.max(0, runs.length - limit);
  const visible = hidden ? runs.slice(hidden) : runs;
  const home = window.studio.homeDir;

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  if (!runs.length && !session.running) return <EmptyTranscript session={session} />;

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-[800px] flex-col gap-10 px-8 pt-6 pb-10">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => {
              pinned.current = false;
              setLimit((value) => value + PAGE);
            }}
            className="self-center rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:text-fg"
          >
            Show {Math.min(hidden, PAGE)} earlier {hidden === 1 ? "turn" : "turns"}
          </button>
        )}
        {visible.map((run) => (
          <RunView key={run.key} run={run} cwd={session.cwd} home={home} status={run.live ? liveStatus(session) : undefined} />
        ))}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "Explain how this project is structured",
  "Review my uncommitted changes",
  "Find and fix a failing test",
  "Open the dev server in the browser and check the console",
];

// Deterministic "random" pixels for the backdrop.
const PIXELS = Array.from({ length: 14 }, (_, i) => ({
  left: `${8 + ((i * 37) % 84)}%`,
  top: `${22 + ((i * 53) % 62)}%`,
  size: 5 + ((i * 7) % 6),
  color: PI_COLORS[i % 3],
  delay: `${-((i * 1.7) % 11)}s`,
}));

export function HeroBackdrop() {
  return (
    <div className="hero" aria-hidden>
      <div className="hero-grid" />
      <div className="hero-glow" style={{ background: PI_COLORS[0], left: "calc(50% - 360px)", top: "14%" }} />
      <div className="hero-glow" style={{ background: PI_COLORS[1], left: "calc(50% - 90px)", top: "34%", animationDelay: "-7s" }} />
      <div className="hero-glow" style={{ background: PI_COLORS[2], left: "calc(50% + 40px)", top: "2%", opacity: 0.11, animationDelay: "-13s" }} />
      {PIXELS.map((pixel, index) => (
        <span
          key={index}
          className="hero-pixel"
          style={{ left: pixel.left, top: pixel.top, width: pixel.size, height: pixel.size, background: pixel.color, animationDelay: pixel.delay }}
        />
      ))}
    </div>
  );
}

function EmptyTranscript({ session }: { session: SessionState }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-8">
      <HeroBackdrop />
      <div className="relative flex flex-col items-center">
        <PiLogo size={68} animate />
        <h1 className="mt-7 text-[26px] font-medium tracking-tight text-fg">What should we build?</h1>
        <div className="mt-2 font-mono text-[12px] text-faint">{tildify(session.cwd, window.studio.homeDir)}</div>
        <div className="mt-9 flex max-w-[600px] flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => prefill(session.handle, suggestion)}
              className="rounded-full border border-line bg-panel/70 px-3.5 py-1.5 text-[12.5px] text-muted backdrop-blur hover:border-line-strong hover:text-fg"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Live states worth calling out next to "Working for…". */
function liveStatus(session: SessionState): string | undefined {
  if (session.dialogs.length) return "waiting for you";
  if (session.compacting) return "compacting context";
  if (session.retry) return `retrying (${session.retry.attempt}/${session.retry.maxAttempts})`;
  return undefined;
}

const RunView = memo(function RunView({ run, cwd, home, status }: { run: Run; cwd: string; home: string; status?: string }) {
  const layout = useMemo(() => layoutRun(run), [run]);
  const renderBlock = (block: Block) => <BlockView block={block} cwd={cwd} home={home} />;
  return (
    <section className="flex flex-col gap-4">
      {run.user && <UserMessageView message={run.user.message} />}
      {(layout.work.length > 0 || run.live) && (
        <WorkAccordion run={run} layout={layout} cwd={cwd} home={home} status={status} renderBlock={renderBlock} />
      )}
      {layout.final.map((block) => (
        <BlockView key={block.key} block={block} cwd={cwd} home={home} />
      ))}
      {!run.live && <AnswerFooter blocks={layout.final} />}
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

/** Your messages: a right-aligned bubble (no avatar), Codex-style, with a centred time stamp above. */
function UserMessageView({ message }: { message: UserMessage }) {
  const parts = userParts(message);
  const [withoutFiles, mentions] = splitFileMentions(parts.text);
  const [text, comments] = splitComments(withoutFiles);
  const images = parts.images;
  const [expanded, setOpen] = useState(false);
  const long = text.split("\n").length > 14 || text.length > 1400;
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="self-center pb-2 text-[12px] text-faint">{formatStamp(message.timestamp)}</div>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
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
        <div className="max-w-[78%] rounded-[22px] bg-raised px-5 py-3 text-[14.5px] leading-relaxed text-fg">
          <div className={`selectable whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-[14]" : ""}`}>{text}</div>
          {long && (
            <button type="button" onClick={() => setOpen(!expanded)} className="mt-1 text-[12px] text-muted hover:text-fg">
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
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
      <span>{formatStamp(last.at)}</span>
    </div>
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
      return <Markdown text={block.text} streaming={block.streaming} />;
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
        <div className="rounded-xl border border-line bg-panel px-3.5 py-2.5">
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-wide text-faint">{block.message.customType}</div>
          <Markdown text={text} />
        </div>
      );
    }
    case "compaction":
      return (
        <Disclosure id={block.key} icon={<FoldVertical size={13} />} label={`Context compacted · ${formatTokens(block.tokensBefore)} tokens summarized`} divider>
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
