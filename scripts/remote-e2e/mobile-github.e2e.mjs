#!/usr/bin/env node
// The phone's GitHub page: the no-remote problem, then a public repository's issues and PRs through the host's gh (read-only).
import { spawnSync } from "node:child_process";
import { sleep, log, check, until, project, openPhone, scenario } from "./harness.mjs";

await scenario("mobile github", async (ctx) => {
  const { A } = ctx;
  const { phone, shot, text, exists } = await openPhone(ctx);
  await githubChecks({ phone, A, shot, text, exists });
});

/** The phone's GitHub page (T31): the no-remote problem, then a public repository's issues and PRs through the host's gh (read-only). */
async function githubChecks({ phone, A, shot, text, exists }) {
  log("mobile github parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const openPage = async () => {
    for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
      await tapBack();
      await sleep(400);
    }
    await until("the projects screen", () => exists('[data-testid="open-settings"]'));
    await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    await until("the project sheet", () => exists('[data-testid="act-github"]'));
    await click("act-github");
    await until("the github page", () => exists('[data-testid="github-screen"]'));
  };
  await openPage();
  await until("the no-remote problem", () => exists('[data-testid="github-problem"]'));
  check(/GitHub remote|remote/i.test(await text()), "a project without a GitHub remote shows the problem as on the desktop");
  await shot("24-github-problem");
  spawnSync("git", ["remote", "add", "origin", "https://github.com/cli/cli.git"], { cwd: project });
  await click("github-refresh");
  await until("the page asks again", async () => !(await text()).includes("has no GitHub remote"));
  await until("issues or a problem", async () => (await exists('[data-testid="github-item"]')) || (await exists('[data-testid="github-empty"]')) || (await exists('[data-testid="github-problem"]')));
  await sleep(600);
  await shot("25-github-list");
  if (await exists('[data-testid="github-item"]')) {
    check((await text()).includes("Pull requests") && (await exists('[data-testid="github-account"]')), "tabs and the account chooser show");
    await click("github-row");
    await until("the body", () => exists('[data-testid="github-detail"]'));
    await click("github-actions");
    await until("the sheet", () => exists('[data-testid="github-sheet"]'));
    const sheetText = await text();
    check(["Open on GitHub", "Copy link", "New card from it", "Link to card"].every((l) => sheetText.includes(l)), "the actions sheet offers open, copy, card and link");
    await shot("26-github-sheet");
    const before = (await A.ok("board.get")).cards.length;
    await click("action-new-card");
    await until("a card made from the item", async () => (await A.ok("board.get")).cards.length === before + 1);
    check(true, "New card from it adds a linked card on the host");
  } else {
    check(true, "no issues readable here (no gh or no access): the problem or empty state shows");
  }
  spawnSync("git", ["remote", "remove", "origin"], { cwd: project });
}
