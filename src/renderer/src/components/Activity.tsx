import {
  AppWindow,
  Bot,
  ChevronRight,
  CircleSlash,
  CornerDownRight,
  FilePen,
  FileText,
  Globe,
  type LucideIcon,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";
import { splitFileMentions, stripStudioBlocks } from "../lib/attachments";
import { formatClock, formatDuration } from "../lib/format";
import { userText } from "../lib/session";
import { type ToolCategory, presentTool, summarizeTools } from "../lib/tools";
import type { Block, Run, RunLayout, Step } from "../lib/view";
import { openLightbox, setExpanded, useApp } from "../state/app";
import { Markdown } from "./Markdown";
import { Elapsed, PixelLoader } from "./primitives";
import { resultImages, ToolDetails } from "./ToolDetails";

const ICONS: Record<ToolCategory, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  bash: SquareTerminal,
  search: Search,
  web: Globe,
  browser: AppWindow,
  agent: Bot,
  think: Sparkles,
  other: Wrench,
};

function useExpanded(key: string, fallback: boolean): boolean {
  const override = useApp((state) => state.expanded[key]);
  const all = useApp((state) => state.expandAll);
  return override ?? (all || fallback);
}

type ToolStep = Extract<Step, { kind: "tool" }>;

/**
 * Codex-style "Working for… / Worked for…" accordion holding everything before the final answer.
 * Open while working, closes itself once the answer streams or the run ends. Your toggle only
 * applies to the current phase, so the answer still collapses it. Closed while working, it shows
 * just the active (last) step.
 */
export const WorkAccordion = memo(function WorkAccordion({
  run,
  layout,
  cwd,
  home,
  status,
  renderBlock,
}: {
  run: Run;
  layout: RunLayout;
  cwd: string;
  home: string;
  status?: string;
  renderBlock: (block: Block) => ReactNode;
}) {
  const open = useExpanded(`work:${run.key}:${layout.settled ? "done" : "working"}`, !layout.settled);
  const steps = layout.work.flatMap((block) => (block.kind === "activity" ? block.steps : []));
  const tools = steps.filter((step): step is ToolStep => step.kind === "tool");
  const summary = useMemo(
    () =>
      summarizeTools(
        tools.map((step) => ({
          presentation: presentTool(step.call.name, step.call.arguments, cwd, step.run?.result?.details, home),
          failed: step.run?.status === "error" && step.run.result !== undefined,
        })),
      ),
    [tools, cwd, home],
  );
  const steers = steps.filter((step) => step.kind === "steer").length;
  const toggle = () => setExpanded(`work:${run.key}:${layout.settled ? "done" : "working"}`, !open);
  const started = layout.startedAt;
  const lastStep = steps.at(-1);

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="group flex w-full items-center gap-2 border-b border-line pb-2 text-left text-[13.5px]"
      >
        {run.live && <PixelLoader />}
        <span className={run.live ? "shimmer" : "text-muted group-hover:text-fg"}>
          {run.live ? "Working" : "Worked"}
          {started !== undefined && (
            <>
              {" for "}
              {run.live ? <Elapsed since={started} plain /> : formatClock((layout.endedAt ?? started) - started)}
            </>
          )}
        </span>
        {status && <span className="text-[12.5px] text-warn">· {status}</span>}
        {(summary || steers > 0) && (
          <span className="min-w-0 truncate text-[12.5px] text-faint">
            · {[summary, steers ? `steered ${steers === 1 ? "once" : `${steers} times`}` : ""].filter(Boolean).join(" · ")}
          </span>
        )}
        <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open ? (
        <div className="mt-3 flex flex-col gap-2.5">
          {layout.work.map((block) =>
            block.kind === "activity" ? (
              <div key={block.key} className="flex flex-col gap-0.5">
                {block.steps.map((step) => (
                  <StepView key={step.key} step={step} cwd={cwd} home={home} live={run.live} />
                ))}
              </div>
            ) : block.kind === "text" ? (
              <div key={block.key} className="text-fg [&_.prose]:text-[14px]">
                <Markdown text={block.text} streaming={block.streaming} />
              </div>
            ) : (
              <div key={block.key}>{renderBlock(block)}</div>
            ),
          )}
        </div>
      ) : run.live ? (
        lastStep && (
          <div className="mt-1">
            <StepView step={lastStep} cwd={cwd} home={home} live />
          </div>
        )
      ) : (
        <InlineImages images={tools.flatMap((step) => resultImages(step.run?.result ?? step.run?.partial))} />
      )}
    </div>
  );
});

function StepView({ step, cwd, home, live }: { step: Step; cwd: string; home: string; live: boolean }) {
  if (step.kind === "thinking") return <ThinkingStep step={step} />;
  if (step.kind === "steer") return <SteerStep step={step} />;
  return <ToolRow step={step} cwd={cwd} home={home} live={live} />;
}

