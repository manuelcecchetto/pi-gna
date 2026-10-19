import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatFileIn, countSubagents, listSubagents, readSubagentTranscript, subagentFileIn } from "./subagents";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const header = (id: string, cwd = "/work") => line({ type: "session", version: 3, id, timestamp: "2026-10-19T08:00:00.000Z", cwd });
const message = (id: string, parentId: string | null, msg: Record<string, unknown>, timestamp = "2026-10-19T08:00:01.000Z") => line({ type: "message", id, parentId, timestamp, message: msg });

let root: string;
let chat: string;
let tasks: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pigna-subagents-"));
  await mkdir(join(root, "--work--"));
  chat = join(root, "--work--", "2026-10-19T08-00-00-000Z_p1.jsonl");
  tasks = join(root, "--work--", "2026-10-19T08-00-00-000Z_p1", "tasks");
  await mkdir(tasks, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const spawn = (id: string, callId: string, args: Record<string, unknown>) =>
  message(id, null, { role: "assistant", timestamp: 1000, provider: "p", model: "m", content: [{ type: "toolCall", id: callId, name: "subagent", arguments: args }] });
const spawned = (id: string, callId: string, agentId: string) =>
  message(id, null, { role: "toolResult", toolCallId: callId, toolName: "subagent", content: [{ type: "text", text: "started" }], details: { agentId, modelName: "claude-bridge/claude-sonnet-5-5", status: "background" } });

describe("listSubagents", () => {
  it("reads a chat's subagents from its files, and only the appended part of the chat on the next call", async () => {
    await writeFile(chat, header("p1") + spawn("e1", "c1", { description: "Fix server", subagent_type: "general-purpose", prompt: "fix the server" }) + spawned("e2", "c1", "a1"));
    await writeFile(
      join(tasks, "2026-10-19T08-00-02-000Z_k1.jsonl"),
      header("k1") +
        message("m1", null, { role: "system", content: "", sections: {} }) +
        message("m2", "m1", { role: "user", content: [{ type: "text", text: "fix the server" }], timestamp: 1 }) +
        message("m3", "m2", { role: "assistant", provider: "claude-bridge", model: "claude-sonnet-5-5", usage: { input: 100, output: 20, cacheWrite: 5, cacheRead: 9000 }, content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm test" } }], timestamp: 2 }) +
        message("m4", "m3", { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: 3 }),
    );
    expect(await countSubagents(chat)).toBe(1);
    expect(await listSubagents(chat)).toEqual([
      expect.objectContaining({ id: "a1", description: "Fix server", status: "unknown", toolUses: 1, tokens: 125, last: { name: "bash", args: { command: "pnpm test" } }, model: "claude-bridge/claude-sonnet-5-5", calls: ["c1"] }),
    ]);

    // A half-written line waits for its end; the record that follows settles the agent.
    const record = line({ type: "custom", id: "r1", parentId: null, timestamp: "2026-10-19T08:05:00.000Z", customType: "subagents:record", data: { id: "a1", status: "completed", completedAt: 5000 } });
    await appendFile(chat, record.slice(0, 20));
    expect((await listSubagents(chat))[0]?.status).toBe("unknown");
    await appendFile(chat, record.slice(20));
    expect((await listSubagents(chat))[0]).toMatchObject({ status: "completed", endedAt: 5000 });
  });

  it("is empty for a chat without subagents", async () => {
    const other = join(root, "--work--", "plain.jsonl");
    await writeFile(other, header("p2"));
    expect(await listSubagents(other)).toEqual([]);
    expect(await countSubagents(other)).toBe(0);
  });
});

describe("readSubagentTranscript", () => {
  it("hydrates the file as a chat, and answers only the size while it did not change", async () => {
    const file = join(tasks, "k2.jsonl");
    await writeFile(file, header("k2", "/work/app") + message("m1", null, { role: "system", content: "" }) + message("m2", "m1", { role: "user", content: "look around", timestamp: 1 }));
    const first = await readSubagentTranscript(file);
    expect(first.transcript?.cwd).toBe("/work/app");
    expect(first.transcript?.items.map((item) => (item as { kind: string }).kind)).toEqual(["user"]);
    expect(await readSubagentTranscript(file, first.size)).toEqual({ size: first.size });
  });
});

describe("paths", () => {
  it("accepts only chat and subagent files inside the sessions folder", () => {
    expect(chatFileIn("/s", "/s/--work--/a.jsonl")).toBe("/s/--work--/a.jsonl");
    expect(chatFileIn("/s", "/s/--work--/a/tasks/b.jsonl")).toBeUndefined();
    expect(chatFileIn("/s", "/etc/passwd.jsonl")).toBeUndefined();
    expect(chatFileIn("/s", "/s/../x/a.jsonl")).toBeUndefined();
    expect(subagentFileIn("/s", "/s/--work--/a/tasks/b.jsonl")).toBe("/s/--work--/a/tasks/b.jsonl");
    expect(subagentFileIn("/s", "/s/--work--/a/other/b.jsonl")).toBeUndefined();
    expect(subagentFileIn("/s", "/s/--work--/a/tasks/../../../../etc/b.jsonl")).toBeUndefined();
  });
});
