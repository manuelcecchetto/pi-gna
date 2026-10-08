#!/usr/bin/env node
// The phone's Laments page on the seeded laments: tabs, order, expansion with chat links, resolve and reopen, delete, Fix.
import { spawnSync } from "node:child_process";
import { sleep, log, check, until, project, openPhone, scenario } from "./harness.mjs";

await scenario("mobile laments", async (ctx) => {
  const { A } = ctx;
  const { phone, shot, text, exists, present } = await openPhone(ctx);
  await lamentChecks({ phone, A, shot, text, exists, present });
});

/** The phone's Laments page (T30): tabs, order, expansion with report/fix links, resolve/reopen, delete with confirmation, Fix. */
async function lamentChecks({ phone, A, shot, text, exists, present }) {
  log("mobile laments parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const titles = () => phone.eval(`[...document.querySelectorAll('[data-testid="lament"] [data-testid="lament-row"] span.flex-1')].map((e) => e.innerText)`);
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("the project sheet", () => exists('[data-testid="act-laments"]'));
  await click("act-laments");
  await until("the laments", () => exists('[data-testid="lament"]'));
  await sleep(400);
  const open = await titles();
  check(open.length === 2 && open[0].includes("record a browser tab") && open[1].includes("Slow grep"), "Open lists the worst lament first, then the milder one", open);
  await click("lament-sort");
  await until("newest first", async () => (await titles())[0]?.includes("Slow grep"));
  check((await text()).includes("Newest first"), "the sort switch lists the newest lament first");
  await shot("21-laments-newest");
  await click("lament-sort");
  await until("worst first again", async () => (await titles())[0]?.includes("record a browser tab"));
  check((await text()).includes("Worst first"), "and switches back to worst first");
  const body = await text();
  check(/Open\s*2/.test(body) && /Resolved\s*1/.test(body) && body.includes("×2"), "the tabs carry counts and the repeat shows ×2");
  await shot("21-laments");
  await click("lament-row");
  await until("the detail", () => exists('[data-testid="lament-detail"]'));
  check((await text()).includes("Hit again; blocking now") && (await phone.eval(`!!document.querySelector('[data-testid="lament-detail"] strong')`)), "expanding shows every report, as Markdown");
  check((await count("report-chat")) === 2, "each report links to the chat that filed it");
  await shot("22-lament-expanded");
  await click("report-chat");
  await until("the filing chat", () => exists('[data-testid="send"]'));
  check(true, "a report's chat link opens that chat");
  await tapBack();
  await until("the laments again", () => exists('[data-testid="lament"]'));

  const lamentState = async (id) => (await A.ok("laments.get")).laments.find((l) => l.id === id);
  await click("lament-actions");
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  const sheet = await text();
  check(["Fix", "Mark resolved", "Delete…"].every((l) => sheet.includes(l)), "the actions sheet offers Fix, Mark resolved and Delete");
  await shot("23-lament-sheet");
  await click("action-resolve");
  await until("resolved on the host", async () => Boolean((await lamentState("aaaaaa"))?.resolvedAt));
  check(true, "Mark resolved is saved on the host");
  await click("tab-resolved");
  await until("two resolved", async () => (await count("lament")) === 2);
  await phone.eval(`document.querySelector('[data-testid="lament-actions"]').click()`);
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  check(!(await exists('[data-testid="action-fix"]')) && (await text()).includes("Reopen"), "a resolved lament offers Reopen and no Fix");
  await click("action-resolve");
  await until("reopened on the host", async () => !(await lamentState("aaaaaa"))?.resolvedAt && !(await lamentState("cccccc") === undefined));
  check(true, "Reopen is saved on the host");
  await click("tab-open");
  await until("two open", async () => (await count("lament")) === 2);

  await phone.eval(`document.querySelectorAll('[data-testid="lament-actions"]')[1].click()`);
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  await click("action-delete");
  await until("the confirmation", () => exists('[data-testid="confirm-delete"]'));
  check(Boolean(await lamentState("bbbbbb")), "before confirming, the lament is still on the host");
  await shot("24-lament-delete");
  await click("confirm-delete");
  await until("deleted on the host", async () => !(await lamentState("bbbbbb")));
  check(true, "Delete asks first, then removes the lament on the host");

  // Fix works in a git worktree: it needs a commit to branch from.
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
  await click("lament-actions");
  await until("the sheet", () => exists('[data-testid="lament-sheet"]'));
  await click("action-fix");
  await until("the Fix chat on the host", async () => ((await lamentState("aaaaaa"))?.fixes ?? []).length > 0, 30_000);
  await until("the Fix chat", () => exists('[data-testid="send"]'));
  check(true, "Fix starts a chat on the host and opens it on the phone");
  await shot("25-lament-fix");
}
