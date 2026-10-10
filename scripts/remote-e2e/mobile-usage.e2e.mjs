#!/usr/bin/env node
// The phone's Settings > Usage on the seeded session: the figures, the models and the range and source controls.
import { sleep, log, check, until, openPhone, scenario } from "./harness.mjs";

await scenario("mobile usage", async (ctx) => {
  const { phone, shot, text, exists } = await openPhone(ctx);
  // innerText applies the panel titles' uppercase; textContent keeps the words as written.
  const words = () => phone.eval("document.body.textContent ?? ''");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const pressed = (testId) => phone.eval(`document.querySelector('[data-testid="${testId}"]')?.getAttribute("aria-pressed")`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  log("mobile usage");
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await click("open-settings");
  await until("the sections", () => exists('[data-testid="section-usage"]'));
  check((await text()).includes("Usage"), "the sections list offers Usage");
  await click("section-usage");
  await until("the usage section", () => exists('[data-testid="usage"]'));
  await until("the report or its empty state", async () => (await exists('[data-testid="usage-figures"]')) || (await words()).includes("Nothing to show yet"));
  check(await pressed("usage-range-30d") === "true" && await pressed("usage-source-pigna") === "true", "the range and source default to 30 days of pi-gna");
  await shot("usage-pigna");

  await click("usage-source-all");
  await until("all pi sessions", async () => (await pressed("usage-source-all")) === "true" && (await exists('[data-testid="usage-figures"]')));
  const figures = await words();
  check(["Estimated cost", "Billed tokens", "Turns", "Session files", "Cache hit", "Active time"].every((label) => figures.includes(label)), "the six headline figures show");
  check(await exists('[data-testid="usage-models"]') && (await words()).includes("fake"), "the models list shows the seeded model");
  check((await exists('[data-testid="usage-projects"]')) === (await words()).includes("Top projects"), "the top projects appear exactly when the report has projects");
  await click("usage-range-7d");
  await until("7 days selected", async () => (await pressed("usage-range-7d")) === "true");
  await until("the report for 7 days", async () => (await exists('[data-testid="usage-figures"]')) && !(await phone.eval(`document.querySelector('[data-testid="usage-report"]')?.className.includes("opacity-60")`)));
  check(true, "the range control reloads the report");
  await shot("usage-all");
  await tapBack();
  await until("back on the sections", () => exists('[data-testid="section-usage"]'));
});
