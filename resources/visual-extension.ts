// pi extension loaded into pi-gna chats while Inline visuals is on (`pi -e`, SessionFeatures.visuals). Adds the visual
// instructions to the prompt's project context, beside the AGENTS.md files pi found, so agents weigh them like project
// instructions. Nothing is written to disk: a plain `pi` in a terminal, where visuals do not render, never sees them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const path = join(here, "pigna-visual-prompt.md");

export default function (pi: ExtensionAPI) {
  const content = readFileSync(path, "utf8");
  pi.on("before_agent_start", (event) => {
    const files = event.systemPromptOptions.contextFiles;
    if (!files.some((file) => file.path === path)) files.push({ path, content });
  });
}
