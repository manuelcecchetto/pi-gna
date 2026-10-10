import { appendFile, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "../../shared/protocol";
import { listSessions } from "../session-index";
import { isPersonsClaudeSession, listClaude, readClaude, sampleClaude } from "./claude";
import { isPersonsCodexThread, listCodex, readCodex, withoutCodexMarkup } from "./codex";
import { type ImportedEntry, isInjectedText, mapToolCall, trimText, userMessage } from "./common";
import { ChatImporter } from "./index";
import { importedSessionId, pairToolResults, sessionFolder } from "./session";

vi.mock("../log", () => ({ log: { info: () => undefined, warn: () => undefined } }));

const jsonl = (records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const messages = (entries: ImportedEntry[]) => entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
const texts = (message: UserMessage | AssistantMessage | ToolResultMessage) =>
  (typeof message.content === "string" ? [message.content] : message.content.map((part) => ("text" in part ? part.text : part.type === "thinking" ? part.thinking : part.type)));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-gna-import-"));
});
afterEach(() => vi.unstubAllEnvs());

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-06-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function codexRollout(id: string, cwd: string, meta: Record<string, unknown> = {}, items: object[] = []): object[] {
  return [
    { timestamp: at(0), type: "session_meta", payload: { id, cwd, timestamp: at(0), source: "vscode", thread_source: "user", originator: "Codex Desktop", ...meta } },
    { timestamp: at(0), type: "turn_context", payload: { model: "gpt-5.5" } },
    ...items,
  ];
}

const item = (minutes: number, payload: object) => ({ timestamp: at(minutes), type: "response_item", payload });
const said = (minutes: number, role: string, ...text: string[]) => item(minutes, { type: "message", role, content: text.map((t) => ({ type: role === "assistant" ? "output_text" : "input_text", text: t })) });

