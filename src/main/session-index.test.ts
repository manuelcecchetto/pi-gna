import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSessions } from "./session-index";

vi.mock("./log", () => ({ log: { info: () => undefined, warn: () => undefined } }));

const header = { type: "session", version: 3, id: "sid", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/repo" };
const user = (id: string, content: unknown) => ({ type: "message", id, parentId: null, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content, timestamp: 0 } });
const jsonl = (records: object[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

describe("listSessions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists a chat whose first message has no text (an image), and hides one nothing was sent in", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gna-index-"));
    const dir = join(root, "--repo--");
    await mkdir(dir);
    await writeFile(join(dir, "image.jsonl"), jsonl([header, user("u1", [{ type: "image", data: "", mimeType: "image/png" }])]));
    await writeFile(join(dir, "text.jsonl"), jsonl([header, user("u1", "Fix the login bug")]));
    await writeFile(join(dir, "empty.jsonl"), jsonl([header]));
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", root);

    const titles = (await listSessions()).flatMap((project) => project.sessions.map((session) => [session.path.slice(dir.length + 1), session.title]));
    expect(titles.sort()).toEqual([["image.jsonl", "New chat"], ["text.jsonl", "Fix the login bug"]]);
  });

  it("keeps the index on disk: a new launch reuses it, and files that are gone are dropped", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-gna-index-"));
    const dir = join(root, "--repo--");
    await mkdir(dir);
    await writeFile(join(dir, "a.jsonl"), jsonl([header, user("u1", "First chat")]));
    await writeFile(join(dir, "b.jsonl"), jsonl([header, user("u1", "Second chat")]));
    await writeFile(join(dir, "empty.jsonl"), jsonl([header]));
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", root);
    const file = join(root, "session-index.json");
    const saved = async () => JSON.parse(await readFile(file, "utf8")) as { version: number; entries: [string, { summary: { title: string } | null }][] };
    // The saved index loads slowly, so a listing that does not wait for it would read the session files.
    vi.doMock("node:fs/promises", async (actual) => {
      const fs = await actual<typeof import("node:fs/promises")>();
      return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => (await new Promise((done) => setTimeout(done, 30)), fs.readFile(...args)) };
    });
    const launch = async () => {
      vi.resetModules();
      const index = await import("./session-index");
      index.persistSessionIndex(file);
      return (await index.listSessions()).flatMap((project) => project.sessions.map((session) => session.title)).sort();
    };

    expect(await launch()).toEqual(["First chat", "Second chat"]);
    await vi.waitFor(async () => expect((await saved()).entries).toHaveLength(3));
    // A title read from the saved index, not from the session file, proves the next launch skips unchanged files.
    const index = await saved();
    const entry = (name: string) => index.entries.find(([path]) => path.endsWith(name))?.[1];
    expect(entry("empty.jsonl")?.summary).toBeNull();
    entry("a.jsonl")!.summary!.title = "From the saved index";
    await writeFile(file, JSON.stringify(index));
    await rm(join(dir, "b.jsonl"));

    expect(await launch()).toEqual(["From the saved index"]);
    await vi.waitFor(async () => expect((await saved()).entries.map(([path]) => path.slice(dir.length + 1)).sort()).toEqual(["a.jsonl", "empty.jsonl"]));

    // A file from another version, or a damaged one, is ignored.
    await writeFile(file, JSON.stringify({ ...(await saved()), version: 0 }));
    expect(await launch()).toEqual(["First chat"]);
    for (const damaged of ["{", "null", '{"version":1,"entries":[null]}']) {
      await writeFile(file, damaged);
      expect(await launch()).toEqual(["First chat"]);
    }
    vi.doUnmock("node:fs/promises");
  });
});
