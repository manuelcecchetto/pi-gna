import {
  AppWindow,
  Bot,
  ChevronRight,
  CircleSlash,
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
import { formatClock, formatDuration } from "../lib/format";
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
        {summary && <span className="min-w-0 truncate text-[12.5px] text-faint">· {summary}</span>}
        <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>

      {open ? (
        <div className="mt-3 flex flex-col gap-2.5">
          {layout.work.map((block) =>
            block.kind === "activity" ? (
              <div key={block.key} className="flex flex-col gap-0.5">
                {block.steps.map((step) =>
                  step.kind === "thinking" ? (
                    <ThinkingStep key={step.key} step={step} />
                  ) : (
                    <ToolRow key={step.key} step={step} cwd={cwd} home={home} live={run.live} />
                  ),
                )}
              </div>
            ) : block.kind === "text" ? (
              <div key={block.key} className="text-muted [&_.prose]:text-[14px]">
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
            {lastStep.kind === "thinking" ? <ThinkingStep step={lastStep} /> : <ToolRow step={lastStep} cwd={cwd} home={home} live />}
          </div>
        )
      ) : (
        <InlineImages images={tools.flatMap((step) => resultImages(step.run?.result ?? step.run?.partial))} />
      )}
    </div>
  );
});

function ThinkingStep({ step }: { step: Extract<Step, { kind: "thinking" }> }) {
  const open = useExpanded(step.key, false);
  const label = step.streaming
    ? "Thinking"
    : step.redacted && !step.text
      ? "Thinking (redacted)"
      : step.durationMs
        ? `Thought for ${formatDuration(step.durationMs)}`
        : "Thought";
  const tail = step.streaming && !open ? step.text.slice(-280) : "";
  return (
    <div>
      <button
        type="button"
        disabled={!step.text}
        onClick={() => setExpanded(step.key, !open)}
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[13px] text-muted enabled:hover:text-fg"
      >
        <Sparkles size={13} className="shrink-0 text-faint" />
        <span className={step.streaming ? "shimmer" : ""}>{label}</span>
        {step.text && <ChevronRight size={12} className={`text-faint opacity-0 transition group-hover:opacity-100 ${open ? "rotate-90 opacity-100" : ""}`} />}
      </button>
      {tail && <p className="line-clamp-3 px-1.5 pb-1 pl-7 text-[12.5px] leading-relaxed text-faint">{tail}</p>}
      {open && <p className="selectable max-h-80 overflow-auto whitespace-pre-wrap px-1.5 pb-2 pl-7 text-[12.5px] leading-relaxed text-muted">{step.text}</p>}
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
