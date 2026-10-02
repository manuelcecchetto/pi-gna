// Turn rail model (Codex's "user message navigation rail"): one marker per message you sent, with a
// hover preview of that turn's answer.
import type { TextContent } from "../../../shared/protocol";
import { splitFileMentions, stripStudioBlocks } from "./attachments";
import { layoutRun, type Run } from "./view";

export interface RailItem {
  /** The run key (`data-run` on its section). */
  key: string;
  /** When you sent it; also the bookmark identity, because item keys are not stable across reopening. */
  at: number;
  /** Your message on one line. */
  label: string;
  /** The final answer's markdown, an error or "Interrupted"; empty while there is none yet. */
  preview: string;
  live: boolean;
}

/** Codex shows the rail from four messages on: fewer fit on screen anyway. */
export const RAIL_MIN_ITEMS = 4;

const cache = new WeakMap<Run, RailItem>();

/** Runs stay the same objects while unchanged (createRunDeriver), so only the live one is rebuilt. */
export function railItems(runs: Run[]): RailItem[] {
  return runs.flatMap((run) => {
    if (!run.user) return [];
    let item = cache.get(run);
    if (!item) {
      item = { key: run.key, at: run.user.message.timestamp, label: railLabel(run), preview: railPreview(run), live: run.live };
      cache.set(run, item);
    }
    return [item];
  });
}

function railLabel(run: Run): string {
  const content = run.user?.message.content ?? "";
  const raw = typeof content === "string" ? content : content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
  const text = stripStudioBlocks(raw).replace(/\s+/g, " ").trim();
  if (text) return text;
  const mentions = splitFileMentions(raw)[1];
  if (mentions.length) return mentions.map((mention) => mention.label).join(", ");
  const images = typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
  return images > 1 ? `${images} images` : images ? "Image" : "(No content)";
}

function railPreview(run: Run): string {
  const { final } = layoutRun(run);
  const text = final.flatMap((block) =>
    block.kind === "text" || block.kind === "error" ? [block.text] : block.kind === "aborted" ? ["*Interrupted*"] : [],
  );
  return text.join("\n\n").trim();
}

/** Distance from the hovered or scrubbed marker, for the dock-style magnification (0-3, else none). */
export function nearDistance(index: number, hot: number | null): number | undefined {
  if (hot === null) return undefined;
  const distance = Math.abs(index - hot);
  return distance <= 3 ? distance : undefined;
}

/** Within this many px of the jump position a message counts as "at the top". */
const AT_TOP = 24;

/**
 * ⌥↑/⌥↓ target, Codex's rule. `tops` are each message's distance below the jump position (null when the
 * turn is not rendered, i.e. an earlier page). Down: the first message below the top. Up: the start of the
 * turn you are reading, or the previous turn when you are already at its start.
 */
export function adjacentTurn(tops: (number | null)[], direction: "previous" | "next"): number | undefined {
  if (direction === "next") {
    const index = tops.findIndex((top) => top !== null && top > AT_TOP);
    return index === -1 ? undefined : index;
  }
  for (let index = tops.length - 1; index >= 0; index--) {
    const top = tops[index];
    if (top === null || top === undefined) return index; // everything above is on an earlier page
    if (Math.abs(top) <= AT_TOP) return index > 0 ? index - 1 : undefined;
    if (top < 0) return index;
  }
  return undefined;
}
