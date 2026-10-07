#!/usr/bin/env node
// Two clients at once through the real server: simultaneous prompts (one runs, one queues), interrupt hands back the queue,
// and concurrent card edits from one revision (one lands, one conflicts).
import { randomUUID } from "node:crypto";
import { log, check, until, userTexts, agentEnds, settled, scenario } from "./harness.mjs";

await scenario("two clients at once", async (ctx) => {
  const { A, B, desktop } = ctx;
  const cwd = ctx.project;
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
  let markB;

  log("A and B prompt at the same moment; both edit one card");
  markB = sseB.events.length;
  const both = await Promise.all([
    A.call("chat.send", { handle, text: "concurrent from A [lines=20][delay=40]", mode: "send" }),
    B.call("chat.send", { handle, text: "concurrent from B [lines=20][delay=40]", mode: "send" }),
  ]);
  check(both.every((r) => r.status === 200), "both simultaneous prompts are accepted", both.map((r) => r.status));
  const queuedOf = (events) => events.filter((e) => e.topic === topic && e.event.record?.type === "queue_update").flatMap((e) => [...e.event.record.steering, ...e.event.record.followUp]);
  // The host orders the two: one starts the run, the other lands in pi's queue (nothing is lost or run twice).
  await until("the second prompt to queue", () => queuedOf(sseB.events.slice(markB)).length >= 1);
  const restoredQueue = await B.ok("chat.interrupt", { handle });
  await until("the run to end", () => agentEnds(sseB.events.slice(markB), topic) >= 1, 30_000);
  await settled(desktop, handle);
  const ran = userTexts(sseB.events.slice(markB), topic);
  const queued = queuedOf(sseB.events.slice(markB));
  check(ran.length === 1 && queued.length === 1 && new Set([...ran, ...queued].map((t) => t.slice(0, 20))).size === 2, "one prompt ran, the other waited in the queue, once each", { ran, queued });
  check(restoredQueue.length === 1 && queued[0] === restoredQueue[0], "B's interrupt aborts the run and hands back the waiting message", restoredQueue);

  // board.get answers the bare board for now; the contract wraps global reads as {seq, value}.
  const boardOf = (result) => result.value ?? result;
  const card = randomUUID().replace(/-/g, "").slice(0, 6);
  await A.ok("board.apply", { op: { type: "add", id: card, title: "Shared card", cwd } });
  const baseRev = boardOf(await A.ok("board.get")).rev;
  const edits = await Promise.all([
    A.call("board.apply", { op: { type: "edit", id: card, title: "Title from A" }, baseRev }),
    B.call("board.apply", { op: { type: "edit", id: card, title: "Title from B" }, baseRev }),
  ]);
  const statuses = edits.map((r) => r.status).sort();
  check(statuses[0] === 200 && statuses[1] === 409, "two title edits from one revision: one lands, the other gets a conflict (409)", edits.map((r) => r.status));
  const conflict = edits.find((r) => r.status === 409);
  check((conflict.value?.error?.code ?? conflict.value?.code) === "conflict", "the refused edit says conflict", conflict.value);
  const winner = edits.indexOf(edits.find((r) => r.status === 200)) === 0 ? "Title from A" : "Title from B";
  check(boardOf(await B.ok("board.get")).cards.find((c) => c.id === card)?.title === winner, "the board holds the winner's title", winner);
  const moves = await Promise.all([A.call("board.apply", { op: { type: "move", id: card, column: "done" }, baseRev }), B.call("board.apply", { op: { type: "move", id: card, column: "in_review" }, baseRev })]);
  check(moves.every((r) => r.status === 200), "concurrent moves both succeed (last writer wins)", moves.map((r) => r.status));
  await A.call("board.apply", { op: { type: "remove", id: card } });
  collectA(); // fold this section into A's history before the next one marks its start
});
