import { AlertTriangle, ChevronRight, CircleSlash, FoldVertical, GitBranch, SquareTerminal } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, TextContent, UserMessage } from "../../../shared/protocol";
import { formatTokens } from "../lib/format";
import type { SessionState } from "../lib/session";
import { presentTool } from "../lib/tools";
import { type Block, createRunDeriver, type Run } from "../lib/view";
import { setExpanded, useApp } from "../state/app";
import { ActivityGroup } from "./Activity";
import { Markdown } from "./Markdown";
import { Ansi, Elapsed, PixelLoader } from "./primitives";

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

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-[800px] flex-col gap-7 px-8 pt-6 pb-10">
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
          <RunView key={run.key} run={run} cwd={session.cwd} home={home} />
        ))}
        {session.running && <LiveIndicator session={session} runs={runs} />}
        {!runs.length && !session.running && <EmptyTranscript session={session} />}
      </div>
    </div>
  );
}

function EmptyTranscript({ session }: { session: SessionState }) {
  return (
    <div className="mt-[18vh] flex flex-col items-center gap-3 text-center">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">pi</div>
      <div className="text-[22px] font-medium tracking-tight text-fg">What should we build?</div>
      <div className="font-mono text-[12px] text-faint">{session.cwd.replace(window.studio.homeDir, "~")}</div>
    </div>
  );
}

function liveLabel(session: SessionState, runs: Run[]): string {
  if (session.dialogs.length) return "Waiting for you";
  if (session.compacting) return "Compacting context";
  if (session.retry) return `Retrying (${session.retry.attempt}/${session.retry.maxAttempts})`;
  const last = runs.at(-1)?.blocks.at(-1);
  if (last?.kind === "activity") {
    const step = last.steps.at(-1);
    if (step?.kind === "thinking") return step.streaming ? "Thinking" : "Working";
    if (step?.kind === "tool") {
      const presentation = presentTool(step.call.name, step.call.arguments, session.cwd);
      if (step.argsStreaming) return `Preparing ${step.call.name}`;
      if (!step.run || step.run.status === "running") return presentation.activeVerb;
    }
  }
  if (last?.kind === "text" && last.streaming) return "Writing";
  return "Working";
}

function LiveIndicator({ session, runs }: { session: SessionState; runs: Run[] }) {
  return (
    <div className="-mt-3 flex items-center gap-2.5 text-[13px]">
      <PixelLoader />
      <span className="shimmer">{liveLabel(session, runs)}</span>
      {session.runStartedAt && <Elapsed since={session.runStartedAt} />}
    </div>
  );
}

const RunView = memo(function RunView({ run, cwd, home }: { run: Run; cwd: string; home: string }) {
  return (
    <section className="flex flex-col gap-3.5">
      {run.user && <UserBubble message={run.user.message} />}
      {run.blocks.map((block) => (
        <BlockView key={block.key} block={block} cwd={cwd} home={home} />
      ))}
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

function UserBubble({ message }: { message: UserMessage }) {
  const { text, images } = userParts(message);
  const [expanded, setOpen] = useState(false);
  const long = text.split("\n").length > 14 || text.length > 1400;
  return (
    <div className="flex flex-col items-end gap-2">
      {images.length > 0 && (
        <div className="flex gap-2">
          {images.map((image, index) => (
            <img key={index} alt="" className="h-20 rounded-lg border border-line object-cover" src={`data:${image.mimeType};base64,${image.data}`} />
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[14.5px] leading-relaxed">
          <div className={`selectable whitespace-pre-wrap break-words ${long && !expanded ? "line-clamp-[14]" : ""}`}>{text}</div>
          {long && (
            <button type="button" onClick={() => setOpen(!expanded)} className="mt-1 text-[12px] text-muted hover:text-fg">
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BlockView({ block, cwd, home }: { block: Block; cwd: string; home: string }) {
  switch (block.kind) {
    case "text":
      return <Markdown text={block.text} streaming={block.streaming} />;
    case "activity":
      return <ActivityGroup block={block} cwd={cwd} home={home} />;
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
