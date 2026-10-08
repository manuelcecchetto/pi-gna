// Streaming deltas of one chat wait in main for about a frame and go out merged (session-host.ts `push`), so a fast
// model costs one reduce, one ring entry, one IPC send and one SSE frame per frame instead of one per stdout chunk.
import type { HostEvent } from "../shared/host-api";
import type { AssistantMessageEvent, SessionEvent } from "../shared/protocol";

/** How long deltas wait for more: about a frame. Any other event sends them at once, ahead of it. */
export const COALESCE_MS = 16;

type Delta = {
  kind: "rpc";
  record: Extract<SessionEvent, { type: "message_update" }> & { assistantMessageEvent: Extract<AssistantMessageEvent, { delta: string }> };
};

/** A text, thinking or tool-call delta: the only events that may wait. */
export function isDelta(event: HostEvent): event is Delta {
  if (event.kind !== "rpc" || event.record.type !== "message_update") return false;
  const { type } = event.record.assistantMessageEvent;
  return type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta";
}

/**
 * Merges consecutive deltas of one block (same kind and `contentIndex`) into one, in order. The merged event is the
 * later one with the texts joined, so it carries the newer usage; it reduces to the state the events it replaces do.
 */
export function coalesce(events: HostEvent[]): HostEvent[] {
  const out: HostEvent[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if (last && isDelta(last) && isDelta(event)) {
      const a = last.record.assistantMessageEvent;
      const b = event.record.assistantMessageEvent;
      if (a.type === b.type && a.contentIndex === b.contentIndex) {
        const usage = event.record.usage ?? last.record.usage;
        out[out.length - 1] = { ...event, record: { ...event.record, ...(usage && { usage }), assistantMessageEvent: { ...b, delta: a.delta + b.delta } } };
        continue;
      }
    }
    out.push(event);
  }
  return out;
}
