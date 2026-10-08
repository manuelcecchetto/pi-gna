#!/usr/bin/env node
// Recovery of a dropped stream: Last-Event-ID replay with an idempotent retry of the prompt, then a ring overflow that forces resync.
import { randomUUID } from "node:crypto";
import { log, check, until, records, deltas, userTexts, lineNumbers, contiguous, agentEnds, finalText, lastLine, desktopHasLines, settled, scenario } from "./harness.mjs";

/** The last streamed line in a snapshot's last turn (the earlier turn's 250 lines are in it too). */
const turnLine = (snapshot) => {
  const { items } = snapshot.state;
  const turn = items.slice(items.findLastIndex((item) => item.kind === "user"));
  return Math.max(0, ...[...JSON.stringify(turn).matchAll(/Line (\d+) of the streamed/g)].map((m) => Number(m[1])));
};

await scenario("reconnect and resync", async (ctx) => {
  const { A, B, desktop } = ctx;
  const handle = await ctx.openChat();
  const topic = `chat:${handle}`;
  let sseA = A.events([handle]);
  const sseB = B.events([handle]);
  await until("both streams", () => sseA.frames.length > 0 && sseB.frames.length > 0);
  const aAll = []; // A's events across reconnects
  const collectA = () => {
    for (const e of sseA.events) if (!aAll.includes(e)) aAll.push(e);
    return aAll;
  };
  let markA;
  let markB;
  let sent;

  log("drop A's stream mid-run, reconnect with Last-Event-ID, retry the prompt with the same key");
  markA = aAll.length;
  markB = sseB.events.length;
  const key = randomUUID();
  const promptArgs = { handle, text: "reconnect test [lines=250][delay=20]", mode: "send" };
  sent = await A.ok("chat.send", promptArgs, { key });
  await until("some lines on A", () => deltas(collectA().slice(markA), topic).length >= 30);
  collectA();
  const lastSeen = sseA.lastId;
  sseA.drop();
  await until("lines to pass while A is away", () => deltas(sseB.events.slice(markB), topic).length >= 90);
  const retry = await A.call("chat.send", promptArgs, { key });
  check(retry.status === 200 && JSON.stringify(retry.value) === JSON.stringify(sent), "the retry with the same Idempotency-Key returns the first result", retry);
  const mismatch = await A.call("chat.send", { ...promptArgs, text: "other text" }, { key });
  check(mismatch.status === 400, "the same key with another body is refused", mismatch.status);
  sseA = A.events([handle], lastSeen);
  await until("A's stream", () => sseA.frames.length > 0);
  check(!sseA.frames.some((f) => f.event === "resync"), "the reconnect replays; it does not resync");
  await until("the run to end on B", () => agentEnds(sseB.events.slice(markB), topic) === 1, 30_000);
  await until("A to catch up", () => agentEnds(sseA.events, topic) === 1);
  collectA();
  const resumed = sseA.events.map((e) => e.seq);
  check(resumed[0] === Number(lastSeen.split(":")[1]) + 1, "A's replay starts right after the last event it had", { first: resumed[0], last: lastSeen });
  const combined = aAll.slice(markA).map((e) => e.seq);
  check(combined.every((n, i) => i === 0 || n === combined[i - 1] + 1), "A's events are contiguous across the drop (no gaps, no duplicates)");
  const reNumbers = lineNumbers(aAll.slice(markA), topic);
  check(reNumbers.length === 250 && contiguous(reNumbers) && reNumbers[0] === 1, "A saw lines 1..250 once each", reNumbers.length);
  check(JSON.stringify(reNumbers) === JSON.stringify(lineNumbers(sseB.events.slice(markB), topic)), "B saw the identical lines");
  const once = userTexts(sseB.events, topic).filter((t) => t.startsWith("reconnect test")).length;
  check(once === 1, "the prompt ran once (retry and mismatch did not add a turn)", once);
  check(!records(sseB.events.slice(markB), topic).some((r) => r.type === "queue_update"), "nothing was queued by the retry");
  await settled(desktop, handle);
  check(await desktopHasLines(desktop, 250), "the desktop shows lines up to 250");

  // ── Ring overflow forces a resync ───────────────────────────────────────
  log("drop A, overflow the ring, reconnect: resync path");
  markA = aAll.length;
  markB = sseB.events.length;
  sent = await A.ok("chat.send", { handle, text: "overflow test [lines=6000][delay=5]", mode: "send" });
  await until("a few lines on A", () => deltas(collectA().slice(markA), topic).length >= 20);
  collectA();
  const oldId = sseA.lastId;
  const oldSeq = Number(oldId.split(":")[1]);
  sseA.drop();
  // The host merges a frame's text deltas into one event (src/main/coalesce.ts), so streamed text alone takes over
  // half a minute to fill the ring: B's presence changes (one `lease` event each) fill the rest.
  await B.ok("chat.attach", { handle });
  let viewing = false;
  await until("the ring to overflow", async () => {
    for (let i = 0; i < 50; i++) await B.ok("chat.viewing", { handle, viewing: (viewing = !viewing) });
    return (sseB.events.at(-1)?.seq ?? 0) - oldSeq > 2300;
  }, 60_000, 0);
  sseA = A.events([handle], oldId);
  await until("A's stream", () => sseA.frames.length > 1);
  const resync = sseA.frames.find((f) => f.event === "resync");
  check(!!resync, "the gap fell out of the ring: the server sends resync", sseA.frames.map((f) => f.event));
  check(!sseA.frames.slice(0, sseA.frames.indexOf(resync)).some((f) => f.event === "host" && f.json.seq <= oldSeq + 1), "no replay of the lost events");
  // The client's resync: replace state from snapshots, then apply only newer events.
  const snap = await A.ok("chat.snapshot", { handle });
  const snapLine = turnLine(snap.value);
  await until("live events after the snapshot", () => deltas(sseA.events.filter((e) => e.seq > snap.seq), topic).length >= 5);
  const after = lineNumbers(sseA.events.filter((e) => e.seq > snap.seq), topic);
  check(after[0] === snapLine + 1 && contiguous(after), "the snapshot plus newer events leave no gap and no duplicate", { snapLine, first: after[0] });
  const stopped = await A.ok("chat.interrupt", { handle });
  check(Array.isArray(stopped), "A stops the run");
  await until("the run to end", () => agentEnds(sseB.events.slice(markB), topic) === 1 && agentEnds(sseA.events, topic) === 1);
  await settled(desktop, handle);
  collectA();
  const finalSnap = await A.ok("chat.snapshot", { handle });
  const endLine = lastLine(finalText(sseB.events.slice(markB), topic));
  check(turnLine(finalSnap.value) === endLine, "the snapshot after the resync ends where B's stream ends", endLine);
  check(await desktopHasLines(desktop, endLine), "the desktop ends at the same line");
});
