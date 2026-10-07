import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
});
