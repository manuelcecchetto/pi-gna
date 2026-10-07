#!/usr/bin/env node
// The phone's Projects and Chats: search, long-press sheets, the board from a chat, Kanban off, Close chat, pins, the folder browser.
import { sleep, log, check, until, project, openPhone, openChatOnPhone, scenario } from "./harness.mjs";

await scenario("mobile projects", async (ctx) => {
  const { A } = ctx;
  const handle = await ctx.openChat();
  const mobile = await openPhone(ctx);
  const { phone, shot, text, exists, present } = mobile;
  await openChatOnPhone(mobile);
  await projectChecks({ phone, A, handle, shot, text, exists, present });
});

/** The phone's projects and chats (T25): search, long-press sheets, pins, board, close, folder browser, feature switches. */
async function projectChecks({ phone, A, handle, shot, text, exists, present }) {
  log("mobile projects and chats parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const longPress = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const type = async (testId, t) => {
    await phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); e.focus(); e.select(); })()`);
    await phone.send("Input.insertText", { text: t });
  };

  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));
  await sleep(500);
  await shot("8-chats-list");
  await type("search", "zzzzqq");
  await until("no chat matches", present("No chat matches."));
  await type("search", "Earlier");
  await until("the chat again", async () => (await count("chat-row")) > 0);
  check(true, "the chat search filters by title");

  // Long-press a live chat: Open, board, Close chat, Copy path.
  check(await longPress("chat-row"), "a long press opens the chat sheet");
  await until("the chat sheet", () => exists('[data-testid="chat-sheet"]'));
  const sheet = await text();
  check(["Open", "Add to the board", "Close chat", "Copy path"].every((l) => sheet.includes(l)), "the chat sheet offers Open, Add to the board, Close chat and Copy path", sheet.slice(0, 300));
  await shot("9-chat-sheet");
  await click("act-add-board");
  await until("the card on the host", async () => ((await A.ok("board.get")).cards ?? []).length > 0);
  check(true, "Add to the board puts the chat on the board");
  await sleep(500);
  await longPress("chat-row");
  await until("the sheet again", () => exists('[data-testid="chat-sheet"]'));
  check((await text()).includes("Show on the board"), "after adding, the sheet offers Show on the board");
  await click("act-show-board");
  await until("the board page", () => exists('[data-testid="board-screen"]'));
  check(await exists('[data-testid="card-page"]'), "Show on the board opens that card");
  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));

  // Kanban off: no board rows.
  const settings = await A.ok("settings.get");
  await A.ok("settings.apply", { op: { type: "feature", feature: "kanban", enabled: false }, baseRev: settings.rev });
  await sleep(600);
  await longPress("chat-row");
  await until("the sheet", () => exists('[data-testid="chat-sheet"]'));
  const quiet = await text();
  check(!(await exists('[data-testid="act-add-board"]')) && !(await exists('[data-testid="act-show-board"]')) && quiet.includes("Close chat"), "with Kanban off the chat sheet has no board row", quiet.slice(0, 300));
  await click("act-open");
  await until("the chat", () => exists('[data-testid="send"]'));
  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));
  const settings2 = await A.ok("settings.get");
  await A.ok("settings.apply", { op: { type: "feature", feature: "kanban", enabled: true }, baseRev: settings2.rev });

  // Close chat asks first, then stops pi.
  await longPress("chat-row");
  await until("the sheet", () => exists('[data-testid="chat-sheet"]'));
  await click("act-close");
  await until("the confirmation", () => exists('[data-testid="confirm-close"]'));
  await shot("10-close-confirm");
  check((await A.ok("chat.live")).some((c) => c.handle === handle), "before confirming, the chat is still live");
  await click("confirm-close-go");
  await until("the chat to close on the host", async () => !(await A.ok("chat.live")).some((c) => c.handle === handle));
  check(true, "confirming Close chat stops the chat on the host");

  // A chat started here shows in the lists before pi writes its file (fake-pi never does) and the index catches up.
  const rowsBefore = await count("chat-row");
  await click("new-chat");
  await until("the new chat", () => exists('[data-testid="send"]'));
  await phone.eval("document.querySelector('textarea').focus()");
  await phone.send("Input.insertText", { text: "Brand new phone chat" });
  await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
  await phone.eval(`document.querySelector('[data-testid="send"]').click()`);
  await until("the chat to be live on the host", async () => (await A.ok("chat.live")).some((c) => c.listed));
  const started = (await A.ok("chat.live")).find((c) => c.listed);
  check(!(await A.ok("chat.list")).some((p) => p.sessions.some((s) => s.path === started.sessionPath)), "the new chat has no index row yet");
  await tapBack();
  await until("the chats screen", () => exists('[data-testid="new-chat"]'));
  await until("the new chat in the list", async () => (await count("chat-row")) === rowsBefore + 1);
  await shot("10b-new-chat-listed");
  check(true, "a chat started on the phone shows in Chats before its file is indexed");

  // Projects: search, pin, long-press sheet, folder browser.
  await tapBack();
  await until("the projects screen", () => exists('[data-testid="open-folder"]'));
  await sleep(500);
  await shot("11-projects");
  await longPress("project-row");
  await until("the project sheet", () => exists('[data-testid="project-sheet"]'));
  const psheet = await text();
  check(["New chat", "Pin project", "Kanban board", "Copy path"].every((l) => psheet.includes(l)), "the project sheet offers New chat, Pin project, Kanban board and Copy path", psheet.slice(0, 300));
  await shot("12-project-sheet");
  await click("act-pin");
  await until("the pin on the host", async () => (await A.ok("ui.get")).pins.length === 1);
  check(true, "Pin project is saved on the host");
  await sleep(500);
  check(await phone.eval(`!!document.querySelector('[data-testid="project-row"] svg.icon-pin')`), "the pinned project shows its pin");
  await shot("13-pinned");
  await type("search", "nothing-like-this-zz");
  await until("no match", present("No project matches."));
  await type("search", "");

  await click("open-folder");
  await until("the folder picker", () => exists('[data-testid="folder-picker"]'));
  await until("folders", async () => (await count("host-folder")) > 0);
  await shot("14-folder-picker");
  const before = await count("host-folder");
  await click("toggle-hidden");
  await until("hidden folders", async () => (await count("host-folder")) >= before);
  await shot("15-folder-picker-hidden");
  await click("open-this-folder");
  await until("a new chat", () => exists('[data-testid="send"]'));
  check(true, "opening a folder starts a new chat there");
  await shot("16-new-chat");
}
