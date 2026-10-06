#!/usr/bin/env node
// The phone's transcript extras on the seeded "Tools demo" session: tool sheets, expand all, images and the lightbox, links, visuals
// with their watchdog, the turn list and bookmarks.
import { sleep, log, check, until, project, png, request, openPhone, scenario } from "./harness.mjs";

await scenario("mobile transcript", async (ctx) => {
  const { A } = ctx;
  const { phone, shot, text, tap, exists, present } = await openPhone(ctx);
  await transcriptChecks({ phone, A, shot, text, tap, exists, present });
});

/** The phone's transcript extras (T28): tool sheets, expand all, images and the lightbox, the turn list and bookmarks, visuals, copy, links, times. */
async function transcriptChecks({ phone, A, shot, text, tap, exists, present }) {
  log("mobile transcript extras");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (selector) => phone.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const clickText = (selector, label) => phone.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const scale = () => phone.eval(`(() => { const m = /scale\\(([\\d.]+)\\)/.exec(document.querySelector('[data-testid="lightbox"] img')?.style.transform ?? ""); return m ? Number(m[1]) : 0; })()`);
  const touch = (type, points) => phone.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });

  // Open the tools session: back out to Projects, then the project's list.
  for (let i = 0; i < 6 && !(await exists('[data-testid="open-settings"]')); i++) {
    await phone.eval(`document.querySelector('[aria-label="Back"]')?.click()`);
    await sleep(500);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await sleep(500);
  await tap("project");
  await until("the chats list", present("Tools demo"));
  check(await tap("Tools demo"), "the phone opens the tools session");
  await until("the tools transcript", present("Second answer."));
  await sleep(800);
  await shot("22-tools-chat");

  // Large images come by URL, not inside the JSON, and only to a paired device.
  const photo = await until("the user's photo to load", () =>
    phone.eval(`(() => { const img = [...document.images].find((i) => i.getAttribute("src")?.startsWith("/api/image/")); return img && img.complete && img.naturalWidth === 200 ? img.getAttribute("src") : ""; })()`),
  );
  check(true, "the transcript shows the large photo from /api/image/<id>");
  const fetched = await request(A.port, { path: photo, headers: A.headers() });
  check(fetched.status === 200 && fetched.headers["content-type"] === "image/png" && /immutable/.test(fetched.headers["cache-control"] ?? ""), "the image URL serves the PNG, cacheable", fetched.headers);
  const stranger = await request(A.port, { path: photo, headers: { ...A.headers(), cookie: "" } });
  check(stranger.status === 401 || stranger.status === 403, "an unpaired browser cannot load it", stranger.status);

  // Tool detail sheets.
  check(await clickText("button", "Worked"), "the first turn's work accordion opens");
  await until("the tool rows", present("ls --color"));
  check(!(await exists('[data-testid="tool-sheet"]')), "a tool's details start closed");
  check(await clickText("button", "ls --color"), "tapping a bash call opens its sheet");
  await until("the bash sheet", () => exists('[data-testid="tool-sheet"]'));
  const sheet = () => phone.eval(`document.querySelector('[data-testid="tool-sheet"]')?.innerText ?? ''`);
  check((await sheet()).includes("red-file") && !(await sheet()).includes("[31m"), "bash output shows without raw ANSI codes", await sheet());
  check((await sheet()).includes("Copy output"), "the sheet offers copying the output");
  await shot("23-bash-sheet");
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);
  check(await clickText("button", "src/a.ts"), "tapping an edit opens its sheet");
  await until("the edit sheet", () => exists('[data-testid="tool-sheet"]'));
  check(
    await phone.eval(`[...document.querySelectorAll('[data-testid="tool-sheet"] .overflow-auto')].some((e) => e.scrollWidth > e.clientWidth + 20)`),
    "the diff scrolls sideways instead of wrapping its long line",
  );
  await shot("24-edit-sheet");
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);
  check(await clickText("button", "frobnicate"), "a generic tool opens its sheet");
  await until("the generic sheet", () => exists('[data-testid="tool-sheet"]'));
  check((await sheet()).includes('"level": 3') && (await sheet()).includes("frobbed"), "the generic sheet shows the JSON arguments and the result", await sheet());
  await phone.eval(`document.querySelector('[aria-label="Close"]').click()`);

  // Expand all.
  const rowsClosed = await count('[data-testid="tool-sheet"]');
  check(rowsClosed === 0, "no sheet is left open");
  check(!(await text()).includes("const veryLongLine"), "steps are collapsed before Expand all");
  check(await click("expand-all"), "the header's Expand all is tapped");
  await until("the steps open inline", present("const veryLongLine"));
  // The tool's screenshot shows with its step; the user's photo always does.
  check((await count("img")) >= 2, "the transcript shows the message's image and the tool's image", await phone.eval(`[...document.images].map((i) => i.getAttribute("src")?.slice(0, 40))`));
  await click("expand-all");
  await until("the steps close again", async () => !(await text()).includes("const veryLongLine"));

  // Images and the lightbox.
  check(await phone.eval(`(() => { const i = document.querySelector('button img'); i.closest('button').click(); return true; })()`), "an image is tapped");
  await until("the lightbox", () => exists('[data-testid="lightbox"]'));
  check((await scale()) === 1, "the lightbox opens at fit size");
  const [cx, cy] = [196, 426];
  await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
  await touch("touchMove", [[cx - 90, cy], [cx + 90, cy]]);
  await touch("touchEnd", []);
  await sleep(300);
  const zoomed = await scale();
  check(zoomed > 1.5, "a two-finger spread zooms the image", zoomed);
  await shot("25-lightbox-zoom");
  check(await phone.eval(`document.querySelector('[data-testid="lightbox"] img').tagName === "IMG" && !document.querySelector('[data-testid="lightbox"] img').closest("a,button")`), "the image is a plain <img>, so iOS offers Save and Copy on a long press");
  check(await phone.eval(`(() => { document.querySelector('[aria-label="Close image"]').click(); return true; })()`), "the lightbox's close button is tapped");
  await until("the lightbox to close", async () => !(await exists('[data-testid="lightbox"]')));

  // Times on tap, copy, links.
  check(!(await exists('[data-testid="user-stamp"]')), "no time is shown on a message until it is tapped");
  check(await phone.eval(`(() => { document.querySelector('[data-user-bubble]').click(); return true; })()`), "a message is tapped");
  await until("the message time", () => exists('[data-testid="user-stamp"]'));
  check(await phone.eval(`!!document.querySelector('[title="Copy answer"]')`), "a finished answer has a copy button");
  await phone.eval(`window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null; }; true`);
  check(await phone.eval(`(() => { const a = [...document.querySelectorAll("a")].find((x) => x.href.startsWith("https://example.com/docs")); if (!a) return false; a.click(); return true; })()`), "a link in an answer is tapped");
  check((await phone.eval("window.__opened")).includes("https://example.com/docs"), "links open in the phone's browser", await phone.eval("window.__opened"));

  // Visuals: tap to render, sandboxed frame from the host, watchdog.
  // The settings checks left Inline visuals however they found it: switch it on from the host; the phone follows live.
  const current = await A.ok("settings.get");
  if (!current.visuals) await A.ok("settings.apply", { op: { type: "visuals", on: true }, baseRev: current.rev });
  await until("the visual placeholders", () => exists('[data-testid="visual-tap"]'));
  check((await count("iframe")) === 0, "no visual runs before it is tapped");
  check(await click("visual-tap"), "the first visual is tapped");
  await until("the visual frame", () => exists("iframe.visual-frame"));
  const frame = await phone.eval(`(() => { const f = document.querySelector("iframe.visual-frame"); return { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src") }; })()`);
  check(frame.sandbox === "allow-scripts", "the frame is sandboxed with scripts only (opaque origin)", frame.sandbox);
  check(/^\/visual\/[0-9a-f]{16}\/doc$/.test(frame.src), "the frame loads from the host's /visual path", frame.src);
  await until("the frame to size itself", () => phone.eval(`document.querySelector("iframe.visual-frame").offsetHeight > 41`), 15_000, 200).catch(async (error) => {
    log(`  frame: ${await phone.eval(`(() => { const f = document.querySelector("iframe.visual-frame"); return JSON.stringify({ h: f?.offsetHeight, err: document.querySelector(".visual-error")?.innerText }); })()`)}`);
    throw error;
  });
  await shot("26-visual");
  const headers = await phone.eval(`fetch(${JSON.stringify(frame.src)}).then((r) => ({ status: r.status, csp: r.headers.get("content-security-policy") }))`);
  check(headers.status === 200 && /default-src 'none'/.test(headers.csp) && /connect-src 'none'/.test(headers.csp), "the frame document carries the visual CSP", headers);
  // The second visual stops its heartbeat: the watchdog removes the frame and shows the source.
  check(await phone.eval(`(() => { const t = [...document.querySelectorAll('[data-testid="visual-tap"]')]; if (!t[0]) return false; t[0].click(); return true; })()`), "the second visual is tapped");
  await until("the watchdog to fire", present("Visual stopped responding"), 20_000, 500);
  check((await count("iframe.visual-frame")) === 1, "the stuck frame is removed (the healthy one stays)");
  check((await text()).includes("clearInterval"), "its source is shown instead");
  await shot("27-visual-stuck");

  // Turn list and bookmarks (the host keeps them).
  check(await click("turn-list-button"), "the turn list button is tapped");
  await until("the turn list", () => exists('[data-testid="turn-list"]'));
  check((await count('[data-testid="turn-row"]')) === 2, "the list has one row per message sent", await count('[data-testid="turn-row"]'));
  await shot("28-turn-list");
  check(await phone.eval(`(() => { document.querySelector('[data-testid="turn-list"] [aria-label="Bookmark"]').click(); return true; })()`), "the first turn's star is tapped");
  await until("the host to hold the bookmark", async () => Object.values((await A.ok("ui.get")).bookmarks ?? {}).some((marks) => marks.length === 1));
  check(true, "the bookmark is in the host's ui state");
  await phone.eval(`window.__flashes = 0; const animate = Element.prototype.animate; Element.prototype.animate = function (...args) { window.__flashes++; return animate.apply(this, args); }; true`);
  check(await clickText('[data-testid="turn-row"]', "Second turn"), "the second turn's row is tapped");
  await until("the list to close", async () => !(await exists('[data-testid="turn-list"]')));
  await until("the view to scroll to the second turn", () => phone.eval(`(() => { const s = document.querySelector('[data-run]:last-of-type'); const sc = s?.closest(".overflow-y-auto"); return !!sc && sc.scrollTop > 0; })()`), 8_000, 100);
  check((await phone.eval("window.__flashes")) >= 1, "the jump flashes the message");
  await shot("29-after-jump");
}
