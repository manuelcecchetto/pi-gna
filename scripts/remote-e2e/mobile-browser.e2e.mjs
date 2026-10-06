#!/usr/bin/env node
// The phone's Browser screen driving a local dev page in the host's browser (taps, typing, keys, scroll, pinch, comments that ride
// with a prompt or Send now), then chat links opening the Mac's preview, board and browser.
import { writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { sleep, log, check, until, project, openPhone, scenario } from "./harness.mjs";

await scenario("mobile browser and links", async (ctx) => {
  const { A } = ctx;
  await ctx.openChat();
  const { phone, shot, text, tap, exists, present } = await openPhone(ctx);
  await browserChecks({ phone, A, shot, text, tap, exists, present });
  await linkChecks({ phone, A, shot, text, exists });
});

/** The phone's browser screen (T36): drive a local dev page in the instance's own browser with the iPhone preset, the instance's window hidden. */
async function browserChecks({ phone, A, shot, text, tap, exists, present }) {
  log("mobile browser screen");
  const hits = [];
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/hit") {
      hits.push([url.searchParams.get("k"), url.searchParams.get("v")]);
      return res.end("ok");
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Dev page</title><body style="margin:0;height:4000px">
<button id=b style="position:fixed;left:100px;top:200px;width:160px;height:80px">tap me</button>
<input id=i style="position:fixed;left:20px;top:320px;width:300px;height:40px">
<script>const hit=(k,v)=>fetch('/hit?k='+k+'&v='+encodeURIComponent(v||''));
b.onclick=()=>hit('click');i.oninput=()=>hit('input',i.value);addEventListener('keydown',e=>hit('key',e.key));addEventListener('scroll',()=>hit('scroll',scrollY));</script>`);
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const hit = (k) => hits.filter(([key]) => key === k);
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const touch = (type, points) => phone.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const rect = () => phone.eval(`(() => { const r = document.querySelector('[data-testid="frame"]')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; })()`);
  const onFrame = async (cssX, cssY) => {
    const r = await rect();
    return [r.left + (cssX / 393) * r.width, r.top + (cssY / 852) * r.height];
  };
  const tapPage = async (cssX, cssY) => {
    const [x, y] = await onFrame(cssX, cssY);
    await touch("touchStart", [[x, y]]);
    await touch("touchEnd", []);
  };
  const typeInto = async (testId, t) => {
    await phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); e.focus(); e.select(); })()`);
    await phone.send("Input.insertText", { text: t });
  };

  try {
    // The browser opens from a chat's header; the tab belongs to the Mac's chat, so "All tabs" shows it.
    await phone.eval("localStorage.removeItem('pigna:mobile-last-project'); location.href = '/'");
    await until("the projects screen", () => exists('[data-testid="open-folder"]'), 30_000, 250);
    check(!(await exists('[data-testid="open-browser"]')), "the projects header has no browser button");
    await A.ok("browser.newTab", { url });
    check(await tap("project"), "the projects list");
    await until("the chats screen", present("Earlier question 1"));
    await tap("Earlier question 1");
    await until("the chat's browser button", () => exists('[data-testid="open-browser"]'), 30_000, 250);
    check(await click("open-browser"), "the chat header opens the browser");
    await until("the browser screen", () => exists('[data-testid="all-tabs"]'));
    check(await click("all-tabs"), "All tabs shows tabs other chats own");
    await until("the tab", async () => (await text()).includes("Dev page"), 20_000, 100);
    check(!(await exists('[data-testid="window-badge"]')), "a pane tab is not marked as a window");
    await click("viewport-open");
    await until("the viewport sheet", () => exists('[data-testid="viewport-sheet"]'));
    check(await phone.eval(`(() => { const e = [...document.querySelectorAll('[data-testid="viewport-option"]')].find((x) => x.innerText.includes("iPhone 15")); if (!e) return false; e.click(); return true; })()`), "the viewport sheet offers the iPhone 15 preset");
    await until("the viewport on the host", async () => (await A.ok("browser.state")).tabs.some((t) => t.viewport?.label === "iPhone 15"));
    check(true, "the host tab runs the iPhone 15 viewport");
    await until("the frame", () => phone.eval(`(() => { const i = document.querySelector('[data-testid="frame"]'); return !!i && i.complete && i.naturalWidth > 0; })()`), 30_000, 200);
    await sleep(800);
    await shot("browser-1-frame");
    check(true, "the stream draws a frame of the page with the instance's window hidden");

    await tapPage(180, 240);
    await until("the tap to land", async () => hit("click").length > 0, 10_000, 100);
    check(true, "a tap on the frame clicks the page's button on the host");

    await tapPage(100, 340);
    await sleep(500);
    await typeInto("type-field", "hello");
    await click("type-send");
    await until("the typed text", async () => hit("input").some(([, v]) => v === "hello"), 10_000, 100);
    check(true, "the text field types into the focused input");
    await click("keys-open");
    await until("the keys sheet", () => exists('[data-testid="key-Enter"]'));
    await click("key-Enter");
    await until("the Enter key", async () => hit("key").some(([, v]) => v === "Enter"), 10_000, 100);
    check(true, "a key button sends the key to the page");
    await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);

    const [fx, fy] = await onFrame(196, 500);
    await touch("touchStart", [[fx, fy]]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [[fx, fy - i * 25]]);
      await sleep(40);
    }
    await touch("touchEnd", []);
    await until("the page to scroll", async () => hit("scroll").some(([, v]) => Number(v) > 100), 10_000, 100);
    check(true, "dragging on the frame scrolls the page", hit("scroll"));

    const [cx, cy] = await onFrame(196, 426);
    await touch("touchStart", [[cx - 20, cy], [cx + 20, cy]]);
    for (let i = 1; i <= 6; i++) {
      await touch("touchMove", [[cx - 20 - i * 10, cy], [cx + 20 + i * 10, cy]]);
      await sleep(30);
    }
    await touch("touchEnd", []);
    await until("the zoom", () => exists('[data-testid="zoom-reset"]'));
    check((await phone.eval(`new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="frame"]')).transform).a`)) > 1.5, "two fingers zoom the picture locally");
    await shot("browser-2-zoomed");
    await click("zoom-reset");
    check(!(await exists('[data-testid="zoom-reset"]')), "the reset button restores the fit");

    // Address bar with history suggestions, then reload.
    await typeInto("address", "127.0");
    await until("a suggestion", () => exists('[data-testid="suggestion"]'));
    check(true, "the address bar suggests visited pages");
    await phone.eval(`document.querySelector('[data-testid="address"]').blur()`);
    await click("nav-reload");

    // Comment mode.
    await click("comment-mode");
    await sleep(300);
    await tapPage(180, 240);
    await until("the comment sheet", () => exists('[data-testid="comment-sheet"]'));
    await typeInto("comment-text", "make this bigger");
    await click("comment-add");
    await until("the annotation chip", () => exists('[data-testid="annotation-chip"]'), 20_000, 100);
    check(true, "comment mode turns a tap into an annotation chip");
    await shot("browser-3-comment");
    await click("comment-mode");

    // The chip rides with this phone's next prompt.
    await phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
    await until("the composer", () => exists('[data-testid="send"]'));
    check(await exists('[data-testid="annotation-chip"]'), "the composer shows the comment chip");
    await phone.eval("document.querySelector('textarea').focus()");
    await phone.send("Input.insertText", { text: "echo-attach zzcomment" });
    await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
    await phone.eval(`document.querySelector('[data-testid="send"]').click()`);
    await until("the host's echo", async () => /zzcomment[^]*\[images=\d\]/.test(await text()), 30_000, 200);
    const echoed = await text();
    check((() => { const tail = echoed.slice(echoed.indexOf("zzcomment")); return tail.includes("Browser comments (1)") && tail.includes("[images=1]"); })(), "the host composed the comment and its crop into the prompt", echoed.slice(-300));
    check(!(await exists('[data-testid="annotation-chip"]')), "the chip is gone once the prompt was taken");

    // Send now in the comment sheet: the comment goes to the chat the browser opened from at once, with its crop.
    await until("the chat to be idle", async () => !(await exists('[data-testid="stop"]')), 60_000, 250);
    check(await click("open-browser"), "the chat header opens the browser again");
    await until("the browser screen", () => exists('[data-testid="all-tabs"]'));
    await click("all-tabs");
    await until("the frame", () => phone.eval(`(() => { const i = document.querySelector('[data-testid="frame"]'); return !!i && i.complete && i.naturalWidth > 0; })()`), 30_000, 200);
    await click("comment-mode");
    await sleep(300);
    await tapPage(180, 240);
    await until("the comment sheet", () => exists('[data-testid="comment-sheet"]'));
    await typeInto("comment-text", "echo-attach zzsendnow");
    check(await phone.eval(`!document.querySelector('[data-testid="comment-send"]').disabled`), "the comment sheet offers Send now in a chat's browser");
    await shot("browser-4-send-now");
    await click("comment-send");
    await until("the sheet to close", async () => !(await exists('[data-testid="comment-sheet"]')), 20_000, 100);
    check(!(await exists('[data-testid="annotation-chip"]')), "Send now leaves no comment waiting");
    await click("comment-mode");
    await phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
    // The comment lives in the block (rendered as the "Browser comments" disclosure); fake pi echoes the crop count.
    const count = (pattern) => text().then((t) => (t.match(pattern) ?? []).length);
    await until("the chat's echo of the sent comment", async () => (await count(/\[images=1\]/g)) >= 2, 30_000, 200);
    check((await count(/Browser comments \(1\)/g)) >= 2, "the chat shows the comment block Send now sent, with its crop");

    // A transport failure after picking keeps one saved comment, but closes the sheet so retry cannot pick it twice.
    await until("the chat to be idle", async () => !(await exists('[data-testid="stop"]')), 60_000, 250);
    await click("open-browser");
    await until("the browser screen", () => exists('[data-testid="all-tabs"]'));
    await click("all-tabs");
    await until("the frame", () => phone.eval(`(() => { const i = document.querySelector('[data-testid="frame"]'); return !!i && i.complete && i.naturalWidth > 0; })()`), 30_000, 200);
    await click("comment-mode");
    await sleep(300);
    await tapPage(180, 240);
    await until("the comment sheet", () => exists('[data-testid="comment-sheet"]'));
    await typeInto("comment-text", "keep this once");
    await phone.eval(`(() => {
      window.__commentFetch = window.fetch;
      window.fetch = (input, init) => new URL(typeof input === "string" ? input : input.url, location.href).pathname === "/api/call/chat.send"
        ? Promise.reject(new TypeError("test: send unavailable")) : window.__commentFetch(input, init);
    })()`);
    try {
      await click("comment-send");
      await until("the saved sheet to close after Send fails", async () => !(await exists('[data-testid="comment-sheet"]')), 20_000, 100);
      check(await phone.eval(`document.querySelectorAll('[data-testid="annotation-chip"]').length === 1`), "failed Send keeps exactly one comment without inviting another pick");
      check((await text()).includes("Comments kept for your next message."), "failed Send explains how to recover");
      await shot("browser-5-send-failed");
    } finally {
      await phone.eval("window.fetch = window.__commentFetch; delete window.__commentFetch");
    }

    // The next comment sends both saved comments and both crops, once each.
    await tapPage(100, 340);
    await until("the next comment sheet", () => exists('[data-testid="comment-sheet"]'));
    await typeInto("comment-text", "echo-attach zzretry");
    await click("comment-send");
    await until("the recovered sheet to close", async () => !(await exists('[data-testid="comment-sheet"]')), 20_000, 100);
    check(!(await exists('[data-testid="annotation-chip"]')), "recovered Send clears the saved batch");
    await click("comment-mode");
    await phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
    await until("the chat's echo of both crops", async () => (await count(/\[images=2\]/g)) >= 1, 30_000, 200);
    check((await count(/Browser comments \(2\)/g)) === 1, "recovered Send delivers both comments to the originating chat once");
  } finally {
    fixture.close();
  }
}

