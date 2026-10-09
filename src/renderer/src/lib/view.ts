// Transcript view model: items -> runs (one per user message) -> blocks. Consecutive thinking
// and tool calls merge into one activity group so a long agent loop reads as a single line.
import type { BashExecutionMessage, CustomMessage, StopReason, ToolCall, UserMessage } from "../../../shared/protocol";
import type { CompactionItem, Item, SessionState, ToolRun } from "../../../shared/session-state";

export type Step =
  | { kind: "thinking"; key: string; text: string; redacted: boolean; streaming: boolean; durationMs?: number }
  | { kind: "tool"; key: string; call: ToolCall; run?: ToolRun; argsStreaming: boolean }
  /** A message you steered into the running turn. */
  | { kind: "steer"; key: string; message: UserMessage };

export type Block =
  | { kind: "text"; key: string; text: string; streaming: boolean; at: number; stopReason: StopReason }
  | { kind: "activity"; key: string; steps: Step[]; live: boolean; at: number }
  | { kind: "error"; key: string; text: string }
  | { kind: "aborted"; key: string }
  | { kind: "bash"; key: string; message: BashExecutionMessage }
  | { kind: "custom"; key: string; message: CustomMessage }
  | CompactionItem
  | { kind: "branch"; key: string; summary: string }
  | { kind: "notice"; key: string; level: "info" | "error"; text: string };

export interface Run {
  key: string;
  user?: { key: string; message: UserMessage };
  blocks: Block[];
  live: boolean;
}

interface CacheEntry {
  items: Item[];
  live: boolean;
  run: Run;
}

/**
 * Derive runs, reusing the previous Run object when none of its items changed so memoized
 * components skip finished history while the live run streams. Tool runs are on the items that
 * made the calls, so a tool update changes its own item and run only.
 */
export function createRunDeriver(): (state: Pick<SessionState, "items" | "running">) => Run[] {
  let cache = new Map<string, CacheEntry>();
  return (state) => {
    const slices = sliceRuns(state.items);
    const nextCache = new Map<string, CacheEntry>();
    const runs = slices.map((items, index) => {
      const live = state.running && index === slices.length - 1;
      const key = items[0]?.key ?? "empty";
      const previous = cache.get(key);
      const run = previous && previous.live === live && sameRefs(previous.items, items) ? previous.run : buildRun(key, items, live);
      nextCache.set(key, { items, live, run });
      return run;
    });
    cache = nextCache;
    return runs;
  };
}

export function deriveRuns(state: Pick<SessionState, "items" | "running">): Run[] {
  return createRunDeriver()(state);
}

function sliceRuns(items: Item[]): Item[][] {
  const slices: Item[][] = [];
  for (const item of items) {
    // Steers continue the turn they were delivered into; only real prompts start a new run.
    if ((item.kind === "user" && !item.steer) || slices.length === 0) slices.push([item]);
    else slices[slices.length - 1]?.push(item);
  }
  return slices;
}

