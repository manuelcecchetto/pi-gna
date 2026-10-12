// pi extension loaded into every pi-gna session (`pi -e`). Titles a new chat: at its first prompt, when it has no name
// yet, it asks the title model (Settings > Models > Chat titles, read from
// pi-gna's bridge) for a short title of the chat's first message and names the session with it. pi sends
// `session_info_changed`, so every client shows the title at once. Runs beside the turn and never fails it: without
// the model, its auth or an answer, the chat keeps its first message as its title.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanTitle, firstWords, TITLE_PROMPT, titleInput } from "../src/shared/chat-title";
import { pickModel, type TaskModel } from "../src/shared/settings";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;
const TIMEOUT_MS = 30_000;

type Entry = { type: string; message?: { role?: string; content?: unknown } };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : "";

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;
  // Once per process: a failed title is not retried, nor is a chat that had words before this process.
  let tried = false;

  async function wanted(): Promise<TaskModel> {
    const response = await fetch(`${BRIDGE}/title`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    const data = (await response.json()) as { model?: TaskModel; error?: string };
    if (!response.ok || !data.model) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
    return data.model;
  }

  async function title(text: string, ctx: ExtensionContext): Promise<void> {
    const want = await wanted();
    const model = pickModel(ctx.modelRegistry.getAvailable(), want, ctx.model?.provider);
    if (!model) throw new Error(`${want.provider ? `${want.provider}/` : ""}${want.id} is not available`);
    const answer = await ctx.modelRegistry
      .streamSimple(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: `${TITLE_PROMPT}\n\n<message>\n${text}\n</message>` }], timestamp: Date.now() }] },
        { ...(want.thinking !== "off" && { reasoning: want.thinking }), signal: AbortSignal.timeout(TIMEOUT_MS) },
      )
      .result();
    if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage ?? answer.stopReason);
    const name = cleanTitle(textOf(answer.content));
    // Named meanwhile (a task chat pi-gna names after its prompt, /name, the user): theirs wins.
    if (name && !pi.getSessionName()) pi.setSessionName(name);
  }

  pi.on("before_agent_start", (event, ctx) => {
    if (tried || pi.getSessionName()) return;
    // New chats only: a chat you reopen, or one past its first words, keeps the title it has. A chat that opened with a
    // photo alone has no words yet: its next message titles it.
    const users = (ctx.sessionManager.getBranch() as Entry[]).filter((entry) => entry.type === "message" && entry.message?.role === "user").map((entry) => textOf(entry.message?.content));
    if (!firstWords(users, event.prompt)) {
      if (titleInput(event.prompt) || users.some((text) => titleInput(text))) tried = true;
      return;
    }
    tried = true;
    void title(titleInput(event.prompt), ctx).catch((error: Error) => console.error(`pi-gna: no chat title: ${error.message}`));
  });
}
