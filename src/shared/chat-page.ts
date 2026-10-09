// Pages of a chat's transcript: what one holds, and the latest one a client keeps of a chat it does not show.
import type { SessionState } from "./session-state";
import { turnOutline } from "./turn-outline";

/** Turns in a page unless the caller asks for fewer (the phone opens a chat with a short first page). */
export const PAGE_TURNS = 40;
/** About the most a page holds: a few turns of screenshots or big tool output are megabytes (a long chat, 100 MB). */
export const PAGE_BYTES = 2_000_000;

/**
 * About the JSON size of a value (an item: with the runs of its tool calls), from its strings and keys: cheap next to
 * serializing it. An image block of `urlFrom` base64 characters or more counts as one (a phone gets it as a URL). A run
 * whose result main dropped (`ToolRun.evicted`) counts as that result, which a page brings back.
 */
export function jsonBytes(value: unknown, urlFrom = Number.POSITIVE_INFINITY): number {
  if (typeof value === "string") return value.length + 2;
  if (value === null || typeof value !== "object") return 8;
  if ((value as { type?: unknown }).type === "image") {
    const { data } = value as { data?: unknown };
    if (typeof data === "string" && data.length >= urlFrom) return 128;
  }
  let size = 2;
  if (Array.isArray(value)) for (const entry of value) size += jsonBytes(entry, urlFrom) + 1;
  else for (const [key, entry] of Object.entries(value)) size += key.length + 4 + (key === "evicted" && typeof entry === "number" ? entry : jsonBytes(entry, urlFrom));
  return size;
}

/**
 * The chat as opening it again shows it: the turns before its latest page (PAGE_TURNS turns, about PAGE_BYTES, the
 * newest turn always) leave it, a line each in `earlier`, and page in from the host again. The cut is always at a
 * turn's prompt, so the turns counted here stay the host's. The same state when nothing is before the latest page.
 */
export function toLatestPage(session: SessionState): SessionState {
  const { items } = session;
  const prompts = items.flatMap((item, index) => (item.kind === "user" && !item.steer ? [index] : []));
  let keep = prompts.length - 1;
  let size = 0;
  for (let turn = prompts.length - 1; turn >= 0; turn--) {
    const end = turn + 1 < prompts.length ? prompts[turn + 1]! : items.length;
    for (let index = prompts[turn]!; index < end; index++) size += jsonBytes(items[index]);
    if (prompts.length - turn > PAGE_TURNS || size > PAGE_BYTES) break;
    keep = turn;
  }
  if (keep <= 0) return session;
  const dropped = prompts.slice(0, keep).map((index) => turnOutline(items[index] as Extract<SessionState["items"][number], { kind: "user" }>));
  return { ...session, items: items.slice(prompts[keep]), earlier: [...(session.earlier ?? []), ...dropped], earlierOffset: undefined };
}
