import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AtpThreads } from "./atp-threads";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it.each([String.raw`C:\Repo ü`, "D:/Repo ü", String.raw`\\server\share\Repo ü`])("persists and reloads Windows plan threads and drafts at %s", async (project) => {
  const dir = await mkdtemp(join(tmpdir(), "pigna-atp-threads-"));
  dirs.push(dir);
  const file = join(dir, "threads.json");
  const plan = `${project}/p.atp.json`;
  const session = String.raw`C:\Users\me\.pi\agent\sessions\one.jsonl`;
  const threads = new AtpThreads(file);
  await threads.setOrchestrator(plan, session);
  await threads.remember(plan, "node", session);
  const draft = { id: "abc123", project, cwd: project, session, title: "Windows plan", startedAt: 1, updatedAt: 2, seenAt: 0 };
  await threads.setDraft(draft);
  const restarted = new AtpThreads(file);
  expect(await restarted.get(plan)).toEqual({ orchestrator: session, workers: { node: [session] } });
  expect(await restarted.drafts()).toEqual([draft]);
  // The legacy desktop import uses the same validator, and retains threads already held by the host.
  await restarted.importLegacy({ [plan]: { workers: { other: [session] } } });
  expect((await new AtpThreads(file).get(plan)).workers).toEqual({ node: [session], other: [session] });
});

it("drops relative, device and NUL paths from persisted/imported ATP references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigna-atp-threads-"));
  dirs.push(dir);
  const file = join(dir, "threads.json");
  const plan = "C:/repo/p.atp.json";
  const invalid = ["C:session.jsonl", "relative.jsonl", "C:/x\0.jsonl", String.raw`\\?\C:\x.jsonl`];
  await writeFile(file, JSON.stringify({
    plans: { [plan]: { orchestrator: invalid[0], workers: { bad: invalid, good: ["C:/one.jsonl", ...invalid] } }, "C:p.atp.json": { workers: {} } },
    drafts: { abc123: { project: "C:repo", cwd: "C:/repo", session: "C:/one.jsonl" } },
  }));
  const store = new AtpThreads(file);
  expect(await store.get(plan)).toEqual({ workers: { good: ["C:/one.jsonl"] } });
  expect(await store.get("C:p.atp.json")).toEqual({ workers: {} });
  expect(await store.drafts()).toEqual([]);
});