async function writeCodex(home: string, name: string, records: object[], mtime?: number): Promise<string> {
  const dir = join(home, "sessions", "2026", "06", "01");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-06-01T10-00-00-${name}.jsonl`);
  await writeFile(file, jsonl(records));
  if (mtime) await utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

/** A Claude Code record; `promptId` on user records is what Claude Code itself writes. */
const claudeRecord = (uuid: string, parentUuid: string | null, type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) => ({
  uuid,
  parentUuid,
  type,
  isSidechain: false,
  cwd: "/work/app",
  entrypoint: "claude-desktop",
  timestamp: at(Number.parseInt(uuid.replace(/\D/g, "") || "0", 10)),
  ...(type === "user" ? { promptId: "p1" } : {}),
  message: type === "assistant" ? { id: extra.messageId ?? `m-${uuid}`, role: "assistant", model: "claude-opus-4-7", content } : { role: "user", content },
  ...extra,
});

async function writeClaude(projects: string, folder: string, id: string, records: object[], mtime?: number): Promise<string> {
  await mkdir(join(projects, folder), { recursive: true });
  const file = join(projects, folder, `${id}.jsonl`);
  await writeFile(file, jsonl(records));
  if (mtime) await utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

// ── Conversion rules ─────────────────────────────────────────────────────────

describe("what a person wrote", () => {
  it("drops the harness's blocks and keeps the person's text, an image becoming a note", () => {
    expect(isInjectedText("<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>")).toBe(true);
    expect(isInjectedText("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>…")).toBe(true);
    expect(isInjectedText('<image name="[Image #1]">')).toBe(true);
    expect(isInjectedText("</image>")).toBe(true);
    expect(isInjectedText("<b>bold</b> is not working in the editor")).toBe(false);
    expect(isInjectedText("Fix the <Button> props")).toBe(false);
    expect(userMessage([{ text: "<system-reminder>be brief</system-reminder>" }], 1)).toBeUndefined();
    expect(userMessage([{ text: "<image>" }, { image: true }, { text: "</image>" }, { text: "Why is this red?" }], 1)?.content).toEqual([
      { type: "text", text: "Why is this red?" },
      { type: "text", text: "(image not imported)" },
    ]);
  });

  it("keeps the start and end of a long output", () => {
    const long = `${"a".repeat(5000)}${"z".repeat(5000)}`;
    const trimmed = trimText(long, 4000);
    expect(trimmed.startsWith("aaa")).toBe(true);
    expect(trimmed.endsWith("zzz")).toBe(true);
    expect(trimmed).toContain("6000 characters not imported");
  });

  it("maps shell, file and patch tools to pi's, and keeps the rest as they were", () => {
    expect(mapToolCall("c1", "exec_command", { cmd: "pnpm test", workdir: "/repo" })).toMatchObject({ name: "bash", arguments: { command: "pnpm test" } });
    expect(mapToolCall("c2", "shell", { command: ["bash", "-lc", "ls -la"] })).toMatchObject({ name: "bash", arguments: { command: "ls -la" } });
    expect(mapToolCall("c3", "apply_patch", { input: "*** Begin Patch" })).toMatchObject({ name: "apply_patch", arguments: { input: "*** Begin Patch" } });
    expect(mapToolCall("c4", "Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })).toMatchObject({ name: "edit", arguments: { path: "/a.ts", edits: [{ oldText: "x", newText: "y" }] } });
    expect(mapToolCall("c5", "Read", { file_path: "/a.ts", offset: 10 })).toMatchObject({ name: "read", arguments: { path: "/a.ts", offset: 10 } });
    expect(mapToolCall("c6", "update_plan", { plan: [] })).toMatchObject({ name: "update_plan", arguments: { plan: [] } });
    // Codex's code mode: one shell command in a script is that command; anything more stays the script.
    expect(mapToolCall("c7", "exec", { input: 'const r = await tools.exec_command({cmd:"git status -sb","workdir":"/repo"});\ntext(r.output);' })).toMatchObject({ name: "bash", arguments: { command: "git status -sb" } });
    expect(mapToolCall("c8", "exec", { input: 'await tools.exec_command({"cmd":"rg \\"a b\\" src"})' })).toMatchObject({ name: "bash", arguments: { command: 'rg "a b" src' } });
    const two = 'await tools.exec_command({cmd:"ls"}); await tools.write_stdin({session_id:1})';
    expect(mapToolCall("c9", "exec", { input: two })).toMatchObject({ name: "exec", arguments: { input: two } });
  });

  it("answers every tool call right after its message, as providers require", () => {
    const call = (id: string) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} });
    const answer = (...ids: string[]): ImportedEntry => ({ kind: "message", message: { role: "assistant", content: ids.map(call), api: "x", provider: "codex", model: "m", usage: {} as never, stopReason: "toolUse", timestamp: 1 } });
    const result = (id: string): ImportedEntry => ({ kind: "message", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [], isError: false, timestamp: 2 } });
    const out = pairToolResults([answer("a", "b"), result("a"), answer("c"), result("b"), result("c")]);
    expect(messages(out).map((m) => (m.role === "toolResult" ? `${m.toolCallId}${m.isError ? "!" : ""}` : m.role))).toEqual(["assistant", "a", "b!", "assistant", "c"]);
  });
});

// ── Codex ────────────────────────────────────────────────────────────────────

describe("Codex", () => {
  it("lists the threads a person started, named as in Codex", async () => {
    expect(isPersonsCodexThread({ source: "cli" })).toBe(true);
    expect(isPersonsCodexThread({ source: "exec" })).toBe(false);
    expect(isPersonsCodexThread({ source: { subagent: { thread_spawn: {} } }, thread_source: "subagent" })).toBe(false);
    expect(isPersonsCodexThread({ source: "vscode", thread_source: "agent_created_thread" })).toBe(false);

    await writeCodex(root, "t1", codexRollout("t1", "/work/app"));
    await writeCodex(root, "t2", codexRollout("t2", "/work/app", { source: { subagent: { thread_spawn: { parent_thread_id: "t1" } } }, thread_source: "subagent" }));
    await writeCodex(root, "t3", codexRollout("t3", "/work/app", { source: "exec" }));
    await writeFile(join(root, "session_index.jsonl"), jsonl([{ id: "t1", thread_name: "Old name" }, { id: "t1", thread_name: "Fix login" }]));
    const listing = await listCodex(root);
    expect(listing).toMatchObject({ found: true, skipped: 2 });
    expect(listing.chats).toEqual([expect.objectContaining({ source: "codex", id: "t1", cwd: "/work/app", title: "Fix login", createdAt: T0 })]);
    expect(await listCodex(join(root, "nowhere"))).toMatchObject({ found: false, chats: [] });
  });

  it("drops Codex Desktop's chip markup from answers", () => {
    const answer = 'Pushed to main.\n\n::git-stage{cwd="/repo"} ::git-commit{cwd="/repo"}\n::git-push{cwd="/repo" branch="main"}\n<oai-mem-citation>\nMEMORY.md:1-3|note=[x]\n</oai-mem-citation>';
    expect(withoutCodexMarkup(answer)).toBe("Pushed to main.");
    expect(withoutCodexMarkup("Run `a::b{c}` and see ::not-a-directive")).toBe("Run `a::b{c}` and see ::not-a-directive");
  });

  it("reads turns, reasoning, tool calls with their outputs and compactions", async () => {
    const file = await writeCodex(
      root,
      "t1",
      codexRollout("t1", "/work/app", {}, [
        item(0, { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>…</permissions instructions>" }] }),
        said(0, "user", "# AGENTS.md instructions for /work/app\n\n…", "<environment_context>\n<cwd>/work/app</cwd>\n</environment_context>"),
        said(1, "user", "The login button does nothing"),
        item(1, { type: "reasoning", summary: [{ type: "summary_text", text: "**Looking at the handler**" }], encrypted_content: "gAAAA" }),
        said(1, "assistant", "Checking the click handler."),
        item(1, { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "rg onClick", workdir: "/work/app" }), call_id: "call_1" }),
        item(2, { type: "function_call_output", call_id: "call_1", output: "src/Login.tsx:12: onClick={undefined}" }),
        item(2, { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** End Patch", call_id: "call_2" }),
        item(2, { type: "custom_tool_call_output", call_id: "call_2", output: [{ type: "input_text", text: "Success." }] }),
        item(3, { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pnpm test"] }), call_id: "call_3" }),
        item(3, { type: "function_call_output", call_id: "call_3", output: JSON.stringify({ output: "1 failed", metadata: { exit_code: 1 } }) }),
        { timestamp: at(4), type: "compacted", payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "The login button does nothing" }] }, { type: "compaction", encrypted_content: "x" }] } },
        said(5, "user", "Thanks, ship it"),
        said(5, "assistant", "Shipped."),
        { timestamp: at(5), type: "event_msg", payload: { type: "token_count" } },
      ]),
    );
    const entries = await readCodex({ source: "codex", id: "t1", file, cwd: "/work/app", createdAt: T0, mtimeMs: T0, size: 1 });
    const flat = entries.map((entry) => (entry.kind === "compaction" ? `compaction: ${entry.summary.split("\n")[0]}` : `${entry.message.role}: ${texts(entry.message).join(" | ")}`));
    expect(flat).toEqual([
      "user: The login button does nothing",
      "assistant: **Looking at the handler** | Checking the click handler. | toolCall",
      "toolResult: src/Login.tsx:12: onClick={undefined}",
      "assistant: toolCall",
      "toolResult: Success.",
      "assistant: toolCall",
      "toolResult: 1 failed",
      expect.stringMatching(/^compaction: Codex compacted the conversation here/),
      "user: Thanks, ship it",
      "assistant: Shipped.",
    ]);
    const [first, , , patch, , shell, failed, compaction] = entries;
    expect(first?.kind === "message" && first.message.timestamp).toBe(Date.parse(at(1)));
    expect(messages(entries)[1]).toMatchObject({ provider: "codex", api: "openai-responses", model: "gpt-5.5", stopReason: "toolUse", content: [{ type: "thinking" }, { type: "text" }, { type: "toolCall", name: "bash", arguments: { command: "rg onClick" } }] });
    expect(patch).toMatchObject({ message: { content: [{ name: "apply_patch", arguments: { input: "*** Begin Patch\n*** End Patch" } }] } });
    expect(shell).toMatchObject({ message: { content: [{ name: "bash", arguments: { command: "pnpm test" } }] } });
    expect(failed).toMatchObject({ message: { role: "toolResult", toolName: "bash", isError: true } });
    expect(compaction?.kind === "compaction" && compaction.summary).toContain("- The login button does nothing");
  });
});

// ── Claude Code ──────────────────────────────────────────────────────────────

describe("Claude Code", () => {
  const person = [
    { type: "queue-operation", sessionId: "s" },
    claudeRecord("u1", null, "user", "Make the header sticky"),
    claudeRecord("a2", "u1", "assistant", [{ type: "thinking", thinking: "", signature: "sig" }], { messageId: "m1" }),
    claudeRecord("a3", "a2", "assistant", [{ type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/work/app/a.css", old_string: "top: 0", new_string: "position: sticky; top: 0" } }], { messageId: "m1" }),
    claudeRecord("u4", "a3", "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "Updated" }]),
    claudeRecord("a5", "u4", "assistant", [{ type: "text", text: "Done: the header sticks." }]),
    { type: "custom-title", customTitle: "Sticky header" },
  ];

  it("lists a person's sessions, never claude-bridge's or scripts'", async () => {
    const projects = join(root, "projects");
    const bridgeTool = (uuid: string, parent: string | null) => claudeRecord(uuid, parent, "assistant", [{ type: "tool_use", id: `t${uuid}`, name: "mcp__custom-tools__bash", input: {} }]);
    await writeClaude(projects, "-work-app", "person", person);
    await writeClaude(projects, "-work-app", "bridge-live", [claudeRecord("u1", null, "user", "hi", { entrypoint: "cli" }), bridgeTool("a2", "u1")]);
    // cc-session-io (the bridge's transcript rebuild) writes entrypoint "cli" and no promptId.
    await writeClaude(projects, "-work-app", "bridge-rebuilt", [{ ...claudeRecord("u1", null, "user", "hello", { entrypoint: "cli" }), promptId: undefined }, claudeRecord("a2", "u1", "assistant", [{ type: "text", text: "Hi" }], { entrypoint: "cli" })]);
    await writeClaude(projects, "-work-app", "sdk", [claudeRecord("u1", null, "user", "Judge this design", { entrypoint: "sdk-ts" })]);
    await writeClaude(projects, "-work-app", "empty", [{ type: "mode" }, { type: "system", entrypoint: "cli" }]);
    await writeClaude(projects, "-Users-me--pi-gna-worktrees-ab12cd-work-app", "card", person);
    const listing = await listClaude(projects);
    expect(listing.chats).toEqual([expect.objectContaining({ source: "claude", id: "person", cwd: "/work/app", title: "Sticky header", createdAt: Date.parse(at(1)) })]);
    expect(listing.skipped).toBe(5);
    expect(isPersonsClaudeSession(sampleClaude([JSON.stringify(claudeRecord("u1", null, "user", "x", { cwd: "/Users/me/.pi-gna/worktrees/ab12cd/work/app" }))]))).toBe(false);
  });

  it("reads the active branch, one answer per message id, with tools mapped to pi's", async () => {
    const rewound = [
      ...person.slice(0, 2),
      claudeRecord("a9", "u1", "assistant", [{ type: "text", text: "An answer you rewound" }]),
      ...person.slice(2),
      { type: "system", subtype: "compact_boundary", uuid: "s6", parentUuid: null, logicalParentUuid: "a5", timestamp: at(6) },
      claudeRecord("u7", "s6", "user", "This session is being continued from a previous conversation. Summary: sticky header done.", { isCompactSummary: true }),
      claudeRecord("u8", "u7", "user", "<command-name>/model</command-name>", { isMeta: true }),
      claudeRecord("u9", "u8", "user", [{ type: "text", text: "Now the footer" }, { type: "image", source: { type: "base64", data: "AAAA" } }]),
      claudeRecord("a10", "u9", "assistant", [{ type: "text", text: "API Error" }], { message: { id: "x", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } }),
    ];
    const file = await writeClaude(join(root, "projects"), "-work-app", "person", rewound);
    const entries = await readClaude({ source: "claude", id: "person", file, cwd: "/work/app", createdAt: T0, mtimeMs: T0, size: 1 });
    expect(entries.map((entry) => (entry.kind === "compaction" ? `compaction: ${entry.summary}` : `${entry.message.role}: ${texts(entry.message).join(" | ")}`))).toEqual([
      "user: Make the header sticky",
      "assistant: toolCall",
      "toolResult: Updated",
      "assistant: Done: the header sticks.",
      "compaction: This session is being continued from a previous conversation. Summary: sticky header done.",
      "user: Now the footer | (image not imported)",
    ]);
    expect(messages(entries)[1]).toMatchObject({ provider: "claude-code", model: "claude-opus-4-7", content: [{ type: "toolCall", id: "toolu_1", name: "edit", arguments: { path: "/work/app/a.css" } }] });
    expect(messages(entries)[2]).toMatchObject({ toolCallId: "toolu_1", toolName: "edit" });
  });
});

// ── Importing ────────────────────────────────────────────────────────────────

describe("ChatImporter", () => {
  async function setup() {
    const codexHome = join(root, "codex");
    const projects = join(root, "claude");
    const sessions = join(root, "sessions");
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", sessions);
    const importer = new ChatImporter({ sessionsDir: () => sessions, codexHome: () => codexHome, claudeProjects: () => projects, home: join(root, "home") });
    return { codexHome, projects, sessions, importer };
  }
  const OLD = Date.parse("2026-06-02T09:00:00.000Z");
  const conversation = (n = 1) => Array.from({ length: n }, (_, i) => [said(i * 2 + 1, "user", `Question ${i + 1}`), said(i * 2 + 2, "assistant", `Answer ${i + 1}`)]).flat();

  it("writes each chat where pi keeps that folder's chats, dated as in the source, and again only when it changed", async () => {
    const { codexHome, sessions, importer } = await setup();
    const source = await writeCodex(codexHome, "t1", codexRollout("t1", "/work/app", {}, conversation()), OLD);
    await writeCodex(codexHome, "t2", codexRollout("t2", join(root, "home", "Documents", "Codex", "2026-06-02", "scratch"), {}, conversation()), OLD);
    await writeFile(join(codexHome, "session_index.jsonl"), jsonl([{ id: "t1", thread_name: "Fix login" }]));

    const scan = await importer.scan();
    expect(scan.sources[0]).toMatchObject({ source: "codex", chats: 2, skipped: 0 });
    expect(scan.projects.map((p) => [p.cwd.replace(root, "~"), p.scratch, p.fresh])).toEqual(
      expect.arrayContaining([
        ["/work/app", false, 1],
        ["~/home/Documents/Codex/2026-06-02/scratch", true, 1],
      ]),
    );

    const progress: number[] = [];
    expect(await importer.run(["/work/app"], (p) => progress.push(p.done))).toMatchObject({ imported: 1, updated: 0, unchanged: 0, failed: [] });
    expect(progress).toEqual([0, 1]);
    const folder = sessionFolder(sessions, "/work/app");
    expect(folder).toBe(join(sessions, "--work-app--"));
    const path = join(folder, `2026-06-01T10-00-00-000Z_${importedSessionId({ source: "codex", id: "t1" })}.jsonl`);
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ type: "session", version: 3, id: importedSessionId({ source: "codex", id: "t1" }), timestamp: at(0), cwd: "/work/app" });
    expect(records.slice(1).map((r) => r.type)).toEqual(["custom", "session_info", "message", "message"]);
    expect(records[1]).toMatchObject({ customType: "pigna.import", data: { source: "codex", id: "t1", file: source } });
    expect(records[2]).toMatchObject({ name: "Fix login", parentId: records[1].id });
    expect((await stat(path)).mtimeMs).toBe(OLD);

    expect(await importer.run(["/work/app"], () => undefined)).toMatchObject({ imported: 0, updated: 0, unchanged: 1 });
    await appendFile(source, jsonl(conversation(2).slice(2)));
    const LATER = OLD + 3_600_000;
    await utimes(source, LATER / 1000, LATER / 1000);
    expect((await importer.scan()).projects.find((p) => p.cwd === "/work/app")).toMatchObject({ fresh: 0, changed: 1, current: 0 });
    expect(await importer.run(["/work/app"], () => undefined)).toMatchObject({ updated: 1 });
    expect((await readFile(path, "utf8")).match(/Question 2/g)).toHaveLength(1);
    expect((await stat(path)).mtimeMs).toBe(LATER);
  });

  it("remembers a chat that held nothing to import, so it never lists as new again", async () => {
    const { codexHome, sessions } = await setup();
    const emptyFile = join(root, "userData", "chat-import.json");
    const make = () => new ChatImporter({ sessionsDir: () => sessions, codexHome: () => codexHome, claudeProjects: () => join(root, "none"), emptyFile });
    await writeCodex(codexHome, "t1", codexRollout("t1", "/work/app", {}, [said(1, "user", "<environment_context>…</environment_context>")]), OLD);
    expect((await make().scan()).projects[0]).toMatchObject({ fresh: 1 });
    expect(await make().run(["/work/app"], () => undefined)).toMatchObject({ imported: 0, unchanged: 1 });
    expect((await make().scan()).projects[0]).toMatchObject({ fresh: 0, current: 1 });
  });

  it("leaves a chat you continued in pi as it is", async () => {
    const { codexHome, sessions, importer } = await setup();
    const source = await writeCodex(codexHome, "t1", codexRollout("t1", "/work/app", {}, conversation()), OLD);
    await importer.run(["/work/app"], () => undefined);
    const path = join(sessionFolder(sessions, "/work/app"), `2026-06-01T10-00-00-000Z_${importedSessionId({ source: "codex", id: "t1" })}.jsonl`);
    await appendFile(path, jsonl([{ type: "message", id: "p1", parentId: "00000004", timestamp: new Date().toISOString(), message: { role: "user", content: "Continued in pi", timestamp: Date.now() } }]));
    await appendFile(source, jsonl(conversation(2).slice(2)));
    expect(await importer.run(["/work/app"], () => undefined)).toMatchObject({ imported: 0, updated: 0, kept: 1 });
    expect(await readFile(path, "utf8")).toContain("Continued in pi");
  });

  it("keeps today's pi chats above imported ones, in their project and in the project list", async () => {
    const { codexHome, projects, sessions, importer } = await setup();
    await writeCodex(codexHome, "t1", codexRollout("t1", "/work/app", {}, conversation()), OLD);
    await writeCodex(codexHome, "t2", codexRollout("t2", "/work/old-project", {}, conversation()), OLD);
    await writeClaude(projects, "-work-app", "c1", [claudeRecord("u1", null, "user", "Sticky header?"), claudeRecord("a2", "u1", "assistant", [{ type: "text", text: "Yes." }])], OLD - 1000);
    const today = join(sessionFolder(sessions, "/work/app"), "today.jsonl");
    await mkdir(sessionFolder(sessions, "/work/app"), { recursive: true });
    await writeFile(
      today,
      jsonl([
        { type: "session", version: 3, id: "today", timestamp: new Date().toISOString(), cwd: "/work/app" },
        { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Today's chat", timestamp: Date.now() } },
      ]),
    );
    await importer.run(["/work/app", "/work/old-project"], () => undefined);
    const listed = await listSessions();
    expect(listed.map((group) => group.cwd)).toEqual(["/work/app", "/work/old-project"]);
    expect(listed[0]?.sessions.map((s) => s.title)).toEqual(["Today's chat", "Question 1", "Sticky header?"]);
  });
});