/** Thinking reads like pi's terminal: the whole text inline, italic and muted, no label or toggle. */
function ThinkingStep({ step }: { step: Extract<Step, { kind: "thinking" }> }) {
  if (!step.text.trim()) {
    return step.redacted ? <div className="px-1.5 py-1 text-[12.5px] text-faint italic">Thinking (redacted)</div> : null;
  }
  return (
    <div className="thinking px-1.5 py-1.5">
      <Markdown text={step.text} streaming={step.streaming} />
    </div>
  );
}

/** A message you steered into the running turn: part of the work, not a new turn. */
function SteerStep({ step }: { step: Extract<Step, { kind: "steer" }> }) {
  const open = useExpanded(step.key, false);
  const [withoutFiles, mentions] = splitFileMentions(userText(step.message));
  const shown = stripStudioBlocks(withoutFiles);
  const images = typeof step.message.content === "string" ? [] : step.message.content.filter((block) => block.type === "image");
  const long = shown.length > 280 || shown.split("\n").length > 4;
  return (
    <div title="You steered" className="my-1.5 flex gap-2.5 rounded-xl border border-line bg-raised/50 px-3 py-2">
      <CornerDownRight size={14} className="mt-[3px] shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className={`selectable whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-fg ${long && !open ? "line-clamp-4" : ""}`}>{shown}</div>
        {long && (
          <button type="button" onClick={() => setExpanded(step.key, !open)} className="mt-0.5 text-[12px] text-muted hover:text-fg">
            {open ? "Show less" : "Show more"}
          </button>
        )}
        {(images.length > 0 || mentions.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {images.map((image, index) =>
              image.type === "image" ? (
                <button key={index} type="button" onClick={() => openLightbox(`data:${image.mimeType};base64,${image.data}`)} className="cursor-zoom-in">
                  <img alt="" src={`data:${image.mimeType};base64,${image.data}`} className="h-12 max-w-28 rounded-md border border-line object-cover" />
                </button>
              ) : null,
            )}
            {mentions.map((mention) => (
              <span key={mention.path} title={mention.path} className="max-w-56 truncate rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {mention.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolRow({ step, cwd, home, live }: { step: Extract<Step, { kind: "tool" }>; cwd: string; home: string; live: boolean }) {
  const open = useExpanded(step.key, false);
  const { call, run } = step;
  const presentation = presentTool(call.name, call.arguments, cwd, run?.result?.details, home);
  const Icon = ICONS[presentation.category];
  const interrupted = !run ? !live && !step.argsStreaming : run.status === "error" && !run.result;
  const running = step.argsStreaming || (live && (!run || run.status === "running"));
  const failed = run?.status === "error" && !interrupted;
  const verb = running ? presentation.activeVerb : presentation.verb;
  const elapsed = run?.startedAt && run.endedAt ? run.endedAt - run.startedAt : 0;
  const duration = elapsed >= 100 ? formatDuration(elapsed) : undefined;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(step.key, !open)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[13px] hover:bg-raised/60"
      >
        {running ? (
          <PixelLoader />
        ) : interrupted ? (
          <CircleSlash size={13} className="shrink-0 text-faint" />
        ) : (
          <Icon size={13} className={`shrink-0 ${failed ? "text-bad" : "text-faint"}`} />
        )}
        <span className={`shrink-0 ${failed ? "text-bad" : running ? "shimmer" : "text-fg/90"}`}>{verb}</span>
        {presentation.target && <span className="min-w-0 truncate font-mono text-[12px] text-muted">{presentation.target}</span>}
        {presentation.meta && <span className="shrink-0 font-mono text-[11px] text-faint">{presentation.meta}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-[11px] text-faint">
          {interrupted && "interrupted"}
          {failed && "failed"}
          {duration && !running && <span className="opacity-0 group-hover:opacity-100">{duration}</span>}
          <ChevronRight size={12} className={`transition ${open ? "rotate-90" : "opacity-0 group-hover:opacity-100"}`} />
        </span>
      </button>
      <InlineImages images={resultImages(run?.result ?? run?.partial)} />
      {open && <ToolDetails call={call} run={run} />}
    </div>
  );
}

/** Tool-result images render inline, like pi's terminal does; click for full size. */
function InlineImages({ images }: { images: ReturnType<typeof resultImages> }) {
  if (!images.length) return null;
  return (
    <div className="mt-1 mb-1.5 flex flex-wrap gap-2 pl-7">
      {images.map((image, index) => {
        const src = `data:${image.mimeType};base64,${image.data}`;
        return (
          <button key={index} type="button" onClick={() => openLightbox(src)} className="cursor-zoom-in">
            <img alt="" src={src} className="max-h-56 max-w-[min(100%,460px)] rounded-lg border border-line object-contain" />
          </button>
        );
      })}
    </div>
  );
}