function sameRefs<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildRun(key: string, items: Item[], live: boolean): Run {
  const blocks: Block[] = [];
  let user: Run["user"];
  let group: Extract<Block, { kind: "activity" }> | undefined;
  const close = () => {
    group = undefined;
  };
  const addStep = (step: Step, at: number) => {
    if (!group) {
      // Prefixed: the group and its first step have separate expanded state.
      group = { kind: "activity", key: `group:${step.key}`, steps: [], live: false, at };
      blocks.push(group);
    }
    group.steps.push(step);
    const ended = step.kind === "tool" ? step.run?.endedAt : undefined;
    group.at = Math.max(group.at, at, ended ?? 0);
  };

  for (const item of items) {
    switch (item.kind) {
      case "user":
        if (item.steer || user) addStep({ kind: "steer", key: item.key, message: item.message }, item.message.timestamp);
        else user = { key: item.key, message: item.message };
        break;
      case "assistant": {
        const { message, streaming } = item;
        message.content.forEach((block, index) => {
          const blockKey = `${item.key}:${index}`;
          const time = item.times?.[index];
          if (block.type === "text") {
            if (!block.text.trim()) return;
            close();
            blocks.push({
              kind: "text",
              key: blockKey,
              text: block.text,
              streaming: streaming && time?.end === undefined,
              at: time?.start ?? message.timestamp,
              stopReason: message.stopReason,
            });
          } else if (block.type === "thinking") {
            const blockStreaming = streaming && time !== undefined && time.end === undefined;
            if (!block.thinking.trim() && !block.redacted && !blockStreaming) return;
            addStep(
              {
                kind: "thinking",
                key: blockKey,
                text: block.thinking,
                redacted: Boolean(block.redacted),
                streaming: blockStreaming,
                durationMs: time?.end !== undefined ? time.end - time.start : undefined,
              },
              time?.end ?? message.timestamp,
            );
          } else if (block.type === "toolCall") {
            addStep(
              { kind: "tool", key: blockKey, call: block, run: item.runs?.[block.id], argsStreaming: Boolean(item.partialArgs && index in item.partialArgs) },
              message.timestamp,
            );
          }
        });
        if (message.stopReason === "error") {
          close();
          blocks.push({ kind: "error", key: `${item.key}:error`, text: message.errorMessage ?? "The model returned an error." });
        } else if (message.stopReason === "aborted") {
          close();
          blocks.push({ kind: "aborted", key: `${item.key}:aborted` });
        }
        break;
      }
      case "bash":
      case "custom":
        close();
        blocks.push({ kind: item.kind, key: item.key, message: item.message } as Block);
        break;
      case "compaction":
        close();
        blocks.push(item);
        break;
      case "branch":
        close();
        blocks.push({ kind: "branch", key: item.key, summary: item.summary });
        break;
      case "notice":
        close();
        blocks.push({ kind: "notice", key: item.key, level: item.level, text: item.text });
        break;
    }
  }
  const last = blocks.at(-1);
  if (live && last?.kind === "activity") last.live = true;
  return { key, user, blocks, live };
}

/** Trailing text this long while streaming is treated as the final answer even before the turn ends. */
const FINAL_TEXT_CHARS = 300;

export interface RunLayout {
  /** Everything up to the last thinking/tool activity: commentary, steps, notices. */
  work: Block[];
  /** The answer after the last activity (plus trailing errors or notices). */
  final: Block[];
  /** The final answer is streaming or done; the work accordion closes itself from here. */
  settled: boolean;
  startedAt?: number;
  /** When the work ended: the final answer's start, else the last activity. */
  endedAt?: number;
}

/**
 * Split a run into the "Working/Worked for" accordion and the final answer. A trailing text block
 * only counts as final once its message stopped (not toolUse) or it is clearly an answer by length,
 * so a short "Let me check…" before the next tool call does not collapse the accordion.
 */
export function layoutRun(run: Run): RunLayout {
  let last = -1;
  run.blocks.forEach((block, index) => {
    if (block.kind === "activity") last = index;
  });
  const work = run.blocks.slice(0, last + 1);
  const final = run.blocks.slice(last + 1);
  const texts = final.filter((block): block is Extract<Block, { kind: "text" }> => block.kind === "text");
  const answered = texts.some(
    (block) => (!block.streaming && block.stopReason !== "toolUse" && block.stopReason !== "pending") || block.text.length > FINAL_TEXT_CHARS,
  );
  const lastWork = work.at(-1);
  return {
    work,
    final,
    settled: !run.live || answered,
    startedAt: run.user?.message.timestamp,
    endedAt: Math.max(texts[0]?.at ?? 0, lastWork && "at" in lastWork ? lastWork.at : 0) || undefined,
  };
}

/** A break this long before a message (or a new day) gets a centered time divider: "I came back to this". */
export const DIVIDER_GAP_MS = 60 * 60_000;

/** Latest known time in a run: its message or any timed answer/activity block. */
export function runEnd(run: Run): number | undefined {
  let end = run.user?.message.timestamp;
  for (const block of run.blocks) {
    if ("at" in block && block.at > (end ?? 0)) end = block.at;
  }
  return end;
}

export function needsTimeDivider(previous: Run | undefined, run: Run): boolean {
  const at = run.user?.message.timestamp;
  if (at === undefined) return false;
  const before = previous ? runEnd(previous) : undefined;
  if (before === undefined) return true; // the first message anchors the transcript in time
  return at - before >= DIVIDER_GAP_MS || new Date(at).toDateString() !== new Date(before).toDateString();
}
