#!/usr/bin/env node
// The host outliving its clients and its own pauses: both phones leave mid-run (the run goes on), the process is paused with
// SIGSTOP (this test instance only) and resumed, then restarted (new boot id, stale idempotency keys, resync).
import { sleep, log, check, until, request, records, deltas, lineNumbers, contiguous, agentEnds, desktopHasLines, settled, scenario } from "./harness.mjs";

await scenario("host lifecycle", async (ctx) => {
  const { A, B, desktop, sessionFile } = ctx;
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
  let sent;

  log("close A and B mid-run: the run continues");
  markB = sseB.events.length;
  sent = await A.ok("chat.send", { handle, text: "survive test [lines=50][delay=100]", mode: "send" });
  await until("a few lines", () => deltas(sseB.events.slice(markB), topic).length >= 5);
  for (const phone of [A, B]) {
    await phone.call("chat.viewing", { handle, viewing: false });
    await phone.ok("chat.detach", { handle });
  }
  sseA.drop();
  sseB.drop();
  await sleep(800);
  const running = (await desktop.eval("window.studio.liveChats()")).find((c) => c.handle === handle);
  check(running?.running === true, "the run goes on with no phone attached", running);
  await until("the desktop to show the run's end", async () => (await desktopHasLines(desktop, 50)), 30_000, 250);
  check(true, "the desktop saw it finish (line 50)");
  await settled(desktop, handle);
  const idle = (await desktop.eval("window.studio.liveChats()")).find((c) => c.handle === handle);
  check(idle && idle.running === false && idle.settled?.outcome === "done", "the host records the run as done", idle);
  const back = await A.ok("chat.attach", { handle });
  check(back && Object.keys(back).join() === "seq", "a phone's attach carries only the seq, not the transcript", back);
  const lastPage = await A.ok("chat.snapshot", { handle, turns: 1 });
  check(JSON.stringify(lastPage).includes("Line 50 of the streamed") && lastPage.value.turns.from === lastPage.value.turns.total - 1, "a phone attaching afterwards reads the finished answer from a one-turn page");

  // ── Host asleep: the process is paused (SIGSTOP on this test instance only), then resumed ──
  log("pause the host process (simulated sleep), then resume");
  const sleeper = A.events([handle]);
  await until("the sleeper stream", () => sleeper.frames.some((f) => f.event === "hello"));
  markB = sleeper.events.length;
  await A.ok("chat.send", { handle, text: "sleep test [lines=40][delay=150]", mode: "send" });
  await until("a few lines before the pause", () => deltas(sleeper.events.slice(markB), topic).length >= 5);
  process.kill(ctx.instance.pid, "SIGSTOP");
  let paused = true;
  try {
    const beforePause = sleeper.events.length;
    const hung = await Promise.race([A.call("chat.live", {}).then(() => false, () => true), sleep(3000).then(() => true)]);
    check(hung, "a call to the paused host gets no answer (the client's timeout/unreachable path)");
    await sleep(1500);
    check(sleeper.events.length - beforePause <= 1 && !sleeper.closed, "no events arrive while paused and the stream is not torn down by the host", sleeper.events.length - beforePause);
  } finally {
    process.kill(ctx.instance.pid, "SIGCONT");
    paused = false;
  }
  check(paused === false, "the host process resumed");
  await until("the run to finish after resume", () => agentEnds(sleeper.events.slice(markB), topic) === 1, 40_000, 100);
  const slept = lineNumbers(sleeper.events.slice(markB), topic);
  check(slept.length === 40 && contiguous(slept) && slept[0] === 1, "after resume the same stream carries lines 1..40 once each", slept.length);
  check((await A.call("chat.live", {})).status === 200, "calls answer again after resume");
  sleeper.drop();

  log("restart the host: new boot id");
  const hello = (await A.json("GET", "/api/hello")).value;
  const oldBoot = hello.bootId;
  const bootCursor = `${oldBoot}:${(await A.ok("chat.snapshot", { handle })).seq}`;
  const turnsBefore = JSON.stringify((await A.ok("chat.snapshot", { handle })).value).split("restart test").length - 1;
  await ctx.restart();
  const again = (await A.json("GET", "/api/hello")).value;
  check(again.authenticated === true, "the paired device survives the restart (same cookie)");
  check(again.bootId !== undefined && again.bootId !== oldBoot, "the host has a new boot id", { oldBoot, new: again.bootId });
  const stale = await A.call("chat.send", { handle, text: "restart test", mode: "send" }, { key: "old-key", boot: oldBoot });
  check(stale.status === 409 && stale.value?.error?.code === "host_restarted", "an old key sent with the old boot id fails host_restarted", stale);
  const liveAfter = await A.ok("chat.live", {});
  check(!liveAfter.some((c) => c.handle === handle), "no chat was started by the stale prompt");
  const resyncStream = A.events([handle], bootCursor);
  await until("the restarted stream", () => resyncStream.frames.length > 1);
  const r = resyncStream.frames.find((f) => f.event === "resync");
  check(r?.json.reason === "new_boot" && resyncStream.frames.indexOf(r) === 1 && resyncStream.frames[0].event === "hello", "a stream resuming an old boot gets resync(new_boot) right after hello, before any replay", resyncStream.frames.map((f) => f.event));
  resyncStream.drop();
  const reopened = await A.ok("chat.open", { request: { cwd: ctx.project, sessionPath: sessionFile } });
  check(JSON.stringify(reopened).split("restart test").length - 1 === turnsBefore, "reopening after the restart shows the transcript without the stale prompt");
  await A.call("chat.close", { handle: reopened.handle ?? handle });
});
