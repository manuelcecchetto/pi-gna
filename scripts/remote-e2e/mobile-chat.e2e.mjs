#!/usr/bin/env node
// The phone's chat: Projects, Chats, the transcript paging in earlier turns on scroll, a prompt from the phone's composer with an
// approval, following the stream, Stop with confirmation, then the composer's chrome (models, commands, mentions, queue, extension UI).
import { sleep, log, check, until, project, agentEnds, settled, openPhone, scenario } from "./harness.mjs";

await scenario("mobile chat", async (ctx) => {
  const { A, desktop } = ctx;
  // More turns than the phone's first page (six), the last one 50 lines long.
  const handle = await ctx.openChat();
  const stream = A.events([handle]);
  await until("the fixture stream", () => stream.frames.some((frame) => frame.event === "hello"));
  for (const [n, text] of ["fixture one [lines=3][delay=1]", "fixture two [lines=3][delay=1]", "fixture three [lines=3][delay=1]", "fixture four [lines=50][delay=1]"].entries()) {
    await A.ok("chat.send", { handle, text, mode: "send" });
    await until("the fixture answer", () => agentEnds(stream.events, `chat:${handle}`) === n + 1, 30_000);
  }
  stream.drop();
  await settled(desktop, handle);

  const { phone, shot, text, tap, exists, present } = await openPhone(ctx);
  await until("the projects screen", present("project"), 30_000, 250);
  await sleep(800);
  await shot("1-projects");
  // Pin the emulated OS to light, then give the active project an explicit dark mode: project theme must win.
  await phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await desktop.eval(`window.studio.themes.apply({ type: "set", scope: { project: ${JSON.stringify(project)} }, patch: { base: "dark" } })`);
  check(await tap("project"), "the phone lists the project");
  await until("the chats screen", present("Earlier question 1"));
  await until("the mobile project-forced dark mode", () => phone.eval(`document.documentElement.dataset.themeMode === "dark"`), 10_000, 150);
  check(true, "the active project forces dark on a mobile emulating a light OS");
  await sleep(800);
  await shot("2-chats");
  check(await tap("Earlier question 1"), "the phone lists the session");
  await until("the chat", () => exists('[data-testid="send"]'));
  await until("the transcript", present("Line 50 of the streamed"));
  await sleep(800);
  await shot("3-chat");
  check(true, "the phone's chat ends with the last answer of the scenario");
  // It opens on the last few turns; scrolling to the top pages the earlier ones in, with no button to tap.
  check(!(await text()).includes("Earlier answer 1."), "the chat opens on a short first page");
  await until("the earliest turn after scrolling up", async () => {
    await phone.eval(`(() => { const s = [...document.querySelectorAll('.overflow-y-auto')].find((e) => e.scrollHeight > e.clientHeight && e.innerText.includes('streamed')); if (s) { s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); } })()`);
    return (await text()).includes("Earlier answer 1.");
  }, 20_000, 300);
  check(true, "scrolling to the top loads the earlier turns");
  await phone.eval(`(() => { const s = [...document.querySelectorAll('.overflow-y-auto')].find((e) => e.scrollHeight > e.clientHeight && e.innerText.includes('streamed')); if (s) s.scrollTop = s.scrollHeight; })()`);

  // The phone's own composer: send a prompt that raises an approval.
  await phone.eval("document.querySelector('textarea').focus()");
  await phone.send("Input.insertText", { text: "phone prompt ask-confirm [lines=300][delay=100]" });
  await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
  await phone.eval(`document.querySelector('[data-testid="send"]').click()`);
  await until("the approval card on the phone", present("Run the fake tool?"));
  check((await text()).includes("Allow") && (await text()).includes("Deny"), "the approval card offers Allow and Deny");
  await sleep(500);
  await shot("4-approval");
  check(await tap("Allow"), "the phone taps Allow");
  await until("the card to go", async () => !(await text()).includes("Run the fake tool?"));
  await until("streamed lines on the phone", present("Line 4 of the streamed"));
  await followChecks({ phone, present });
  const ph = await A.ok("chat.live");
  check(ph.find((c) => c.handle === handle)?.running === true, "the host shows the phone's prompt running");
  await sleep(500);
  await shot("5-streaming");
  await until("the stop button", () => exists('[data-testid="stop"]'));
  await phone.eval(`document.querySelector('[data-testid="stop"]').click()`);
  await until("the stop confirmation", present("Stop the agent?"));
  await shot("6-stop-confirm");
  await phone.eval(`document.querySelector('[data-testid="confirm-stop"]').click()`);
  await until("the run to stop", async () => !(await exists('[data-testid="stop"]')));
  const stoppedLive = (await A.ok("chat.live")).find((c) => c.handle === handle);
  check(stoppedLive?.running === false, "the host shows the run stopped after the phone's Stop", stoppedLive);
  await sleep(800);
  await shot("7-stopped");
  check(!(await exists('[data-testid="stop"]')), "the phone no longer offers Stop");
  await liveToolChecks({ phone, shot, exists, present });
  await composerChecks({ phone, A, handle, shot, text, tap, exists, present });
  await reopenChecks({ phone, A, handle, sessionFile: ctx.sessionFile, tap, exists, present });
});

