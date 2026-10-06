#!/usr/bin/env node
// One chat on two phones and the desktop: open and dedupe, a prompt streaming everywhere, an approval answered once (first wins),
// and a cancel from the other phone.
import { readFileSync } from "node:fs";
import { sleep, log, check, until, responses, request, records, deltas, messageEnds, userTexts, lineNumbers, contiguous, agentEnds, finalText, lastLine, showSession, desktopText, desktopHasLines, settled, scenario } from "./harness.mjs";

await scenario("chat sync", async (ctx) => {
  const { A, B, desktop, sessionFile } = ctx;
  const cwd = ctx.project;
  const deviceA = (await A.ok("devices.list")).find((d) => d.name === "iPhone A");

  log("open an existing session");
  const opened = await A.ok("chat.open", { request: { cwd, sessionPath: sessionFile } });
  let handle = opened.handle;
  const topic = `chat:${handle}`;
  check(!opened.reused && /^[a-z0-9]{6,32}$/.test(handle), "A opens the session file and gets a host handle", opened);
  check(Array.isArray(opened.entries) && opened.entries.length === 0, "a remote open returns no entries (the phone reads chat.snapshot)");
  const openedB = await B.ok("chat.open", { request: { cwd, sessionPath: sessionFile } });
  check(openedB.reused === true && openedB.handle === handle, "B opening the same file attaches to the same handle", openedB);
  const snapshotA = await A.ok("chat.snapshot", { handle });
  check(JSON.stringify(snapshotA.value).includes("Earlier answer 3."), "A's snapshot holds the session's earlier turns");
  await showSession(desktop, "Earlier question 1");
  await until("the desktop to show the session", async () => (await desktopText(desktop)).includes("Earlier answer 3."));
  const live = await desktop.eval("window.studio.liveChats()");
  check(live.length === 1 && live[0].handle === handle, "the desktop shows the same live chat (one pi process for the file)", live);

  let sseA = A.events([handle]);
  const sseB = B.events([handle]);
  await until("both streams", () => sseA.frames.length > 0 && sseB.frames.length > 0);
  check(sseA.frames[0].event === "hello" && sseA.frames[0].json.bootId === sseB.frames[0].json.bootId, "both streams start with hello of the same boot");

  // ── Prompt, streaming and approvals ─────────────────────────────────────
  log("prompt from A, stream to A, B and the desktop; approval answered by A");
  const aAll = []; // A's events across reconnects
  const collectA = () => {
    for (const e of sseA.events) if (!aAll.includes(e)) aAll.push(e);
    return aAll;
  };
  let sent = await A.ok("chat.send", { handle, text: "first prompt ask-confirm [lines=40][delay=50]", mode: "send" });
  check(sent.accepted === true, "A's prompt is accepted", sent);
  const dialogRecord = await until("the confirm dialog on B", () => records(sseB.events, topic).find((r) => r.type === "extension_ui_request"));
  await until("the confirm dialog on A", () => records(sseA.events, topic).find((r) => r.type === "extension_ui_request"));
  await until("the confirm card on the desktop", async () => (await desktopText(desktop, true)).includes("Run the fake tool?"));
  check(true, "A, B and the desktop all show the approval");
  const answer = await A.call("chat.respondDialog", { handle, response: { type: "extension_ui_response", id: dialogRecord.id, confirmed: true } });
  check(answer.status === 200 && (answer.value === null || answer.value?.ok !== false), "A's answer is taken", answer);
  const resolvedB = await until("dialog_resolved on B", () => sseB.events.find((e) => e.topic === topic && e.event.kind === "dialog_resolved"));
  await until("dialog_resolved on A", () => sseA.events.find((e) => e.topic === topic && e.event.kind === "dialog_resolved"));
  check(resolvedB.event.id === dialogRecord.id && resolvedB.event.by?.device === deviceA.id && resolvedB.event.outcome === "answered", "B gets dialog_resolved naming A's device", resolvedB.event);
  await until("the card to leave the desktop", async () => !(await desktopText(desktop, true)).includes("Run the fake tool?"));
  check(true, "the desktop drops the card too");
  const second = await B.call("chat.respondDialog", { handle, response: { type: "extension_ui_response", id: dialogRecord.id, confirmed: false } });
  const lateCode = second.value?.code ?? second.value?.error?.code;
  check(lateCode === "already_answered", "B's later answer is already_answered", second);
  const logged = readFileSync(responses, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check(logged.length === 1 && logged[0].confirmed === true, "pi received exactly one answer (A's)", logged);

  await until("the run to end on A and B", () => agentEnds(sseA.events, topic) >= 1 && agentEnds(sseB.events, topic) >= 1, 30_000);
  await settled(desktop, handle);
  const numbersA = lineNumbers(collectA(), topic);
  const numbersB = lineNumbers(sseB.events, topic);
  check(numbersA.length === 40 && contiguous(numbersA) && numbersA[0] === 1, "A saw lines 1..40, no gaps or duplicates", numbersA.length);
  check(JSON.stringify(numbersA) === JSON.stringify(numbersB), "B saw the same lines as A");
  check(finalText(aAll, topic) === finalText(sseB.events, topic) && lastLine(finalText(aAll, topic)) === 40, "A and B end with the identical assistant message");
  check(await desktopHasLines(desktop, 40), "the desktop shows the same final message (lines 1..40, once each)");
  check(userTexts(sseB.events, topic)[0]?.startsWith("first prompt"), "the prompt is a user turn on B");

  // ── Cancel from B ───────────────────────────────────────────────────────
  log("cancel from B mid-stream");
  let markA = aAll.length;
  let markB = sseB.events.length;
  sent = await A.ok("chat.send", { handle, text: "cancel me [lines=2000][delay=30]", mode: "send" });
  await until("deltas on B", () => deltas(sseB.events.slice(markB), topic).length >= 5);
  const restored = await B.ok("chat.interrupt", { handle });
  check(Array.isArray(restored), "B's interrupt returns the restored queue", restored);
  await until("the run to end on A and B", () => agentEnds(collectA().slice(markA), topic) === 1 && agentEnds(sseB.events.slice(markB), topic) === 1);
  await settled(desktop, handle);
  const cancelA = collectA().slice(markA);
  const cancelB = sseB.events.slice(markB);
  const endedWith = messageEnds(cancelB, topic, "assistant").at(-1)?.message.stopReason;
  check(endedWith === "aborted", "the run ended aborted on B", endedWith);
  check(messageEnds(cancelA, topic, "assistant").at(-1)?.message.stopReason === "aborted", "the run ended aborted on A");
  check(JSON.stringify(lineNumbers(cancelA, topic)) === JSON.stringify(lineNumbers(cancelB, topic)) && contiguous(lineNumbers(cancelB, topic)), "A and B saw the same partial transcript");
  const cut = lastLine(finalText(cancelB, topic));
  check(cut >= 5 && cut < 2000, "the answer was cut short", cut);
  check(await desktopHasLines(desktop, cut), "the desktop shows the same cut-off answer");
  const afterCancel = (await B.ok("chat.live")).find((c) => c.handle === handle);
  check(afterCancel && afterCancel.running === false, "the host reports the chat idle", afterCancel);
  const sizeAfter = deltas(sseB.events, topic).length;
  await sleep(600);
  check(deltas(sseB.events, topic).length === sizeAfter, "no more output after the cancel");
});
