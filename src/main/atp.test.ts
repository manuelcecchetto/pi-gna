import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AtpPlanFile } from "../shared/atp";
import { Atp } from "./atp";
import { ATP_BRANCHES } from "./worktree";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The bundled librarian, from the checkout.
vi.mock("./resources", () => ({ onDisk: (...parts: string[]) => join(process.cwd(), ...parts) }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const plan = {
  meta: { project_name: "Tiny", version: "1.3", project_status: "DRAFT" },
  nodes: {
    T1: { title: "First", instruction: "Write a.txt", dependencies: [], status: "READY" },
    T2: { title: "Second", instruction: "Write b.txt", dependencies: ["T1"], status: "LOCKED" },
  },
};

// Real git, python3 and rg in a temporary folder, with a git config of its own.
let root: string;
let repo: string;
let path: string;
let atp: Atp;
const pushed: string[][] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pigna-atp-"));
  repo = join(root, "repo");
  await writeFile(join(root, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  await mkdir(join(repo, "plans"), { recursive: true });
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  path = join(repo, "plans", "tiny.atp.json");
  await writeFile(path, JSON.stringify(plan));
  await writeFile(join(repo, "node_modules", "dep", "fixture.atp.json"), JSON.stringify(plan));
  await writeFile(join(repo, "broken.atp.json"), "{");
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "start");
  pushed.length = 0;
  atp = new Atp(
    () => undefined,
    (held) => pushed.push(held),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await atp.watch(null);
  await rm(root, { recursive: true, force: true });
});

describe("Atp", () => {
  it("finds the project's plans, not those in dependencies, and reports the ones it cannot read", async () => {
    const found = await atp.scan(repo);
    expect(found.plans.map((file) => file.path)).toEqual([join(repo, "broken.atp.json"), path]);
    expect(found.plans[0]?.error).toBeTruthy();
    expect(found.plans[1]?.plan?.name).toBe("Tiny");
  });

  it("shows a plan the architect writes to docs/plans/draft, also when it creates that folder", async () => {
    const plans: string[][] = [];
    atp = new Atp(
      (found) => plans.push(found.plans.map((file) => file.path)),
      () => undefined,
    );
    await atp.watch(repo);
    const draft = join(repo, "docs", "plans", "draft", "fresh.atp.json");
    await mkdir(dirname(draft), { recursive: true });
    await vi.waitFor(() => expect(plans.length).toBeGreaterThan(0), { timeout: 3000 });
    await writeFile(draft, JSON.stringify(plan));
    await vi.waitFor(() => expect(plans.at(-1)).toContain(draft), { timeout: 3000 });
  });

  it("re-reads the watched folders on a change, without running rg or git again, and keeps the plans that did not change", async () => {
    const calls: string[] = [];
    const exec = (file: string, args: string[], options: { cwd?: string } = {}) => {
      calls.push(file === "git" ? `git ${args.slice(2).join(" ")}` : file);
      return new Promise<string>((resolve, reject) =>
        execFile(file, args, { cwd: options.cwd }, (error, stdout) => (error ? reject(Object.assign(error, { message: "" })) : resolve(stdout))),
      );
    };
    const pushes: AtpPlanFile[][] = [];
    atp = new Atp(
      (found) => pushes.push(found.plans),
      () => undefined,
      exec,
    );
    await mkdir(join(repo, "docs"));
    // Listed after the folders on the way to docs/plans/draft, sorted before them.
    const early = join(repo, "ab", "early.atp.json");
    await mkdir(dirname(early));
    await writeFile(early, JSON.stringify(plan));
    const first = await atp.watch(repo);
    expect(calls).toEqual(["rg", "git worktree list --porcelain"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    calls.length = 0;
    const named = () => (pushes.at(-1) ?? []).map((file) => `${file.path} ${file.plan?.name ?? "-"}`);
    // Replaced, as the librarian does.
    await writeFile(`${path}.tmp`, JSON.stringify({ ...plan, meta: { ...plan.meta, project_name: "Renamed" } }));
    await rename(`${path}.tmp`, path);
    await vi.waitFor(() => expect(named()).toContain(`${path} Renamed`), { timeout: 3000 });
    // The plan that did not change is the one read before.
    expect(pushes.at(-1)?.find((file) => file.path.endsWith("broken.atp.json"))).toBe(first?.plans[1]);
    const other = join(repo, "plans", "other.atp.json");
    await writeFile(other, JSON.stringify(plan));
    await vi.waitFor(() => expect(named()).toContain(`${other} Tiny`), { timeout: 3000 });
    // In docs/plans, a folder on the way to docs/plans/draft; a folder named like a plan is none.
    await mkdir(join(repo, "docs", "plans", "folder.atp.json"), { recursive: true });
    const top = join(repo, "docs", "plans", "top.atp.json");
    await writeFile(top, JSON.stringify(plan));
    await vi.waitFor(() => expect(named()).toContain(`${top} Tiny`), { timeout: 3000 });
    await rm(other);
    await vi.waitFor(() => expect(named()).not.toContain(`${other} Tiny`), { timeout: 3000 });
    expect(calls).toEqual([]);
    expect(named()).toEqual([`${early} Tiny`, `${join(repo, "broken.atp.json")} -`, `${top} Tiny`, `${path} Renamed`]);
  });

  it("writes a new plan in a worktree of the project, shows its plan but not its copies of the project's, and reuses an empty one", async () => {
    const home = join(root, "home");
    const plans: string[][] = [];
    atp = new Atp(
      (found) => plans.push(found.plans.map((file) => file.path)),
      () => undefined,
      undefined,
      home,
    );
    await atp.watch(repo);
    const folder = await atp.newPlanCwd(repo);
    expect(folder).toMatch(new RegExp(`^${home}/\\.pi-gna/worktrees/[a-z0-9]{6}${repo}$`));
    expect(git(folder, "rev-parse", "--abbrev-ref", "HEAD")).toMatch(new RegExp(`^${ATP_BRANCHES}[a-z0-9]{6}$`));
    // Nothing written yet: the worktree's committed copy of plans/tiny.atp.json is the project's plan, shown once.
    expect((await atp.scan(repo)).plans.map((file) => file.path)).toEqual([join(repo, "broken.atp.json"), path]);
    // An empty worktree is reused, brought up to the checkout's HEAD.
    await writeFile(join(repo, "later.txt"), "later\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "later");
    expect(await atp.newPlanCwd(repo)).toBe(folder);
    expect(git(folder, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));

    // The architect writes its plan in the worktree: the watched project shows it, and the next new plan gets another worktree.
    const draft = join(folder, "docs", "plans", "draft", "fresh.atp.json");
    await mkdir(dirname(draft), { recursive: true });
    await writeFile(draft, JSON.stringify(plan));
    await vi.waitFor(() => expect(plans.at(-1)).toContain(draft), { timeout: 3000 });
    expect((await atp.scan(repo)).plans.map((file) => file.path)).toEqual([join(repo, "broken.atp.json"), path, draft]);
    const next = await atp.newPlanCwd(repo);
    expect(next).not.toBe(folder);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("writes a new plan in place outside git", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await new Atp(() => undefined, () => undefined, undefined, join(root, "home")).newPlanCwd(plain)).toBe(plain);
  });

  it("activates, claims, gets the same node back for the same agent, and releases it", async () => {
    expect((await atp.claim(path, "pigna-w1")).kind).toBe("inactive");
    await atp.activate(path);
    const claim = await atp.claim(path, "pigna-w1");
    expect(claim).toMatchObject({ kind: "assigned", node: "T1", title: "First" });
    expect(await atp.claim(path, "pigna-w1")).toMatchObject({ kind: "assigned", node: "T1" });
    expect((await atp.claim(path, "someone-else")).kind).toBe("none");
    await atp.release(path, "T1", "pigna-w1", "stopped");
    expect((await atp.read(path)).nodes.find((node) => node.id === "T1")?.status).toBe("READY");
    await expect(atp.release(path, "T1", "pigna-w1", "again")).rejects.toThrow(/not CLAIMED/);
  });

  it("keeps the librarian's lock file out of git, in the repository's local excludes", async () => {
    await atp.activate(path);
    await atp.activate(path);
    // The plan the librarian activated (" M", trimmed), and no "?? plans/tiny.atp.json.lock".
    expect(git(repo, "status", "--porcelain")).toBe("M plans/tiny.atp.json");
    const exclude = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((line) => line === "*.atp.json.lock")).toHaveLength(1);
  });

  it("claims nothing while an orchestrator holds the plan", async () => {
    await atp.activate(path);
    atp.setHeld(path, true);
    expect((await atp.claim(path, "pigna-w1")).kind).toBe("held");
    atp.setHeld(path, false);
    expect((await atp.claim(path, "pigna-w1")).kind).toBe("assigned");
    expect(pushed).toEqual([[path], []]);
  });

  it("commits what a worker left, but not when it committed itself or changed nothing", async () => {
    const before = await atp.head(repo);
    expect(before?.branch).toBe("main");
    expect(await atp.commit(repo, "T1", "First", before)).toEqual({ kind: "clean" });

    await writeFile(join(repo, "a.txt"), "a\n");
    await writeFile(join(repo, "plans", "tiny.atp.json.lock"), "");
    const committed = await atp.commit(repo, "T1", "First   thing", before);
    expect(committed.kind).toBe("committed");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("node(T1): First thing");
    expect(git(repo, "status", "--porcelain")).toBe("?? plans/tiny.atp.json.lock");

    const next = await atp.head(repo);
    await writeFile(join(repo, "b.txt"), "b\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-qm", "node(T2): Second");
    await writeFile(join(repo, "c.txt"), "c\n");
    expect(await atp.commit(repo, "T2", "Second", next)).toEqual({ kind: "worker" });
    expect(await readFile(join(repo, "c.txt"), "utf8")).toBe("c\n");
  });

  it("has no head outside git", async () => {
    const outside = join(root, "plain");
    await mkdir(outside);
    expect(await atp.head(outside)).toBeNull();
    expect(await atp.commit(outside, "T1", "First", null)).toEqual({ kind: "no-repo" });
  });

  it("pauses through the bridge once no worker holds a node", async () => {
    const route = atp.route();
    await atp.activate(path);
    const claim = await atp.claim(path, "pigna-w1");
    expect(claim.kind).toBe("assigned");
    const pausing = route("h", { action: "pause", plan: path }) as Promise<{ text: string }>;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await atp.claim(path, "pigna-w1")).kind).toBe("held");
    await atp.release(path, "T1", "pigna-w1", "done for the test");
    expect((await pausing).text).toMatch(/^Paused: no worker holds a node/);
    await route("h", { action: "resume", plan: path });
    expect(atp.heldPlans()).toEqual([]);
    await expect(route("h", { action: "pause", plan: "relative.atp.json" })).rejects.toThrow(/absolute path/);
  });
});
