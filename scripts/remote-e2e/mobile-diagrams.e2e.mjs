#!/usr/bin/env node
// Mermaid fences on the phone: an answer with a state diagram and a flowchart draws both with Pele (lazy chunks from the
// remote server, the phone's CSP), fitted to the phone's width, in dark and light; a broken one stays code with its reason.
// A wide state machine with sentence labels (a real reply's) is never shrunk past readable: it scrolls sideways instead.
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
  "stateDiagram-v2",
  "  direction LR",
  "  [*] --> Scratch: agent drafts SKILL.md or template in chat scratch",
  "  Scratch --> Offered: offer_files (template carries its .questions.json)",
  "  Offered --> Saving: lawyer clicks Save to team library",
  "  [*] --> Saving: Library upload (design, templates, editing a skill)",
  "  state Saving {",
  "    [*] --> Checks",
  "    Checks --> Exists: 409 TEAM_LIBRARY_EXISTS",
  "    Exists --> Checks: lawyer confirms replace",
  "  }",
  "  Saving --> Refused: kind mismatch, invalid skill frontmatter, path, size, rights, workspace closed, new skill via upload",
  "  Saving --> Stored: one transaction writes record and new Storage version",
  "  state Stored {",
  "    [*] --> Plain: design file or skill",
  "    [*] --> QPending: Word template uploaded",
  "    [*] --> QReady: template saved from chat with questions",
  "    QPending --> QReady: worker questionnaire job, SHA still matches",
  "    QPending --> QFailed: last attempt fails or queue down",
  "    QFailed --> QPending: Prepare again",
  "    QReady --> QPending: template replaced, new SHA",
  "  }",
  "  Stored --> Mounted: library_sync each Dossier turn, mount_library in standalone chat",
  "  Mounted --> Stored: replaced or access lost, copy pruned at next sync",
  "  Stored --> Removed: DELETE by who added it or a workspace admin",
  "  Removed --> [*]: pruned from every mount",
  "  Stored --> Quarantined: workspace closure takes effect",
  "  Quarantined --> [*]: purged",
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
  await until("two drawn diagrams", async () => (await drawn()) === 3, 20_000, 250);
  check(true, "the phone draws all three diagrams");
  const facts = await phone.phone.eval(`(() => {
    const width = document.querySelector(".prose").clientWidth;
    const views = [...document.querySelectorAll(".diagram-view")];
    const svgs = views.map((view) => view.querySelector("svg").getBoundingClientRect().width);
    const scrolls = views.map((view) => view.classList.contains("scroll") && view.scrollWidth > view.clientWidth);
    const labels = views.map((view) => Math.min(...[...view.querySelectorAll("text")].map((t) => t.getBoundingClientRect().height).filter(Boolean)));
    const note = document.querySelector(".diagram-note")?.textContent ?? "";
    const hidden = [...document.querySelectorAll(".diagram")].map((d) => d.querySelector(".code-block").hidden);
    return { width, svgs, scrolls, labels, note, hidden };
  })()`);
  check(facts.svgs.slice(0, 2).every((w) => w > 0 && w <= facts.width + 1), "the short diagrams fit the phone's column", facts);
  check(JSON.stringify(facts.scrolls) === "[false,false,true]", "the wide one scrolls sideways instead of shrinking", facts.scrolls);
  check(facts.labels.every((h) => h >= 9), "every diagram's labels stay readable", facts.labels);
  check(facts.note.startsWith("Diagram could not be drawn: Parse error"), "the broken fence says why", facts.note);
  check(JSON.stringify(facts.hidden) === "[true,true,true,false]", "drawn diagrams hide their code, the broken one keeps it", facts.hidden);
  await phone.phone.eval(`document.querySelector(".diagram").scrollIntoView({ block: "start" })`);
  await sleep(600);
  await phone.shot("diagrams-dark");
  await phone.phone.eval(`document.querySelectorAll(".diagram")[1].scrollIntoView({ block: "start" })`);
  await sleep(600);
  await phone.shot("diagrams-dark-2");
  await phone.phone.eval(`document.querySelectorAll(".diagram")[2].scrollIntoView({ block: "start" })`);
  await sleep(600);
  await phone.shot("diagrams-wide");
  await phone.phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await phone.phone.eval(`document.querySelector(".diagram").scrollIntoView({ block: "start" })`);
  await sleep(600);
  check((await drawn()) === 3, "a mode change keeps the drawn diagrams");
  await phone.shot("diagrams-light");
  await phone.close();
});