/** Chat links on the phone: a project file opens the Mac's preview, a card the board, a localhost page the Mac's browser; a file outside the chat's folders stays text. Starts in a chat. */
async function linkChecks({ phone, A, shot, text, exists }) {
  log("mobile chat links");
  const click = (selector) => phone.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const fixture = http.createServer((_req, res) => res.end("<!doctype html><title>Local page</title><h1>Local page</h1>"));
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  writeFileSync(join(project, "notes.md"), "# Notes from the project\n\nA second line.\n");
  const board = await A.ok("board.get");
  await A.ok("board.apply", { op: { type: "add", id: "lk7q2p", title: "Linked card", cwd: project, column: "todo" }, baseRev: board.rev });
  try {
    await until("the composer", () => exists('[data-testid="send"]'), 30_000, 200);
    // A prompt sent while the chat runs is queued; the answer must be the next one.
    await until("the chat to be idle", async () => !(await exists('[data-testid="stop"]')), 60_000, 250);
    await phone.eval("document.querySelector('textarea').focus()");
    await phone.send("Input.insertText", { text: `say: See [the notes](notes.md:2), [the hosts file](/etc/hosts), [the card](lk7q2p) and [the dev page](${url}).` });
    await until("Send to enable", () => phone.eval(`!document.querySelector('[data-testid="send"]').disabled`));
    await click('[data-testid="send"]');
    await until("the project file link", () => exists(".prose [data-file][data-resolved]"), 30_000, 200);
    await until("the card link", () => exists(".prose [data-card][data-checked]"), 10_000, 200);
    check(await phone.eval(`[...document.querySelectorAll(".prose .file-missing")].some((e) => e.textContent.includes("the hosts file"))`), "a file outside the chat's folders stays plain text");
    await shot("links-1-answer");

    check(await click(".prose [data-file][data-resolved]"), "the project file link is tappable");
    await until("the preview on the browser screen", () => exists('[data-testid="browser-screen"] [data-testid="preview-icon"]'), 20_000, 200);
    const tabs = (await A.ok("browser.state")).tabs.filter((t) => t.preview?.path?.endsWith("notes.md"));
    check(tabs.length === 1 && !!tabs[0].agent, "the host opened the file in a preview tab the chat owns", tabs);
    await until("the phone-sized preview", async () => (await A.ok("browser.state")).tabs.some((t) => t.preview?.path?.endsWith("notes.md") && t.viewport?.width === 393), 10_000, 200);
    check(true, "the preview is laid out at the phone's size");
    await until("the preview frame", () => phone.eval(`(() => { const i = document.querySelector('[data-testid="frame"]'); return !!i && i.complete && i.naturalWidth > 0; })()`), 30_000, 200);
    check(true, "the phone streams the Mac's preview");
    await shot("links-2-preview");
    await tapBack();
    await until("the chat again", () => exists(".prose [data-card]"), 20_000, 200);

    check(await click(".prose [data-card]"), "the card link is tappable");
    await until("the card on the board", () => exists('[data-testid="card-page"]'), 20_000, 200);
    check((await text()).includes("Linked card"), "the card link opens that card");
    await shot("links-3-card");
    await tapBack();
    await until("the chat again", () => exists(`.prose a[href="${url}"]`), 20_000, 200);

    check(await click(`.prose a[href="${url}"]`), "the localhost link is tappable");
    await until("the page in the Mac's browser", async () => (await exists('[data-testid="browser-screen"]')) && (await text()).includes("Local page"), 20_000, 200);
    check(true, "a localhost link opens in the Mac's browser, not Safari");
    await shot("links-4-localhost");
    await tapBack();
    // Three Browser screens in a row: each closed its frame stream, or the phone would run out of connections here.
    await until("the chat again", () => exists('[data-testid="send"]'), 20_000, 200);
  } finally {
    fixture.close();
  }
}