/** Tool calls while they run: a row with the output so far in its sheet, then their time, and a failed one marked failed. */
async function liveToolChecks({ phone, shot, exists, present }) {
  log("live tool rows");
  const sheet = () => phone.eval(`document.querySelector('[data-testid="tool-sheet"]')?.innerText ?? ''`);
  const row = (verb, step) => `[...document.querySelectorAll("button")].find((b) => b.innerText.startsWith(${JSON.stringify(verb)}) && b.innerText.includes("--step ${step}"))`;
  await phone.eval("document.querySelector('textarea').focus()");
  await phone.send("Input.insertText", { text: "phone tools [tools=2][toolout=8][delay=250][lines=1] [toolfail]" });
  await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
  await phone.eval(`document.querySelector('[data-testid="send"]').click()`);
  await until("the first call running", () => phone.eval(`!!${row("Running", 1)}`));
  await phone.eval(`${row("Running", 1)}.click()`);
  await until("its sheet with the output so far", async () => (await sheet()).includes("call 1 line 2"));
  await until("the open sheet to follow the output", async () => (await sheet()).includes("call 1 line 6"), 10_000, 100);
  check(true, "a running call's sheet shows its output as it arrives");
  await shot("5b-live-tool");
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);
  await until("the answer after the calls", present("Line 1 of the streamed"));
  await until("the work to fold away", async () => !(await exists('[data-testid="stop"]')));
  await phone.eval(`[...document.querySelectorAll("button")].findLast((b) => b.innerText.startsWith("Worked"))?.click()`);
  await until("the finished rows", () => phone.eval(`!!${row("Ran", 2)}`));
  check(await phone.eval(`!${row("Ran", 1)}.innerText.includes("failed") && ${row("Ran", 2)}.innerText.includes("failed")`), "the calls end as ran, the last one failed");
  await phone.eval(`${row("Ran", 2)}.click()`);
  await until("the failed call's sheet", async () => (await sheet()).includes("exit code 1"));
  check((await sheet()).includes("call 2 line 8"), "a finished call's sheet keeps all its output", await sheet());
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);
}

/** The chat's pi stops under the phone (closed elsewhere, or stopped on the Mac while idle): Reopen opens it again from its file. */
async function reopenChecks({ phone, A, handle, sessionFile, tap, exists, present }) {
  log("mobile reopen");
  await A.ok("chat.close", { handle });
  await until("the exited banner", present("pi exited."));
  check(await tap("Reopen"), "an exited chat offers Reopen");
  await until("the chat to open again", async () => !(await present("pi exited.")()) && (await exists('[data-testid="send"]')), 20_000);
  const live = (await A.ok("chat.live")).find((chat) => chat.sessionPath === sessionFile);
  check(live !== undefined && live.handle !== handle, "Reopen starts the chat again from its session file", live);
  check(!(await phone.eval(`document.body.innerText.includes("This chat has ended.")`)), "the phone does not report the chat as ended");
}

