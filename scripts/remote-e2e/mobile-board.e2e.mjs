#!/usr/bin/env node
// The phone's Kanban board: columns with counts, card edits with conflicts, tags, GitHub links, moves, drag reorder, add card with a
// photo, and the card's task chats.
import { sleep, log, check, until, project, png, Phone, openPhone, scenario } from "./harness.mjs";

await scenario("mobile board", async (ctx) => {
  const { A, sessionFile } = ctx;
  // A card with the seeded chat on it, as "Add to the board" on the Chats screen makes one.
  const chatCard = "chat01";
  await A.ok("board.apply", { op: { type: "add", id: chatCard, title: "Earlier question 1", cwd: project, column: "in_progress" }, baseRev: (await A.ok("board.get")).rev });
  await A.ok("board.apply", { op: { type: "attach", id: chatCard, chat: { path: sessionFile, cwd: project, label: "Earlier question 1" } } });
  const { phone, shot, text, exists, present } = await openPhone(ctx);
  await boardChecks({ phone, A, shot, text, exists, present });
});

/** The phone's Kanban board (T29): columns with counts, card sheet edits with conflicts, moves, drag reorder, add card with a photo, task chats. */
async function boardChecks({ phone, A, shot, text, exists, present }) {
  log("mobile board parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const titles = () => phone.eval(`[...document.querySelectorAll('[data-testid="card-row"] span.flex-1')].map((e) => e.innerText)`);
  const tabCounts = () => phone.eval(`Object.fromEntries([...document.querySelectorAll('[role=tab]')].map((e) => [e.dataset.testid, e.querySelector('[data-testid=column-count]').innerText]))`);
  const card = async (id) => (await A.ok("board.get")).cards.find((c) => c.id === id);
  const typeInto = async (testId, t) => {
    await phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); e.focus(); e.select?.(); })()`);
    await phone.send("Input.insertText", { text: t });
  };
  const blur = () => phone.eval("document.activeElement?.blur()");

  const existing = (await A.ok("board.get")).cards[0];
  const cwd = existing.cwd;
  const seeded = [
    { id: "bdone1", title: "Seeded first card", tags: ["ui", "mobile"], column: "todo", notes: "Needs **bold** notes" },
    { id: "bdone2", title: "Seeded second card", column: "todo", github: [{ kind: "issue", host: "github.com", repo: "o/r", number: 12, url: "https://github.com/o/r/issues/12", title: "An issue" }] },
    { id: "bdone3", title: "Seeded third card", column: "todo" },
    { id: "bdone4", title: "Seeded review card", column: "in_review" },
  ];
  for (const op of seeded) await A.ok("board.apply", { op: { type: "add", cwd, before: null, ...op } });
  await A.ok("board.apply", { op: { type: "report", id: "bdone4", text: "Checked and works", column: "in_review" } });

  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("the project sheet", () => exists('[data-testid="act-board"]'));
  await click("act-board");
  await until("the board", () => exists('[data-testid="board-screen"]'));
  await until("the todo cards", async () => (await count("card")) === 3);
  const counts = await tabCounts();
  check(counts["column-todo"] === "3" && counts["column-in_review"] === "1" && counts["column-in_progress"] === "1", "the segmented control carries each column's count", counts);
  const first = await phone.eval(`document.querySelector('[data-testid="card-row"]').innerText`);
  check(first.includes("ui") && first.includes("mobile"), "a card row shows its tags", first);
  check((await count("github-badge")) === 1 && (await phone.eval(`document.querySelector('[data-testid=github-badge]').innerText`)).includes("12"), "a card row shows its GitHub badge");
  await shot("23-board");

  // Marks and counts of a card with a chat: the in-progress card is the chat added from the Chats screen.
  await click("column-in_progress");
  await until("the in-progress card", async () => (await count("card")) === 1);
  check((await count("chat-count")) === 1, "a card with an attached chat shows the chat count");
  await click("column-todo");

  // Card page: edit title/notes, tags, conflicts.
  await until("todo cards", async () => (await count("card")) === 3);
  await phone.eval(`document.querySelector('[data-testid="card-row"]').click()`);
  await until("the card page", () => exists('[data-testid="card-page"]'));
  check((await phone.eval(`!!document.querySelector('[data-testid="card-notes"] strong')`)), "notes render as Markdown");
  await shot("24-card-page");
  await typeInto("card-title", "Renamed on the phone");
  await blur();
  await until("the title on the host", async () => (await card("bdone1"))?.title === "Renamed on the phone");
  check(true, "editing the title saves it on the host");
  await click("card-notes");
  await until("the notes editor", () => exists('[data-testid="card-notes-edit"]'));
  await typeInto("card-notes-edit", "Phone notes");
  await blur();
  await until("the notes on the host", async () => (await card("bdone1"))?.notes === "Phone notes");
  check(true, "editing the notes saves them on the host");

  // A host edit lands while the phone has an unsaved edit: refused, the phone shows the host's text.
  await typeInto("card-title", "Phone draft");
  await A.ok("board.apply", { op: { type: "edit", id: "bdone1", title: "Host wins" } });
  await sleep(300);
  await typeInto("card-title", "Phone draft two");
  await blur();
  await sleep(800);
  check((await card("bdone1"))?.title === "Host wins", "a stale title edit does not overwrite the host's", (await card("bdone1"))?.title);
  check((await phone.eval(`document.querySelector('[data-testid="card-title"]').value`)) === "Host wins", "the card page shows the host's text after a conflict");

  await typeInto("tag-input", "Extra Tag");
  await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await until("the tag on the host", async () => (await card("bdone1"))?.tags.includes("extra-tag"));
  await phone.eval(`document.querySelector('[aria-label="Remove ui"]').click()`);
  await until("the tag gone", async () => !(await card("bdone1"))?.tags.includes("ui"));
  check(true, "tags are added and removed on the host");
  check((await tapBackIfPage(phone)) === true, "closing the card page returns to the board");

  // GitHub links: unlink a seeded one; a link that gh cannot find shows its problem.
  await until("the cards", async () => (await count("card")) === 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card-row"]')].find((e) => e.innerText.includes("second")).click()`);
  await until("the card page", () => exists('[data-testid="card-github"]'));
  check((await count("card-github-ref")) === 1, "the card page lists its GitHub links");
  await typeInto("link-input", "zz-not-an-issue");
  await phone.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await until("a lookup problem", () => exists('[data-testid="link-error"]'), 30_000);
  check(true, "linking something that is not an issue or PR shows the lookup problem");
  await click("unlink");
  await until("the unlink on the host", async () => (await card("bdone2"))?.github.length === 0);
  check(true, "Unlink removes the link on the host");
  await shot("25-card-github");
  await tapBackIfPage(phone);

  // Move to…
  await until("the cards", async () => (await count("card")) === 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card"]')].find((e) => e.innerText.includes("third")).querySelector('[data-testid="card-actions"]').click()`);
  await until("the card menu", () => exists('[data-testid="card-menu"]'));
  const menu = await text();
  check(menu.includes("Investigate") && menu.includes("Resolve") && !menu.includes("QA"), "the card menu offers Investigate and Resolve, QA only in review", menu.slice(0, 200));
  await shot("26-card-menu");
  await click("move-in_progress");
  await until("the move on the host", async () => (await card("bdone3"))?.column === "in_progress");
  check(true, "Move to… moves the card on the host");

  // Reorder by long-press drag: the first todo card drops below the second.
  await until("two todo cards", async () => (await count("card")) === 2);
  const before = await titles();
  const rect = (i) => phone.eval(`(() => { const r = document.querySelectorAll('[data-testid="card-row"]')[${i}].getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2, h: r.height }; })()`);
  const r0 = await rect(0);
  const r1 = await rect(1);
  await phone.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r0.x, y: r0.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await sleep(700);
  for (let step = 1; step <= 6; step++) {
    await phone.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r0.x, y: r0.y + ((r1.y - r0.y + r1.h) * step) / 6, buttons: 1 });
    await sleep(40);
  }
  await phone.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r0.x, y: r1.y + r1.h, button: "left", buttons: 0, clickCount: 1 });
  await until("the order on the host", async () => {
    const todo = (await A.ok("board.get")).cards.filter((c) => c.cwd === cwd && c.column === "todo").map((c) => c.id);
    return todo[0] === "bdone2" && todo[1] === "bdone1";
  }, 8000).catch(() => undefined);
  const todoNow = (await A.ok("board.get")).cards.filter((c) => c.cwd === cwd && c.column === "todo").map((c) => c.id);
  check(todoNow[0] === "bdone2" && todoNow[1] === "bdone1", "a long-press drag reorders the column on the host", { before, todoNow });
  check(!(await exists('[data-testid="card-page"]')), "the drag does not open the card");

  // Add card with a photo.
  const photo = png(40, 40, [200, 40, 40]).toString("base64");
  await click("add-card");
  await until("the add sheet", () => exists('[data-testid="add-card-sheet"]'));
  await typeInto("add-card-text", "Fix the flicker on the phone board");
  await phone.eval(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(photo)}), (c) => c.charCodeAt(0)); const input = document.querySelector('[data-testid="add-card-file"]'); const dt = new DataTransfer(); dt.items.add(new File([bytes], "shot.png", { type: "image/png" })); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until("the photo uploaded", () => phone.eval(`document.querySelector('[data-testid="add-card-photo"]')?.dataset.state === "ready"`)).catch(async (e) => {
    throw new Error(`${e.message}: ${await phone.eval(`document.querySelector('[data-testid="add-card-sheet"]')?.innerText + ' | ' + document.querySelector('[data-testid="add-card-photo"]')?.dataset.state`)}`);
  });
  await shot("27-add-card");
  await click("add-card-submit");
  const added = await until("the new card on the host", async () => (await A.ok("board.get")).cards.find((c) => c.title.includes("flicker")));
  check(added.column === "todo" && added.notes.includes("Attachments") && added.notes.includes("shot.png"), "Add card sends the description and photo to the host's addCard", added.notes);
  await until("its triage chat", async () => (await card(added.id))?.chats.length > 0, 30_000).catch(() => undefined);
  check((await card(added.id))?.chats.length > 0, "the host starts the new card's triage chat");

  // Card actions: Investigate opens a chat on the card; Chat about it carries the card.
  await until("the cards", async () => (await count("card")) >= 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card-row"]')].find((e) => e.innerText.includes("second")).click()`);
  await until("the card page", () => exists('[data-testid="card-task-investigate"]'));
  await click("card-task-investigate");
  await until("the investigate chat", () => exists('[data-testid="send"]'), 30_000);
  await until("the chat on the card", async () => (await card("bdone2"))?.chats.length > 0, 30_000);
  check(true, "Investigate starts a chat on the host and attaches it to the card");
  await shot("28-investigate-chat");
  await tapBack();
  await until("the board", () => exists('[data-testid="board-screen"]'));
  await until("the cards", async () => (await count("card")) >= 3);
  await phone.eval(`[...document.querySelectorAll('[data-testid="card-row"]')].find((e) => e.innerText.includes("second")).click()`);
  await until("the card page", () => exists('[data-testid="card-task-discuss"]'));
  await click("card-task-discuss");
  await until("the new chat", () => exists('[data-testid="card-chip"]'));
  check(true, "Chat about it opens a new chat with the card in its composer");
  await phone.eval("document.querySelector('textarea').focus()");
  await phone.send("Input.insertText", { text: "what is this card?" });
  await click("send");
  await until("the second chat on the card", async () => (await card("bdone2"))?.chats.length > 1, 30_000);
  check(true, "sending joins the chat to the card");
  await tapBack();
  await until("the board", () => exists('[data-testid="board-screen"]'));
}

async function tapBackIfPage(phone) {
  await phone.eval(`document.querySelector('[data-testid="card-page"] [aria-label="Back"]').click()`);
  await sleep(300);
  return phone.eval(`!document.querySelector('[data-testid="card-page"]')`);
}
