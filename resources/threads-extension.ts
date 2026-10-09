// pi extension loaded into every pi-gna session (`pi -e`). Registers threads_list and thread_read: an agent sees the
// other chats (threads) of its project, or of every project, and reads what they asked and answered. Read-only.
// Calls go through pi-gna's token-gated localhost bridge, which knows the calling chat from its token.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { THREAD_LIMITS, type ThreadsRequest, type ThreadsResponse } from "../src/shared/threads";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

const ABOUT = "Threads are the user's chats in pi-gna (this one included), each with its own agent and session file. ";

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;

  async function call(body: ThreadsRequest, signal?: AbortSignal) {
    const response = await fetch(`${BRIDGE}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json()) as ThreadsResponse & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
    return { content: [{ type: "text" as const, text: data.text }], details: {} };
  }

  pi.registerTool({
    name: "threads_list",
    label: "Threads",
    description: `${ABOUT}List this project's threads, newest first, with their ids, titles and whether they are open or running now; all lists every project's, query filters by title.`,
    promptGuidelines: [
      "Use threads_list and thread_read when the user refers to another chat (\"what did the other thread find\", \"continue from the auth chat\"), or to check whether another thread already works on something before you duplicate it. Read only what you need: thread_read shows the newest turns first.",
    ],
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "List the threads of every project, not only this one" })),
      query: Type.Optional(Type.String({ description: "Only threads whose title contains this text" })),
      limit: Type.Optional(Type.Number({ description: `How many threads to show (default ${THREAD_LIMITS.list}, at most ${THREAD_LIMITS.listMax})` })),
    }),
    async execute(_id, params, signal) {
      return call({ action: "list", ...params }, signal);
    },
  });

  pi.registerTool({
    name: "thread_read",
    label: "Read a thread",
    description: `${ABOUT}Read a thread's newest turns: the user's prompts and the agent's replies in full, its tool calls one line each (results left out). Pass before to page back to earlier turns.`,
    parameters: Type.Object({
      thread: Type.String({ description: "Thread id from threads_list (or the end of a session id: at least 4 characters)" }),
      turns: Type.Optional(Type.Number({ description: `How many turns (default ${THREAD_LIMITS.turns}, at most ${THREAD_LIMITS.turnsMax})` })),
      before: Type.Optional(Type.Number({ description: "Show the turns before this turn number (paging back); default: the newest" })),
    }),
    async execute(_id, params, signal) {
      return call({ action: "read", ...params }, signal);
    },
  });
}
