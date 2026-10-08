// Turn rail model (Codex's "user message navigation rail"): one marker per message you sent, with a
// hover preview of that turn's answer.
import type { SessionState } from "../../../shared/session-state";
import { type TurnOutline, turnLabel } from "../../../shared/turn-outline";
import { deriveRuns, layoutRun, type Run } from "./view";

export interface RailItem {
  /** The run key (`data-run` on its section). */
  key: string;
  /** When you sent it; also the bookmark identity, because item keys are not stable across reopening. */
  at: number;
  /** Your message on one line. */
  label: string;
  /** The final answer's markdown, an error or "Interrupted"; empty while there is none yet. */
  preview: string;
  /** A turn on a page the client has not loaded: its preview comes from the host when the card shows. */
  loadPreview?: () => Promise<string>;
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
      item = { key: run.key, at: run.user.message.timestamp, label: turnLabel(run.user.message.content), preview: railPreview(run), live: run.live };
      cache.set(run, item);
    }
    return [item];
  });
}

const outlined = new WeakMap<TurnOutline[], RailItem[]>();

/** Markers for the turns before the loaded ones (`SessionState.earlier`); `preview` fetches the answer of turn `index`. */
export function outlineItems(outline: TurnOutline[], preview?: (index: number) => Promise<string>): RailItem[] {
  let items = outlined.get(outline);
  if (!items) {
    items = outline.map((turn, index) => ({ key: turn.key, at: turn.at, label: turn.label, preview: "", loadPreview: preview && (() => preview(index)), live: false }));
    outlined.set(outline, items);
  }
  return items;
}

/** The preview of the turn a one-turn page holds (`pageSession(handle, index + 1, 1)`). */
export function pagePreview(page: Pick<SessionState, "items" | "tools">): string {
  const run = deriveRuns({ ...page, running: false }).findLast((candidate) => candidate.user);
  return run ? railPreview(run) : "";
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
