import { describe, expect, it } from "vitest";
import { EventHub, type HubEnvelope } from "./event-hub";

const collect = (hub: EventHub, topics: Parameters<EventHub["subscribe"]>[0]["topics"]) => {
  const got: HubEnvelope[][] = [];
  const sub = hub.subscribe({ topics, deliver: (b) => got.push(b) });
  return { got, sub, flat: () => got.flat() };
};

describe("EventHub", () => {
  it("orders events with one monotonic seq across topics", () => {
    const hub = new EventHub();
    const a = collect(hub, "all");
    hub.publish("global", { kind: "x" });
    hub.publishBatch("chat:abc123", [{ n: 1 }, { n: 2 }]);
    expect(a.flat().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(a.got.map((b) => b.length)).toEqual([1, 2]);
    expect(a.flat().every((e) => e.bootId === hub.bootId)).toBe(true);
    expect(hub.latest).toBe(3);
  });

  it("filters by topic and lets the filter change", () => {
    const hub = new EventHub();
    const a = collect(hub, ["global"]);
    hub.publish("chat:abc123", 1);
    hub.publish("global", 2);
    expect(a.flat().map((e) => e.event)).toEqual([2]);
    a.sub.setTopics(["chat:abc123"]);
    hub.publish("chat:abc123", 3);
    hub.publish("global", 4);
    expect(a.flat().map((e) => e.event)).toEqual([2, 3]);
  });

  it("serializes each event once, for the ring and every stream", () => {
    const hub = new EventHub();
    let calls = 0;
    const event = { toJSON: () => (calls++, { kind: "x", text: 'a "b"' }) };
    const [envelope] = hub.publishBatch("chat:abc123", [event]);
    expect(hub.json(envelope!)).toBe(JSON.stringify({ ...envelope, event: { kind: "x", text: 'a "b"' } }));
    hub.json(envelope!);
    const replay = hub.since(hub.bootId, 0);
    expect(replay.kind === "replay" && hub.json(replay.events[0]!)).toBe(hub.json(envelope!));
    expect(calls).toBe(1);
  });

  it("evicts by count", () => {
    const hub = new EventHub(3, 1e9);
    for (let i = 0; i < 5; i++) hub.publish("global", i);
    expect(hub.oldest).toBe(3);
    const r = hub.since(hub.bootId, 2);
    expect(r.kind === "replay" && r.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(hub.since(hub.bootId, 1)).toEqual({ kind: "resync", reason: "gap" });
  });

  it("evicts by bytes but keeps the newest event", () => {
    const hub = new EventHub(100, 30);
    hub.publish("global", "a".repeat(10));
    hub.publish("global", "b".repeat(10));
    hub.publish("global", "c".repeat(10));
    expect(hub.oldest).toBe(2);
    hub.publish("global", "d".repeat(100));
    expect(hub.oldest).toBe(4);
    expect(hub.latest).toBe(4);
  });

  it("replays a gap and nothing when current", () => {
    const hub = new EventHub();
    for (let i = 0; i < 4; i++) hub.publish("global", i);
    const r = hub.since(hub.bootId, 2);
    expect(r.kind === "replay" && r.events.map((e) => e.seq)).toEqual([3, 4]);
    const none = hub.since(hub.bootId, 4);
    expect(none.kind === "replay" && none.events).toEqual([]);
  });

  it("resyncs on a different boot, a missing cursor or a future cursor", () => {
    const hub = new EventHub();
    hub.publish("global", 1);
    expect(hub.since("other", 1)).toEqual({ kind: "resync", reason: "new_boot" });
    expect(hub.since(null, null)).toEqual({ kind: "resync", reason: "no_id" });
    expect(hub.since(hub.bootId, 99)).toEqual({ kind: "resync", reason: "gap" });
    expect(new EventHub().bootId).not.toBe(new EventHub().bootId);
  });

  it("removes a subscriber on close, once, and stops delivering", () => {
    const hub = new EventHub();
    const reasons: string[] = [];
    const got: number[] = [];
    const sub = hub.subscribe({ topics: "all", deliver: (b) => got.push(b.length), onClose: (r) => reasons.push(r) });
    hub.publish("global", 1);
    sub.close("backpressure");
    sub.close("again");
    hub.publish("global", 2);
    expect(got).toEqual([1]);
    expect(reasons).toEqual(["backpressure"]);
    expect(hub.subscribers).toBe(0);
  });

  it("isolates a throwing subscriber", () => {
    const hub = new EventHub();
    hub.subscribe({ topics: "all", deliver: () => { throw new Error("boom"); } });
    const b = collect(hub, "all");
    hub.publish("global", 1);
    expect(b.flat()).toHaveLength(1);
  });
});
