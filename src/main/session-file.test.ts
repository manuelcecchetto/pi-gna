import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeBranch, parseRecords, summarizeSessionFile, textOf } from "./session-file";

const header = { type: "session", version: 3, id: "sid", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/repo" };
const msg = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-01T10:00:00.000Z",
  message: { role, content, timestamp: 0 },
});

function jsonl(records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("activeBranch", () => {
  it("walks from the last entry to the root and drops abandoned branches", () => {
    const records = parseRecords(
      jsonl([
        header,
        msg("sys", null, "system", ""),
        msg("u1", "sys", "user", "first"),
        msg("a1", "u1", "assistant", []),
        msg("u2", "a1", "user", "abandoned"),
        msg("u3", "a1", "user", "kept"),
        { type: "label", id: "l1", parentId: "u3", timestamp: "", targetId: "u1", label: "x" },
      ]),
    );
    expect(activeBranch(records).map((entry) => entry.id)).toEqual(["u1", "a1", "u3"]);
  });

  it("tolerates cycles, broken parents and a torn final line", () => {
    const text = jsonl([header, msg("a", "b", "user", "a"), msg("b", "a", "user", "b")]) + '{"type":"mess';
    expect(activeBranch(parseRecords(text)).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(activeBranch(parseRecords(jsonl([header])))).toEqual([]);
  });
});

describe("summarizeSessionFile", () => {
  it("finds the first user message past a large system message and the latest name in the tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-gna-"));
    const path = join(dir, "s.jsonl");
    const bigSystem = msg("sys", null, "system", "x".repeat(200_000));
    const filler = Array.from({ length: 50 }, (_, i) => msg(`f${i}`, "u1", "assistant", "y".repeat(5_000)));
    const text = jsonl([
      header,
      bigSystem,
      msg("u1", "sys", "user", [{ type: "text", text: "  Fix the\n login bug  " }]),
      { type: "session_info", id: "n1", parentId: "u1", timestamp: "", name: "early" },
      ...filler,
      { type: "session_info", id: "n2", parentId: "f49", timestamp: "", name: "Login fix" },
    ]);
    await writeFile(path, text);
    const summary = await summarizeSessionFile(path, Buffer.byteLength(text));
    expect(summary?.header.cwd).toBe("/repo");
    expect(summary?.title).toBe("Fix the login bug");
    expect(summary?.name).toBe("Login fix");
  });
});

describe("textOf (titles from session files)", () => {
  it("leaves out the blocks pi-gna adds to a prompt", () => {
    expect(textOf("<kanban-card>\nCard aaaaaa: Fix it\n</kanban-card>\n\nWhy does it fail?")).toBe("Why does it fail?");
    expect(textOf([{ type: "text", text: "Look at this\n\n<browser-comments>\n1. here\n</browser-comments>" }])).toBe("Look at this");
  });
});
