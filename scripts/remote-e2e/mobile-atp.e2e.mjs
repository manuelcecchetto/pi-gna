#!/usr/bin/env node
// The phone's ATP page: plans, nodes, graph gestures, start / stop / resume on the host, the orchestrator and a new plan.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sleep, log, check, until, project, openPhone, scenario } from "./harness.mjs";

await scenario("mobile atp", async (ctx) => {
  const { A } = ctx;
  const { phone, shot, text, exists, present } = await openPhone(ctx);
  await atpChecks({ phone, A, shot, text, exists, present });
});

/** The phone's ATP page (T32): plans, nodes, graph gestures, start / stop / resume on the host, the orchestrator and a new plan. */
async function atpChecks({ phone, A, shot, text, exists, present }) {
  log("mobile ATP");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const count = (testId) => phone.eval(`document.querySelectorAll('[data-testid="${testId}"]').length`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  const node = (id, status, extra = {}) => ({ title: `Node ${id}`, instruction: `Instruction **${id}**`, dependencies: [], status, ...extra });
  const planFile = join(project, "docs", "plans", "draft", "mini.atp.json");
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, JSON.stringify({ meta: { project_name: "Mini plan", version: "1.3", project_status: "DRAFT" }, nodes: { A: node("A", "READY"), B: node("B", "LOCKED", { dependencies: ["A"] }), C: node("C", "LOCKED", { dependencies: ["B"] }) } }, null, 2));
  const planNodes = async () => Object.fromEntries((await A.ok("atp.read", { plan: planFile })).nodes.map((n) => [n.id, n.status]));
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await phone.eval(`document.querySelector('[data-testid="project-row"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("the project sheet", () => exists('[data-testid="act-atp"]'));
  await click("act-atp");
  await until("the plan", () => exists('[data-testid="plan-bar"]'));
  const body = await text();
  check(body.includes("Mini plan") && body.includes("DRAFT") && /0\/3/.test(body), "the plan bar shows the plan, its status and 0/3");
  check(await exists('[data-testid="start"]'), "a draft plan offers Start");
  check((await exists('[data-testid="group-ready"]')) && (await exists('[data-testid="group-locked"]')) && !(await exists('[data-testid="group-done"]')), "the node list is grouped by status");
  await shot("31-atp-nodes");

  await phone.eval(`document.querySelector('[data-testid="node-row"][data-node="B"]').click()`);
  await until("the node sheet", () => exists('[data-testid="node-sheet"]'));
  check((await phone.eval(`!!document.querySelector('[data-testid="node-instruction"] strong')`)) && (await text()).includes("Depends on"), "a node opens to its instruction (as Markdown) and its dependencies");
  await shot("32-atp-node");
  await phone.eval(`document.querySelector('[data-testid="node-sheet"] [aria-label="Close"]').click()`);

  // The graph: nodes as cards, a two-finger pinch zooms and a one-finger drag pans (pointer events).
  await click("tab-graph");
  await until("the graph", async () => (await phone.eval(`document.querySelectorAll("[data-node]").length`)) >= 3);
  await sleep(300);
  const layerOf = () => phone.eval(`(() => { const l = document.querySelector(".atp-layer"); const m = new DOMMatrix(getComputedStyle(l).transform); return { k: m.a, x: m.e, y: m.f }; })()`);
  const before = await layerOf();
  const fire = (type, id, x, y) => phone.eval(`(() => { const t = type => ${JSON.stringify(type)}; const v = document.querySelector(".atp-layer").parentElement; const e = new PointerEvent(${JSON.stringify(type)}, { pointerId: ${id}, button: 0, clientX: ${x}, clientY: ${y}, bubbles: true, pointerType: "touch" }); (${JSON.stringify(type)} === "pointerdown" ? v : window).dispatchEvent(e); })()`);
  await fire("pointerdown", 1, 150, 300);
  await fire("pointerdown", 2, 250, 300);
  await fire("pointermove", 2, 350, 300);
  await fire("pointerup", 2, 350, 300);
  await fire("pointerup", 1, 150, 300);
  const pinched = await layerOf();
  check(pinched.k > before.k * 1.5, "a two-finger pinch zooms the graph in", { before, pinched });
  await fire("pointerdown", 3, 200, 300);
  await fire("pointermove", 3, 260, 340);
  await fire("pointerup", 3, 260, 340);
  const panned = await layerOf();
  check(Math.abs(panned.x - pinched.x - 60) < 2 && Math.abs(panned.y - pinched.y - 40) < 2 && Math.abs(panned.k - pinched.k) < 1e-6, "a one-finger drag pans without zooming", { pinched, panned });
  await shot("33-atp-graph");
  await click("tab-nodes");

  // Run it from the phone: start, watch, stop, resume.
  await click("start");
  await until("the host to run the plan", async () => Object.keys((await A.ok("atp.state")).runners ?? {}).includes(planFile), 20_000);
  await until("the run on the phone", () => exists('[data-testid="runner"]'));
  check(!(await exists('[data-testid="start"]')) && (await exists('[data-testid="stop"]')), "while it runs the plan bar offers Stop, not Start");
  await until("the first node to finish", async () => (await planNodes()).A === "COMPLETED", 30_000);
  await until("it on the phone", () => exists('[data-testid="group-done"]'));
  check(true, "the phone's node list moves finished nodes to Done as the run goes");
  await shot("34-atp-running");
  await click("stop");
  await until("the run to stop", async () => !Object.keys((await A.ok("atp.state")).runners ?? {}).includes(planFile), 20_000);
  await until("Run on the phone", () => exists('[data-testid="start"]'));
  check(/Run|Resume/.test(await phone.eval(`document.querySelector('[data-testid="start"]').innerText`)), "after Stop the phone offers to run the plan again");
  await shot("35-atp-stopped");
  await click("start");
  await until("the plan to finish", async () => Object.values(await planNodes()).every((status) => status === "COMPLETED"), 60_000);
  await until("3/3 on the phone", present("3/3"), 20_000);
  await until("the run to end on the phone", async () => !(await exists('[data-testid="stop"]')), 20_000);
  check(!(await exists('[data-testid="start"]')), "a finished plan offers neither Start nor Stop");
  await shot("36-atp-finished");

  // The orchestrator is a full chat screen; leaving it gives the host its chat back.
  await click("orchestrator");
  await until("the orchestrator chat", () => exists('[data-testid="send"]'));
  check(Object.keys((await A.ok("atp.state")).orchestrators ?? {}).includes(planFile), "the orchestrator chat runs on the host for the plan");
  await tapBack();
  await until("the plan again", () => exists('[data-testid="plan-bar"]'));
  await until("the host to let the idle orchestrator go", async () => !Object.keys((await A.ok("atp.state")).orchestrators ?? {}).includes(planFile), 15_000);
  check(true, "leaving the orchestrator chat releases it on the host");

  // A new plan: the architect's chat opens with its skill typed in the composer.
  await click("new-plan");
  await until("the architects", () => exists('[data-testid="architect-atp-architect"]'));
  await shot("37-atp-new-plan");
  await click("architect-atp-architect");
  await until("the architect chat", () => exists('[data-testid="send"]'));
  check((await phone.eval(`document.querySelector("textarea").value`)).startsWith("/skill:atp-architect"), "a new plan opens the architect with its skill in the composer");
  await tapBack();
  await until("the plan once more", () => exists('[data-testid="plan-bar"]'));
}
