import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeBranch, cutUserTitle, parseRecords, summarizeSessionFile, textOf } from "./session-file";

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

  afterEach(() => vi.restoreAllMocks());

  it("keeps a name given before the first message once the file outgrows the tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-gna-"));
    const path = join(dir, "s.jsonl");
    const text = jsonl([
      header,
      { type: "session_info", id: "n1", parentId: null, timestamp: "", name: "Named early" },
      msg("u1", "n1", "user", "Hello"),
      ...Array.from({ length: 20 }, (_, i) => msg(`f${i}`, "u1", "assistant", "y".repeat(5_000))),
    ]);
    await writeFile(path, text);
    expect((await summarizeSessionFile(path, Buffer.byteLength(text)))?.name).toBe("Named early");
  });

  it("never parses the system prompt, even one that quotes a header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-gna-"));
    const path = join(dir, "s.jsonl");
    const quoted = JSON.stringify({ ...header, id: "fake", cwd: "/elsewhere" });
    const text = jsonl([header, msg("sys", null, "system", `${quoted}\n${"x".repeat(50_000)}`), msg("u1", "sys", "user", "Hello")]);
    await writeFile(path, text);
    const parse = vi.spyOn(JSON, "parse");
    const summary = await summarizeSessionFile(path, Buffer.byteLength(text));
    expect(summary?.header).toEqual(header);
    expect(summary?.title).toBe("Hello");
    expect(parse.mock.calls.filter(([line]) => String(line).includes('"role":"system"'))).toEqual([]);
  });

  it("reads the title of a first prompt whose images run past the 1 MB head", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-gna-"));
    const path = join(dir, "s.jsonl");
    const image = { type: "image", data: "A".repeat(3_000_000), mimeType: "image/png" };
    const text = jsonl([
      header,
      msg("sys", null, "system", "x".repeat(100_000)),
      msg("u1", "sys", "user", [{ type: "text", text: "Why is this \"button\" blue?" }, image]),
      msg("a1", "u1", "assistant", "Because."),
    ]);
    await writeFile(path, text);
    const summary = await summarizeSessionFile(path, Buffer.byteLength(text));
    expect(summary?.title).toBe('Why is this "button" blue?');
  });
});

describe("cutUserTitle (a first prompt cut off by the head limit)", () => {
  const line = (content: unknown) => JSON.stringify(msg("u1", null, "user", content));
  const cut = (text: string, end: number) => text.slice(0, text.length - end);

  it("reads the first text block before the cut", () => {
    const full = line([{ type: "text", text: "Fix   the\nlogin" }, { type: "image", data: "A".repeat(100), mimeType: "image/png" }]);
    expect(cutUserTitle(cut(full, 50))).toBe("Fix the login");
  });

  it("keeps what came before a cut inside the text, dropping a split escape", () => {
    const full = line("Bell and \u0007 more");
    const at = full.indexOf("\\u0007");
    expect(full.slice(at, at + 7)).toBe("\\u0007 ");
    expect(cutUserTitle(full.slice(0, at + 3))).toBe("Bell and");
    expect(cutUserTitle(full.slice(0, at + 1))).toBe("Bell and");
    expect(cutUserTitle(full.slice(0, at + 5))).toBe("Bell and");
    expect(cutUserTitle(full.slice(0, at + 6))).toBe("Bell and \u0007");
    const quote = line('say "hi"');
    expect(cutUserTitle(quote.slice(0, quote.indexOf('\\"hi') + 1))).toBe("say");
  });

  it("counts a prompt cut before any text as a chat without a title, and ignores other records", () => {
    expect(cutUserTitle(cut(line([{ type: "image", data: "A".repeat(100), mimeType: "image/png" }]), 20))).toBe("");
    expect(cutUserTitle(cut(JSON.stringify(msg("a1", null, "assistant", "Sure")), 4))).toBeUndefined();
    expect(cutUserTitle("")).toBeUndefined();
    const plain = line("Hello");
    expect(cutUserTitle(plain.slice(0, plain.indexOf('"content":') + 10))).toBe("");
    expect(cutUserTitle(line(null))).toBe("");
  });
});

describe("textOf (titles from session files)", () => {
  it("leaves out the blocks pi-gna adds to a prompt", () => {
    expect(textOf("<kanban-card>\nCard aaaaaa: Fix it\n</kanban-card>\n\nWhy does it fail?")).toBe("Why does it fail?");
    expect(textOf([{ type: "text", text: "Look at this\n\n<browser-comments>\n1. here\n</browser-comments>" }])).toBe("Look at this");
  });
});
