#!/usr/bin/env node
// Mermaid fences on the phone: an answer with a state diagram and a flowchart draws both with Pele (lazy chunks from the
// remote server, the phone's CSP), fitted to the phone's width, in dark and light; a broken one stays code with its reason.
import { check, until, agentEnds, settled, openPhone, openChatOnPhone, scenario, sleep } from "./harness.mjs";

const answer = [
  "A chat's run:",
  "",
  "```mermaid",
  "stateDiagram-v2",
  "  [*] --> Idle",
  "  Idle --> Streaming: prompt sent",
  "  Streaming --> Tools: tool call",
  "  Tools --> Streaming: results back",
  "  Streaming --> Retrying: provider error",
  "  Retrying --> Streaming: retry",
  "  Streaming --> Idle: agent_end",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  U[User types] --> C{Run going?}",
  "  C -- No --> S[Send prompt]",
  "  C -- Yes --> Q[Queue as steer]",
  "  S --> P[pi RPC]",
  "  Q --> P",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  A -->",
  "```",
  "",
  "Done.",
].join("\n");

await scenario("mobile diagrams", async (ctx) => {
  const { A, desktop } = ctx;
  const handle = await ctx.openChat();
  const stream = A.events([handle]);
  await until("the fixture stream", () => stream.frames.some((frame) => frame.event === "hello"));
  await A.ok("chat.send", { handle, text: `diagrams say: ${answer}`, mode: "send" });
  await until("the answer", () => agentEnds(stream.events, `chat:${handle}`) === 1, 30_000);
  stream.drop();
  await settled(desktop, handle);

  const phone = await openPhone(ctx);
  await phone.phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await openChatOnPhone(phone);
  await until("the answer on the phone", phone.present("Done."), 20_000, 250);
  const drawn = () => phone.phone.eval(`document.querySelectorAll(".diagram-view svg.pele").length`);
  await until("two drawn diagrams", async () => (await drawn()) === 2, 20_000, 250);
  check(true, "the phone draws both diagrams");
  const facts = await phone.phone.eval(`(() => {
    const width = document.querySelector(".prose").clientWidth;
    const svgs = [...document.querySelectorAll(".diagram-view svg.pele")].map((svg) => svg.getBoundingClientRect().width);
    const note = document.querySelector(".diagram-note")?.textContent ?? "";
    const hidden = [...document.querySelectorAll(".diagram")].map((d) => d.querySelector(".code-block").hidden);
    return { width, svgs, note, hidden };
  })()`);
  check(facts.svgs.every((w) => w > 0 && w <= facts.width + 1), "each diagram fits the phone's column", facts);
  check(facts.note.startsWith("Diagram could not be drawn: Parse error"), "the broken fence says why", facts.note);
  check(JSON.stringify(facts.hidden) === "[true,true,false]", "drawn diagrams hide their code, the broken one keeps it", facts.hidden);
  await phone.phone.eval(`document.querySelector(".diagram").scrollIntoView({ block: "start" })`);
  await sleep(600);
  await phone.shot("diagrams-dark");
  await phone.phone.eval(`document.querySelectorAll(".diagram")[1].scrollIntoView({ block: "start" })`);
  await sleep(600);
  await phone.shot("diagrams-dark-2");
  await phone.phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await phone.phone.eval(`document.querySelector(".diagram").scrollIntoView({ block: "start" })`);
  await sleep(600);
  check((await drawn()) === 2, "a mode change keeps the drawn diagrams");
  await phone.shot("diagrams-light");
  await phone.close();
});
