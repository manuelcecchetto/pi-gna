#!/usr/bin/env node
// The remote app on a wide screen (a TV, an iPad): the list stays on the left and the chat opens beside it; the page tells
// a driving client (the TV app) which chat or project is on screen, and opens a chat when asked.
import { sleep, log, check, until, project, openPhone, scenario } from "./harness.mjs";

const TV = { width: 960, height: 540, deviceScaleFactor: 2, mobile: false, screenOrientation: { type: "landscapePrimary", angle: 0 } };
const IPAD = { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 0 } };
const IPHONE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: "portraitPrimary", angle: 0 } };

await scenario("mobile split view", async (ctx) => {
  const { A } = ctx;
  const handle = await ctx.openChat();
  const { phone, shot, exists, present, tap } = await openPhone(ctx);
  const screen = () => phone.eval("JSON.stringify(window.pignaScreen ?? null)").then(JSON.parse);
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);

  log("TV size: projects on the left, nothing open beside them");
  await phone.send("Emulation.setDeviceMetricsOverride", TV);
  await until("the split", () => exists('[data-testid="split"]'));
  await until("the projects list", () => exists('[data-testid="project-row"]'));
  check(await exists('[data-testid="detailless"]'), "beside the projects, the right side says what to pick");
  check((await screen())?.cwd === undefined, "on the projects list no project is on screen", await screen());
  await shot("1-tv-projects");

  log("a project: its chats on the left, a new-chat offer on the right");
  await click("project-row");
  await until("the chats list", () => exists('[data-testid="chat-row"]'));
  check(await exists('[data-testid="detailless-new-chat"]'), "the right side offers a new chat in the project");
  check((await screen())?.cwd === project, "the project is on screen", await screen());
  await shot("2-tv-chats");

  log("a chat opens beside the list, marked in it");
  await tap("Earlier question 1");
  await until("the chat", () => exists('[data-testid="send"]'));
  await until("the chat's handle on screen", async () => (await screen())?.handle === handle);
  check(await exists('[data-testid="chat-row"]'), "the chat list stays on the left");
  check(await phone.eval(`document.querySelector('[data-testid="chat-row"][aria-current="true"]')?.innerText.includes("Earlier question 1") ?? false`), "the open chat is marked in the list");
  await until("the transcript", present("Earlier answer 3."));
  await shot("3-tv-chat");

  log("the list's Back goes to the projects");
  await phone.eval(`document.querySelector('[data-testid="split"] > div:first-child [aria-label="Back"]').click()`);
  await until("the projects list", () => exists('[data-testid="project-row"]'));
  check(!(await exists('[data-testid="send"]')), "leaving the project closes the chat beside it");
  check((await screen())?.handle === undefined, "no chat is on screen any more", await screen());

  log("a driving client opens a chat it started");
  const { handle: started } = await A.ok("chat.open", { request: { cwd: project } });
  await phone.eval(`window.dispatchEvent(new CustomEvent("pigna-open-chat", { detail: ${JSON.stringify(started)} })), true`);
  await until("the started chat", async () => (await screen())?.handle === started);
  check(await exists('[data-testid="send"]'), "pigna-open-chat opens the chat");
  await shot("4-tv-opened-chat");

  log("iPad landscape: split too");
  await phone.send("Emulation.setDeviceMetricsOverride", IPAD);
  await sleep(400);
  check(await exists('[data-testid="split"]'), "an iPad in landscape shows the split");
  await shot("5-ipad-chat");

  log("iPhone: the stack as before");
  await phone.send("Emulation.setDeviceMetricsOverride", IPHONE);
  await until("no split", async () => !(await exists('[data-testid="split"]')));
  check(!(await exists('[data-testid="chat-row"]')), "the phone shows the chat alone");
  await shot("6-phone-chat");
});