/** While the phone's prompt streams: at the end the view follows it, and the jump-to-latest button shows exactly when it does not. */
async function followChecks({ phone, present }) {
  log("mobile streaming follow");
  const scroller = `[...document.querySelectorAll('.overflow-y-auto')].find((e) => e.innerText.includes('streamed'))`;
  const end = () => phone.eval(`(() => { const s = ${scroller}; return s.scrollHeight - s.scrollTop - s.clientHeight; })()`);
  const bubble = () => phone.eval(`!!document.querySelector('button[title="Jump to latest"]')`);
  const touch = (type, points) => phone.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  await until("the answer to outgrow the view", present("Line 40 of the streamed"));
  await sleep(1000);
  check((await end()) <= 2 && !(await bubble()), "the phone follows the streaming answer at the end", await end());

  // iOS's rubber band: pulled past the end, the view bounces back up to it. Chromium cannot overscroll, so replay those offsets.
  await phone.eval(`(async () => {
    const s = ${scroller};
    for (const past of [30, 15, 5, 0]) {
      const top = s.scrollHeight - s.clientHeight + past;
      Object.defineProperty(s, "scrollTop", { configurable: true, get: () => top, set: () => undefined });
      s.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    delete s.scrollTop;
    return true;
  })()`);
  await sleep(2000);
  check((await end()) <= 2 && !(await bubble()), "after a bounce at the end the phone still follows", await end());

  // A finger dragging the transcript down scrolls up: following stops and the button shows.
  const box = await phone.eval(`(() => { const r = (${scroller}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; })()`);
  await touch("touchStart", [[box.x, box.y]]);
  for (let step = 1; step <= 6; step++) {
    await touch("touchMove", [[box.x, box.y + step * 40]]);
    await sleep(30);
  }
  await touch("touchEnd", []);
  await sleep(1500);
  const left = await end();
  check(left > 2 && (await bubble()), "scrolling up stops following and shows the jump-to-latest button", left);
  await sleep(1000);
  check((await end()) > left, "the answer streams on below without pulling the view down");
  await phone.eval(`document.querySelector('button[title="Jump to latest"]').click()`);
  await sleep(2000);
  check((await end()) <= 2 && !(await bubble()), "Jump to latest follows the stream again", await end());
}

