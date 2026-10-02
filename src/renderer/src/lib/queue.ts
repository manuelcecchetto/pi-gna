// Editing pi's message queues. RPC can only clear both queues (returning their text) and append, so an
// edit is: clear, transform, re-queue in order. Items are matched by text, not position, because pi may
// deliver one while the edit is in flight.

export type QueueKind = "steering" | "followUp";

export interface Queues {
  steering: string[];
  followUp: string[];
}

export type QueueOp =
  /** Drop an item (trash), or take it out to edit in the composer. */
  | { type: "remove"; kind: QueueKind; text: string }
  /** Steer a queued follow-up now, or send a steer after the run instead. */
  | { type: "move"; kind: QueueKind; text: string };

export function applyQueueOp(queues: Queues, op: QueueOp): { queues: Queues; found: boolean } {
  const from = queues[op.kind];
  const index = from.indexOf(op.text);
  if (index === -1) return { queues, found: false };
  const rest = [...from.slice(0, index), ...from.slice(index + 1)];
  const next: Queues = { ...queues, [op.kind]: rest };
  if (op.type === "move") {
    const to: QueueKind = op.kind === "steering" ? "followUp" : "steering";
    next[to] = [...queues[to], op.text];
  }
  return { queues: next, found: true };
}
