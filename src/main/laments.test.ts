import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { worktreeCwd } from "../shared/board";
import type { Laments } from "../shared/laments";
import { LamentStore, lamentRoute } from "./laments";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const folder = () => mkdtemp(join(tmpdir(), "pigna-laments-"));
const text = (result: unknown) => (result as { text: string }).text;
const idOf = (result: unknown) => (result as { lament: string }).lament;

describe("POST /lament", () => {
  const chat = { path: "/s/chat.jsonl", cwd: "/repo" };
  const setup = async (from = chat) => {
    const dir = await folder();
    const pushed: Laments[] = [];
    const store = new LamentStore(join(dir, "laments.json"), (laments) => pushed.push(laments));
    await store.apply({ type: "file", id: "cccccc", title: "Elsewhere", text: "x", severity: "blocking", cwd: "/other" });
    return { dir, store, pushed, route: lamentRoute(store, async () => from) };
  };

  it("files a lament on the chat's project board, saves it and pushes it", async () => {
    const { dir, store, pushed, route } = await setup();
    const result = await route("h", { title: "No tab recorder", body: "Recorded the screen instead.", severity: "costly" });
    expect(text(result)).toBe(`Filed lament ${idOf(result)} on the Lamenting board of /repo: 😠 Costly. The user reads it there; carry on with your workaround.`);
    const lament = (await store.get()).laments.find((other) => other.id === idOf(result));
    expect(lament).toMatchObject({ title: "No tab recorder", cwd: "/repo", reports: [{ text: "Recorded the screen instead.", severity: "costly", chat }] });
    expect(pushed.at(-1)?.laments).toHaveLength(2);
    await store.flushed();
    expect(JSON.parse(await readFile(join(dir, "laments.json"), "utf8")).laments).toHaveLength(2);
    expect(await readdir(dir)).toEqual(["laments.json"]);
  });

  it("names the project's other open laments, and adds a repeat to one, reopening it", async () => {
    const { store, route } = await setup();
    const first = idOf(await route("h", { title: "No tab recorder", body: "one", severity: "annoying" }));
    await store.apply({ type: "resolve", id: first, resolved: true });
    const second = await route("h", { title: "Logs are truncated", body: "two", severity: "blocking" });
    expect(text(second)).not.toContain("Other open laments"); // the first is resolved, cccccc is another project's
    const again = await route("h", { title: "ignored", body: "three", severity: "blocking", repeats: first });
    expect(idOf(again)).toBe(first);
    expect(text(again)).toContain(`Added to lament ${first} (No tab recorder), which was resolved and is open again on the Lamenting board of /repo: 🤬 Blocking.`);
    expect(text(again)).toContain(`Other open laments of this project (pass the id as repeats if you hit one of them):\n- ${idOf(second)} 🤬 Logs are truncated`);
    const lament = (await store.get()).laments.find((other) => other.id === first);
    expect(lament?.resolvedAt).toBeUndefined();
    expect(lament?.reports.map((report) => report.text)).toEqual(["one", "three"]);
  });

  it("refuses a repeat of another project's lament and bad input", async () => {
    const { route } = await setup();
    await expect(route("h", { title: "x", body: "y", severity: "annoying", repeats: "cccccc" })).rejects.toThrow("No lament cccccc on this project's Lamenting board");
    await expect(route("h", { title: "x", body: "y", severity: "furious" })).rejects.toThrow("unknown severity furious");
    await expect(route("h", { title: "", body: "y", severity: "annoying" })).rejects.toThrow("a lament needs a title");
    await expect(route("h", null)).rejects.toThrow("title must be text");
  });

  it("files a card worktree's lament on its project's board", async () => {
    const { store, route } = await setup({ path: "/s/resolve.jsonl", cwd: worktreeCwd("/Users/me", "abc123", "/repo") });
    const id = idOf(await route("h", { title: "No dependencies in the worktree", body: "Installed them.", severity: "annoying" }));
    expect((await store.get()).laments.find((lament) => lament.id === id)?.cwd).toBe("/repo");
  });

  it("counts every applied change as a revision, and ignores a baseRev it has no text edit for", async () => {
    const { store, route } = await setup();
    const before = (await store.get()).rev;
    const id = idOf(await route("h", { title: "No tab recorder", body: "one", severity: "annoying" }));
    await store.apply({ type: "resolve", id, resolved: true }, 0);
    await store.apply({ type: "resolve", id, resolved: true }); // already resolved: no revision
    expect((await store.get()).rev).toBe(before + 2);
  });
});