/** The phone's composer chrome (T26): model and thinking sheets, commands, mentions, context meter, queue, extension UI. */
async function composerChecks({ phone, A, handle, shot, text, tap, exists, present }) {
  log("mobile composer parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const clickText = (testId, label) => phone.eval(`(() => { const e = [...document.querySelectorAll('[data-testid="${testId}"]')].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const value = () => phone.eval("document.querySelector('textarea').value");
  const type = async (t) => {
    await phone.eval("document.querySelector('textarea').focus()");
    await phone.send("Input.insertText", { text: t });
  };
  const clear = async () => {
    await phone.eval("(() => { const t = document.querySelector('textarea'); t.focus(); t.select(); })()");
    await phone.send("Input.insertText", { text: "" });
    await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await phone.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  };
  const state = async () => (await A.ok("chat.command", { handle, command: { type: "get_state" } })).data;
  const label = (testId) => phone.eval(`document.querySelector('[data-testid="${testId}"]')?.innerText ?? ''`);
  const idle = () => until("the run to end", async () => !(await exists('[data-testid="stop"]')), 30_000, 100);

  // Model and thinking sheets, calling chat.command on the host.
  await until("the model chip", () => exists('[data-testid="model-chip"]'));
  check((await label("model-chip")).trim().startsWith("Fake"), "the model chip names the model", await label("model-chip"));
  check(!(await exists('[data-testid="thinking-chip"]')), "no thinking chip for a model without reasoning");
  await click("model-chip");
  await until("the model sheet", () => exists('[data-testid="model-option"]'));
  await shot("8-model-sheet");
  check(await clickText("model-option", "Fake Large"), "the sheet lists Fake Large and the phone taps it");
  await until("the new model", async () => (await label("model-chip")).includes("Fake Large"));
  check((await state()).model.id === "fake-large", "the host runs the chosen model");
  await until("the thinking chip", () => exists('[data-testid="thinking-chip"]'));
  await click("thinking-chip");
  await until("the thinking sheet", () => exists('[data-testid="thinking-option"]'));
  await shot("9-thinking-sheet");
  check(await clickText("thinking-option", "high"), "the phone picks the thinking level high");
  await until("the level on the chip", async () => (await label("thinking-chip")).includes("high"));
  check((await state()).thinkingLevel === "high", "the host runs the chosen thinking level");

  // Slash commands and @ mentions as touch lists.
  await type("/");
  await until("the command list", () => exists('[data-testid="menu-item"]'));
  await shot("10-commands");
  check((await text()).includes("/compact"), "typing / lists pi's commands");
  check(await clickText("menu-item", "/review"), "the phone taps a command");
  check((await value()) === "/review ", "the command lands in the composer", await value());
  await clear();
  await type("look at @notes-al");
  await until("the file list", () => exists('[data-testid="menu-item"]'));
  await shot("11-mentions");
  check(await clickText("menu-item", "notes-alpha.md"), "typing @ lists project files and the phone taps one");
  check((await value()) === "look at @notes-alpha.md ", "the mention lands in the composer", await value());
  await clear();

  // Context meter sheet and Compact now.
  await until("the context meter", () => phone.eval(`!!document.querySelector('button[aria-label^="Context usage"]')`));
  check((await phone.eval(`document.querySelector('button[aria-label^="Context usage"]').innerText`)).includes("25%"), "the meter shows the context share");
  await phone.eval(`document.querySelector('button[aria-label^="Context usage"]').click()`);
  await until("the context sheet", () => exists('[data-testid="context-sheet"]'));
  await shot("12-context");
  const sheetText = await phone.eval(`document.querySelector('[data-testid="context-sheet"]').innerText`);
  check(/Auto-compacts at/.test(sheetText) && /Cache hit/.test(sheetText) && /Compact now/.test(sheetText), "the sheet shows tokens, the auto-compaction point, cache hits and Compact now", sheetText.slice(0, 200));
  check(await tap("Compact now"), "the phone taps Compact now");
  await until("the meter after compaction", async () => (await phone.eval(`document.querySelector('button[aria-label^="Context usage"]')?.innerText ?? ''`)).includes("10%"), 20_000, 200);
  check(true, "the context meter follows the compaction");

  // The queue card: a run with two follow-ups.
  await type("queue run [lines=300][delay=100]");
  await click("send");
  await until("the run", () => exists('[data-testid="stop"]'));
  for (const t of ["follow one", "follow two"]) {
    await type(t);
    await until("Queue to enable", () => phone.eval(`document.querySelector('[data-testid="queue"]')?.disabled === false`));
    await click("queue");
    await until("the draft to clear", async () => (await value()) === "");
  }
  await until("two queue rows", async () => (await phone.eval(`document.querySelectorAll('[data-testid="queue-row"]').length`)) === 2);
  await shot("13-queue");
  check(await phone.eval(`!!document.querySelector('[data-testid="queue-steer"]') && !!document.querySelector('[data-testid="queue-edit"]') && !!document.querySelector('[data-testid="queue-delete"]')`), "queue rows offer Steer now, Edit and Remove");
  await phone.eval(`document.querySelector('[data-testid="queue-steer"]').click()`);
  await until("a steering row", () => phone.eval(`!!document.querySelector('[data-testid="queue-row"][data-kind="steering"]')`));
  check(true, "Steer now moves a follow-up to steering");
  await phone.eval(`[...document.querySelectorAll('[data-testid="queue-row"]')].at(-1).querySelector('[data-testid="queue-edit"]').click()`);
  await until("the edit to reach the composer", async () => (await value()).includes("follow"));
  check(true, "Edit takes the message back into the composer");
  await clear();
  await until("one row left", async () => (await phone.eval(`document.querySelectorAll('[data-testid="queue-row"]').length`)) === 1);
  await phone.eval(`document.querySelector('[data-testid="queue-delete"], [data-testid="queue-defer"]') && document.querySelector('[data-testid="queue-delete"]').click()`);
  await until("the queue to empty", () => phone.eval(`!document.querySelector('[data-testid="queue-card"]')`));
  check(true, "Remove deletes a queued message");
  await click("stop");
  await click("confirm-stop");
  await idle();

  // Extension UI and retry callouts.
  await type("ext-ui retry-demo [lines=40][delay=100]");
  await click("send");
  await until("the extension widget", () => exists('[data-testid="widget"]'));
  await shot("14-extension-ui");
  check((await text()).includes("fake widget line"), "an extension widget shows above the composer");
  check((await text()).includes("fake-ext: heads up"), "an extension notify becomes a toast");
  await until("the editor text", async () => (await value()) === "prefilled by fake-ext");
  check(true, "set_editor_text fills the composer");
  await until("the retry callout", () => exists('[data-testid="retry-callout"]'));
  check((await text()).includes("Retrying (1/3)"), "an auto-retry shows a callout");
  await click("stop");
  await click("confirm-stop");
  await idle();
  await clear();
}
