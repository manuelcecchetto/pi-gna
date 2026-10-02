// Transcript view model: items -> runs (one per user message) -> blocks. Consecutive thinking
// and tool calls merge into one activity group so a long agent loop reads as a single line.
import type { BashExecutionMessage, CustomMessage, ToolCall, UserMessage } from "../../../shared/protocol";
import type { Item, SessionState, ToolRun } from "./session";

export type Step =
  | { kind: "thinking"; key: string; text: string; redacted: boolean; streaming: boolean; durationMs?: number }
  | { kind: "tool"; key: string; call: ToolCall; run?: ToolRun; argsStreaming: boolean };

export type Block =
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | { kind: "activity"; key: string; steps: Step[]; live: boolean }
  | { kind: "error"; key: string; text: string }
  | { kind: "aborted"; key: string }
  | { kind: "bash"; key: string; message: BashExecutionMessage }
  | { kind: "custom"; key: string; message: CustomMessage }
  | { kind: "compaction"; key: string; summary: string; tokensBefore: number }
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
  tools: (ToolRun | undefined)[];
  live: boolean;
  run: Run;
}

/**
 * Derive runs, reusing the previous Run object when none of its inputs changed so memoized
 * components skip finished history while the live run streams.
 */
export function createRunDeriver(): (state: Pick<SessionState, "items" | "tools" | "running">) => Run[] {
  let cache = new Map<string, CacheEntry>();
  return (state) => {
    const slices = sliceRuns(state.items);
    const nextCache = new Map<string, CacheEntry>();
    const runs = slices.map((items, index) => {
      const live = state.running && index === slices.length - 1;
      const key = items[0]?.key ?? "empty";
      const tools = toolIds(items).map((id) => state.tools[id]);
      const previous = cache.get(key);
      const run =
        previous && previous.live === live && sameRefs(previous.items, items) && sameRefs(previous.tools, tools)
          ? previous.run
          : buildRun(key, items, state.tools, live);
      nextCache.set(key, { items, tools, live, run });
      return run;
    });
    cache = nextCache;
    return runs;
  };
}

export function deriveRuns(state: Pick<SessionState, "items" | "tools" | "running">): Run[] {
  return createRunDeriver()(state);
}

function sliceRuns(items: Item[]): Item[][] {
  const slices: Item[][] = [];
  for (const item of items) {
    if (item.kind === "user" || slices.length === 0) slices.push([item]);
    else slices[slices.length - 1]?.push(item);
  }
  return slices;
}

function toolIds(items: Item[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    for (const block of item.message.content) if (block.type === "toolCall") ids.push(block.id);
  }
  return ids;
}

function sameRefs<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildRun(key: string, items: Item[], tools: Record<string, ToolRun>, live: boolean): Run {
  const blocks: Block[] = [];
  let user: Run["user"];
  let group: Extract<Block, { kind: "activity" }> | undefined;
  const close = () => {
    group = undefined;
  };
  const addStep = (step: Step) => {
    if (!group) {
      // Prefixed: the group and its first step have separate expanded state.
      group = { kind: "activity", key: `group:${step.key}`, steps: [], live: false };
      blocks.push(group);
    }
    group.steps.push(step);
  };

  for (const item of items) {
    switch (item.kind) {
      case "user":
        user = { key: item.key, message: item.message };
        break;
      case "assistant": {
        const { message, streaming } = item;
        message.content.forEach((block, index) => {
          const blockKey = `${item.key}:${index}`;
          const time = item.times?.[index];
          if (block.type === "text") {
            if (!block.text.trim()) return;
            close();
            blocks.push({ kind: "text", key: blockKey, text: block.text, streaming: streaming && time?.end === undefined });
          } else if (block.type === "thinking") {
            const blockStreaming = streaming && time !== undefined && time.end === undefined;
            if (!block.thinking.trim() && !block.redacted && !blockStreaming) return;
            addStep({
              kind: "thinking",
              key: blockKey,
              text: block.thinking,
              redacted: Boolean(block.redacted),
              streaming: blockStreaming,
              durationMs: time?.end !== undefined ? time.end - time.start : undefined,
            });
          } else if (block.type === "toolCall") {
            addStep({ kind: "tool", key: blockKey, call: block, run: tools[block.id], argsStreaming: Boolean(item.partialArgs && index in item.partialArgs) });
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
        blocks.push({ kind: "compaction", key: item.key, summary: item.summary, tokensBefore: item.tokensBefore });
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
