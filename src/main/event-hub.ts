import { randomBytes } from "node:crypto";
import { RING_MAX_BYTES, RING_MAX_EVENTS, formatEventId, planReplay } from "../shared/host-api";
import type { Topic } from "../shared/host-api";

/** A pushed event; `event` is a `HostEvent` on `chat:<handle>` topics and a `GlobalEvent` on `global` (REMOTE.md section 2). */
export interface HubEnvelope {
  bootId: string;
  seq: number;
  topic: Topic;
  event: unknown;
}

export type Since = { kind: "replay"; events: HubEnvelope[] } | { kind: "resync"; reason: "no_id" | "new_boot" | "gap" };

export interface SubscribeOptions {
  /** `"all"` (the desktop window), or the topics wanted; `topics` on the result can be replaced later. */
  topics: "all" | Iterable<Topic>;
  /** Receives each publish as one batch, in order (consecutive `seq`s). */
  deliver: (batch: HubEnvelope[]) => void;
  /** Runs once when the subscription ends, by `close()` or `unsubscribe()`. */
  onClose?: (reason: string) => void;
}

export interface Subscription {
  readonly id: number;
  /** Replace the topic filter (`POST /api/subscribe`). */
  setTopics(topics: "all" | Iterable<Topic>): void;
  /** Ends the subscription and tells it why (backpressure, revoked device, ...). */
  close(reason: string): void;
}

interface Entry {
  envelope: HubEnvelope;
  bytes: number;
}

/** The JSON of an envelope's event, made once when the hub remembers it: it sizes the ring and every stream reuses it. */
const eventJson = new WeakMap<HubEnvelope, string>();

/**
 * Every host push goes through here: one counter and one ring for all topics, so several clients (the desktop window,
 * remote streams) see the same ordered history and can replay a gap after a reconnect.
 */
export class EventHub {
  readonly bootId: string;
  private seq = 0;
  private ring: Entry[] = [];
  private head = 0;
  private ringBytes = 0;
  private nextId = 1;
  private subs = new Map<number, { filter: "all" | Set<Topic>; opts: SubscribeOptions }>();

  constructor(
    private readonly maxEvents = RING_MAX_EVENTS,
    private readonly maxBytes = RING_MAX_BYTES,
    bootId = randomBytes(9).toString("base64url"),
  ) {
    this.bootId = bootId;
  }

  /** The newest `seq` issued (0 before the first event). */
  get latest(): number {
    return this.seq;
  }

  /** The `seq` of the oldest event still replayable, null when the ring is empty. */
  get oldest(): number | null {
    return this.head < this.ring.length ? this.ring[this.head]!.envelope.seq : null;
  }

  publish(topic: Topic, event: unknown): HubEnvelope {
    return this.publishBatch(topic, [event])[0]!;
  }

  /** Several events of one topic delivered to each subscriber as one batch (the desktop's `IPC.events` batching). */
  publishBatch(topic: Topic, events: unknown[]): HubEnvelope[] {
    if (events.length === 0) return [];
    const batch = events.map((event): HubEnvelope => ({ bootId: this.bootId, seq: ++this.seq, topic, event }));
    for (const envelope of batch) this.remember(envelope);
    for (const sub of [...this.subs.values()]) {
      if (sub.filter !== "all" && !sub.filter.has(topic)) continue;
      try {
        sub.opts.deliver(batch);
      } catch (error) {
        console.error("event hub subscriber failed:", error);
      }
    }
    return batch;
  }

  /** What a client holding `Last-Event-ID` needs: the events after it, or a resync when it cannot be bridged. */
  since(bootId: string | null, seq: number | null): Since {
    const id = bootId === null || seq === null ? null : formatEventId(bootId, seq);
    const plan = planReplay(id, this.bootId, this.oldest, this.seq);
    if (plan.kind === "resync") return plan;
    return { kind: "replay", events: this.ring.slice(this.head).map((e) => e.envelope).filter((e) => e.seq >= plan.from) };
  }

  subscribe(opts: SubscribeOptions): Subscription {
    const id = this.nextId++;
    const entry = { filter: toFilter(opts.topics), opts };
    this.subs.set(id, entry);
    return {
      id,
      setTopics: (topics) => {
        entry.filter = toFilter(topics);
      },
      close: (reason) => {
        if (this.subs.delete(id)) opts.onClose?.(reason);
      },
    };
  }

  get subscribers(): number {
    return this.subs.size;
  }

  /** `JSON.stringify(envelope)`, from the event's JSON made when it was published. */
  json(envelope: HubEnvelope): string {
    let event = eventJson.get(envelope);
    if (event === undefined) {
      event = JSON.stringify(envelope.event) ?? "null";
      eventJson.set(envelope, event);
    }
    return `{"bootId":${JSON.stringify(envelope.bootId)},"seq":${envelope.seq},"topic":${JSON.stringify(envelope.topic)},"event":${event}}`;
  }

  private remember(envelope: HubEnvelope): void {
    const json = JSON.stringify(envelope.event) ?? "null";
    eventJson.set(envelope, json);
    const bytes = Buffer.byteLength(json);
    this.ring.push({ envelope, bytes });
    this.ringBytes += bytes;
    // Evict oldest first; the newest event always stays, even when it alone exceeds the byte bound.
    while (this.ring.length - this.head > 1 && (this.ring.length - this.head > this.maxEvents || this.ringBytes > this.maxBytes)) {
      this.ringBytes -= this.ring[this.head++]!.bytes;
    }
    if (this.head > 1024 && this.head * 2 > this.ring.length) {
      this.ring = this.ring.slice(this.head);
      this.head = 0;
    }
  }
}

function toFilter(topics: "all" | Iterable<Topic>): "all" | Set<Topic> {
  return topics === "all" ? "all" : new Set(topics);
}
