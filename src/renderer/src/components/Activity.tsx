import {
  AppWindow,
  Bot,
  ChevronRight,
  CircleSlash,
  FilePen,
  FileText,
  Globe,
  Layers,
  type LucideIcon,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { memo, useMemo } from "react";
import { formatDuration } from "../lib/format";
import { type ToolCategory, presentTool, summarizeTools } from "../lib/tools";
import type { Block, Step } from "../lib/view";
import { openLightbox, setExpanded, useApp } from "../state/app";
import { PixelLoader } from "./primitives";
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

type ActivityBlock = Extract<Block, { kind: "activity" }>;

function thinkingTime(steps: Step[]): number {
  return steps.reduce((total, step) => total + (step.kind === "thinking" ? (step.durationMs ?? 0) : 0), 0);
}

export const ActivityGroup = memo(function ActivityGroup({ block, cwd, home }: { block: ActivityBlock; cwd: string; home: string }) {
  const open = useExpanded(block.key, block.live);
  const tools = block.steps.filter((step): step is Extract<Step, { kind: "tool" }> => step.kind === "tool");
  const summary = useMemo(() => {
    const tools = block.steps.filter((step): step is Extract<Step, { kind: "tool" }> => step.kind === "tool");
    const toolSummary = summarizeTools(
      tools.map((step) => ({
        presentation: presentTool(step.call.name, step.call.arguments, cwd, step.run?.result?.details, home),
        failed: step.run?.status === "error" && step.run.result !== undefined,
      })),
    );
    if (toolSummary) return toolSummary;
    if (block.steps.some((step) => step.kind === "thinking" && step.streaming)) return "Thinking";
    const ms = thinkingTime(block.steps);
    return ms ? `Thought for ${formatDuration(ms)}` : "Thought";
  }, [block.steps, cwd, home]);
  const Icon = tools.length ? Layers : Sparkles;

  return (
    <div className="-mx-2">
      <button
        type="button"
        onClick={() => setExpanded(block.key, !open)}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-muted hover:bg-raised/60 hover:text-fg"
      >
        <Icon size={14} className="shrink-0 text-faint group-hover:text-muted" />
        <span className="truncate">{summary}</span>
        {tools.length > 1 && summary.includes("·") && <span className="font-mono text-[11px] text-faint">{tools.length}</span>}
        <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {!open && <InlineImages images={tools.flatMap((step) => resultImages(step.run?.result ?? step.run?.partial))} />}
      {open && (
        <div className="ml-[15px] mt-1 flex flex-col gap-0.5 border-l border-dashed border-line-strong pl-3">
          {block.steps.map((step) =>
            step.kind === "thinking" ? (
              <ThinkingStep key={step.key} step={step} />
            ) : (
              <ToolRow key={step.key} step={step} cwd={cwd} home={home} live={block.live} />
            ),
          )}
        </div>
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
