// pi extension: the model a subagent runs on when nobody chose one, for @gotgenes/pi-subagents (a recommended
// package). Its `subagent` tool resolves a child's model as: call param > agent file `model:` > the parent's model, so a
// subagent of an Opus chat would run on Opus too. This fills the call param only when neither the call nor an agent file
// names a model: a Claude parent spawns Sonnet children, an OpenAI one Luna children. Resumes keep the model the agent
// already ran on. Other providers, and chats without pi-subagents (no `subagent` tool calls), are left alone.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const DEFAULT_CHILD_MODEL: Record<string, string> = {
  anthropic: "anthropic/claude-sonnet-5-5",
  "claude-bridge": "claude-bridge/claude-sonnet-5-5",
  "openai-codex": "openai-codex/gpt-6-luna",
};

/** The `model:` of the user agent file for this type; the project file shadows the global one, as in gotgenes. */
function agentFileModel(type: string, cwd: string): string | undefined {
  const fileName = `${type.toLowerCase()}.md`;
  for (const dir of [join(cwd, ".pi", "agents"), join(getAgentDir(), "agents")]) {
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => f.toLowerCase() === fileName);
    if (!file) continue;
    const { model } = parseFrontmatter(readFileSync(join(dir, file), "utf8")).frontmatter;
    return typeof model === "string" && model.trim() ? model : undefined;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as { model?: unknown; resume?: unknown; subagent_type?: unknown };
    if (input.model || input.resume) return;
    const fallback = ctx.model ? DEFAULT_CHILD_MODEL[ctx.model.provider] : undefined;
    if (!fallback) return;
    if (typeof input.subagent_type === "string" && agentFileModel(input.subagent_type, ctx.cwd)) return;
    input.model = fallback;
  });
}
