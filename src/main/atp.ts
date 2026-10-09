// The ATP page's main side: the project's plans (`*.atp.json`), read and pushed to the window as they change; the
// bundled librarian CLI, which the runner claims and releases nodes with (plans are never written here); git around
// each node, for atp-runner's commit-per-node; and the hold an orchestrator puts on a plan while it changes it.
// A new plan is written in a git worktree of its own (newPlanCwd), so the project's plans include those worktrees'.
import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type AtpBridgeRequest,
  type AtpClaim,
  type AtpHead,
  type AtpPlan,
  type AtpPlanFile,
  type AtpProjectPlans,
  isPlanPath,
  NEW_PLAN_DIR,
  parseClaim,
  parsePlan,
  workingNodes,
} from "../shared/atp";
import { emptyBoard, freshId, isCardId, worktreeCwd } from "../shared/board";
import { bridgeError, type Route } from "./bridge";
import { log } from "./log";
import { onDisk } from "./resources";
import { ATP_BRANCHES, atpWorktree } from "./worktree";

const SKILLS = () => onDisk("resources", "atp", "skills");
const LOCK_PATTERN = "*.atp.json.lock";
/** The skills an ATP chat gets with `--skill`, per role: workers only need the librarian. */
export const atpSkills = (role: "worker" | "orchestrator"): string[] =>
  (role === "worker" ? ["atp-local-librarian"] : ["atp-architect", "atp-micro-architect", "atp-local-librarian"]).map((name) => join(SKILLS(), name));
export const librarianPath = (): string => join(SKILLS(), "atp-local-librarian", "scripts", "atp_local_librarian.py");

/** What the runner commits as when a worker left changes uncommitted (atp-runner's fallback). */
export type AtpCommit = { kind: "committed"; sha: string } | { kind: "worker" | "clean" | "no-repo" };

type Run = (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<string>;

const run: Run = (file, args, options = {}) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { cwd: options.cwd, timeout: options.timeout ?? 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(Object.assign(new Error(missing ? `${file} is not installed (or not on PATH)` : stderr.trim().replace(/^ERROR: /, "") || error.message), { code: (error as NodeJS.ErrnoException).code }));
    }),
  );

/** Folders never searched for plans: dependencies, VCS data and build output. */
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "out", "target", ".venv", "venv", "Library"];
/** Plans live near a project's root; deeper ones are someone's fixtures. */
const MAX_DEPTH = "5";
const PAUSE_WAIT = 4 * 60_000;

/** The folder new plans go to and the folders above it, down from the project root, which may not exist yet. */
const newPlanDirs = (cwd: string): string[] => [cwd, ...NEW_PLAN_DIR.split("/").map((_, i, parts) => join(cwd, ...parts.slice(0, i + 1)))];

/**
 * What a watched project's rescans reuse, so a plan's change costs a folder listing per watched folder, not rg and git:
 * its new plans' worktrees, the folders each root's plans were found in, and each plan as last read, by its stat.
 */
type Cache = { roots?: string[]; dirs: Map<string, Set<string>>; files: Map<string, { key: string; file: AtpPlanFile }> };
type Watched = { cwd: string; watchers: Map<string, FSWatcher>; timer?: ReturnType<typeof setTimeout>; cache: Cache; rescan?: boolean };
/** The project's plans, and the folders they are looked for in: the project and its new plans' worktrees. */
type Found = { plans: AtpProjectPlans; roots: string[] };

export class Atp {
  private project?: Watched;
  /** Plans an orchestrator paused (atp_pause): the runner claims no node of them. */
  private readonly held = new Set<string>();

  constructor(
    private readonly pushPlans: (plans: AtpProjectPlans) => void,
    private readonly pushHeld: (held: string[]) => void,
    private readonly exec: Run = run,
    private readonly home = homedir(),
  ) {}

  // ── Plans ──────────────────────────────────────────────────────────────────

  /** The project's plans; they (and NEW_PLAN_DIR, where new plans go) are watched until another project is. */
  async watch(cwd: string | null): Promise<AtpProjectPlans | null> {
    this.unwatch();
    if (!cwd) return null;
    const project: Watched = { cwd, watchers: new Map(), cache: { dirs: new Map(), files: new Map() } };
    this.project = project;
    const found = await this.collect(cwd, project.cache);
    if (this.project === project) this.watchDirs(project, found);
    return found.plans;
  }

  /**
   * Plans are replaced (the librarian writes a temp file and renames it), so their folders are watched, not the files.
   * So is NEW_PLAN_DIR, in the project and in each new plan's worktree, which the architect may create: each existing
   * folder on the way to it rescans when the next one appears, and the rescan watches that one.
   * A new watcher misses what happens while it starts (macOS starts FSEvents asynchronously, up to tens of ms; the
   * architect may create the folder and the plan in one go), so adding one rescans once more, after the debounce.
   */
  private watchDirs(project: Watched, { plans, roots }: Found): void {
    const chains = roots.map(newPlanDirs);
    const next = new Map(chains.flatMap((chain) => chain.slice(0, -1).map((dir, i) => [dir, basename(chain[i + 1] as string)] as const)));
    const watched = project.watchers.size;
    for (const dir of [...chains.flat(), ...plans.plans.map((plan) => dirname(plan.path))]) {
      if (project.watchers.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, (_event, name) => {
          const file = name?.toString() ?? "";
          if ((file.includes(".atp.json") && !file.endsWith(".lock")) || file === next.get(dir)) this.changed(project);
        });
        watcher.on("error", () => {
          watcher.close();
          project.watchers.delete(dir);
        });
        project.watchers.set(dir, watcher);
      } catch (error) {
        log.warn("atp", `cannot watch ${dir}: ${(error as Error).message}`);
      }
    }
    if (project.watchers.size > watched) this.changed(project);
  }

  private unwatch(): void {
    if (!this.project) return;
    clearTimeout(this.project.timer);
    for (const watcher of this.project.watchers.values()) watcher.close();
    this.project = undefined;
  }

  /** A change in a watched folder re-reads those folders; a new plan's worktree (made) looks for plans and worktrees again. */
  private changed(project: Watched, rescan = false): void {
    clearTimeout(project.timer);
    project.rescan ||= rescan;
    project.timer = setTimeout(() => {
      const rescan = project.rescan === true;
      project.rescan = false;
      void this.collect(project.cwd, project.cache, rescan).then((found) => {
        if (this.project !== project) return;
        this.watchDirs(project, found);
        this.pushPlans(found.plans);
      });
    }, 150);
  }

  /** The project's plans, and those its new plans' worktrees hold of their own. */
  async scan(cwd: string): Promise<AtpProjectPlans> {
    return (await this.collect(cwd)).plans;
  }

  /**
   * The project's plans, then its new plans' worktrees' that the project has no copy of at the same place: a worktree
   * starts with the project's committed plans, which are the project's, and a plan merged back is the project's too.
   */
  private async collect(cwd: string, cache?: Cache, rescan = false): Promise<Found> {
    const [own, roots] = await Promise.all([this.plansIn(cwd, cache, rescan), rescan || !cache?.roots ? this.planWorktrees(cwd) : cache.roots]);
    if (cache) cache.roots = roots;
    const known = new Set(own.map((path) => path.slice(cwd.length)));
    const theirs = await Promise.all(roots.map(async (root) => (await this.plansIn(root, cache, rescan)).filter((path) => !known.has(path.slice(root.length)))));
    const paths = [...own, ...theirs.flat()];
    return { plans: { cwd, plans: await Promise.all(paths.map((path) => this.readFile(path, cache?.files))) }, roots: [cwd, ...roots] };
  }

  /**
   * The plans under a root: rg's the first time and on a rescan; else the plans in the folders a watcher can report
   * (those plans were found in, and the way to NEW_PLAN_DIR), listed again.
   */
  private async plansIn(root: string, cache: Cache | undefined, rescan: boolean): Promise<string[]> {
    const dirs = cache?.dirs.get(root);
    if (rescan || !dirs) {
      const found = await this.find(root);
      cache?.dirs.set(root, new Set(found.map(dirname)));
      return found;
    }
    const listed = await Promise.all(
      [...new Set([...newPlanDirs(root), ...dirs])].map(async (dir) =>
        (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name)),
      ),
    );
    return listed.flat().filter(isPlanPath).sort();
  }

  /** Every `*.atp.json` under the folder (rg: hidden and git-ignored files too, not dependencies or build output). */
  private async find(cwd: string): Promise<string[]> {
    const globs = SKIP_DIRS.flatMap((dir) => ["-g", `!${dir}`]);
    const stdout = await this.exec("rg", ["--files", "--hidden", "--no-ignore-vcs", "--max-depth", MAX_DEPTH, "-g", "*.atp.json", ...globs, cwd], { timeout: 15_000 }).catch(
      (error: Error & { code?: unknown }) => {
        // rg exits 1 when it finds nothing.
        if (error.code === 1 || !error.message) return "";
        log.warn("atp", `cannot look for plans in ${cwd}: ${error.message}`);
        return "";
      },
    );
    return stdout.split("\n").filter(isPlanPath).sort();
  }

  // ── New plans' worktrees ───────────────────────────────────────────────────

  /** The project's folder in each of its new plans' worktrees (git branches pigna/atp-<id>) that is there. */
  private async planWorktrees(cwd: string): Promise<string[]> {
    const list = await this.exec("git", ["-C", cwd, "worktree", "list", "--porcelain"]).catch(() => "");
    const branches = [...list.matchAll(/^branch refs\/heads\/(.+)$/gm)].map((match) => match[1] as string);
    const ids = [...new Set(branches.filter((branch) => branch.startsWith(ATP_BRANCHES)).map((branch) => branch.slice(ATP_BRANCHES.length)))].filter(isCardId);
    return ids.map((id) => worktreeCwd(this.home, id, cwd)).filter((folder) => existsSync(folder));
  }

  /**
   * Where a new plan's architect works: a git worktree of the project on a branch of its own, so the plan and what
   * its runs change stay off the checkout until you merge them. An earlier one that holds no plan and no change is
   * reused (brought up to the checkout's HEAD); a project outside git, or without a commit, writes in place.
   */
  async newPlanCwd(cwd: string): Promise<string> {
    const head = (await this.exec("git", ["-C", cwd, "rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim();
    if (!head) return cwd;
    const { plans, roots } = await this.collect(cwd);
    for (const root of roots.slice(1)) {
      if (plans.plans.some((file) => file.path.startsWith(`${root}/`))) continue;
      const clean = (await this.exec("git", ["-C", root, "status", "--porcelain"]).catch(() => "?")).trim() === "";
      if (clean && (await this.exec("git", ["-C", root, "merge", "--ff-only", "-q", head]).then(() => true, () => false))) return this.made(cwd, root);
    }
    let id = freshId(emptyBoard());
    while (existsSync(worktreeCwd(this.home, id, ""))) id = freshId(emptyBoard());
    const made = await atpWorktree(cwd, id, this.home);
    return made ? this.made(cwd, made.cwd) : cwd;
  }

  /** A new plan's worktree is ready: the watched project looks in it too. */
  private made(cwd: string, folder: string): string {
    if (this.project?.cwd === cwd) this.changed(this.project, true);
    return folder;
  }

  /** A plan, or the one read before (a plan that cannot be read included) while its file is the same: same inode, size and times. */
  private async readFile(path: string, cache?: Cache["files"]): Promise<AtpPlanFile> {
    const info = await stat(path).catch((error: Error) => error);
    if (info instanceof Error) return { path, modifiedAt: 0, error: info.message };
    const key = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const hit = cache?.get(path);
    if (hit?.key === key) return hit.file;
    let file: AtpPlanFile;
    try {
      file = { path, modifiedAt: info.mtimeMs, plan: parsePlan(path, JSON.parse(await readFile(path, "utf8"))) };
    } catch (error) {
      file = { path, modifiedAt: 0, error: (error as Error).message };
    }
    cache?.set(path, { key, file });
    return file;
  }

  async read(path: string): Promise<AtpPlan> {
    const file = await this.readFile(checkPlan(path));
    if (!file.plan) throw new Error(`cannot read ${path}: ${file.error}`);
    return file.plan;
  }

  // ── The runner ─────────────────────────────────────────────────────────────

  private librarian(command: string, plan: string, args: string[] = []): Promise<string> {
    return this.exec("python3", [librarianPath(), command, "--plan-path", checkPlan(plan), ...args]).then((out) => out.trim());
  }

  /** DRAFT or PAUSED -> ACTIVE (Start on the page); a plan that is already active stays so. */
  async activate(plan: string): Promise<string> {
    await this.excludeLocks(dirname(checkPlan(plan))).catch((error) => log.warn("atp", `cannot keep the librarian's lock files out of git: ${(error as Error).message}`));
    return this.librarian("atp-activate-project", plan, ["--actor-id", "pigna", "--reason", "The user started the plan on pi-gna's ATP page."]);
  }

  /**
   * The librarian leaves a `<plan>.lock` next to the plan for its file lock: list it in the repository's local
   * `.git/info/exclude` (never a tracked .gitignore), so workers' `git add -A` and git status never see it.
   */
  private async excludeLocks(dir: string): Promise<void> {
    const exclude = await this.exec("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).catch(() => "");
    if (!exclude.trim()) return;
    const path = exclude.trim();
    const current = await readFile(path, "utf8").catch(() => "");
    if (current.split("\n").includes(LOCK_PATTERN)) return;
    await appendFile(path, `${current && !current.endsWith("\n") ? "\n" : ""}# pi-gna: the ATP librarian's lock files\n${LOCK_PATTERN}\n`);
  }

  /** The node the runner works on next: the one it already holds (an interrupted run), else the next READY one. */
  async claim(plan: string, agent: string): Promise<AtpClaim> {
    if (this.held.has(plan)) return { kind: "held", message: "The plan's orchestrator paused it while it changes the plan." };
    return parseClaim(await this.librarian("atp-claim-task", plan, ["--agent-id", agent]));
  }

  release(plan: string, node: string, agent: string, reason: string): Promise<string> {
    return this.librarian("atp-release-claim", plan, ["--node-id", node, "--agent-id", agent, "--reason", reason]);
  }

  // ── git ────────────────────────────────────────────────────────────────────

  /** The project's branch and commit, null when it is not in a git repository. */
  async head(cwd: string): Promise<AtpHead | null> {
    const branch = await this.exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
    if (branch === null) {
      // A repository without commits has no HEAD to name yet.
      const inside = await this.exec("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]).catch(() => "");
      return inside.trim() === "true" ? { sha: null, branch: "" } : null;
    }
    const sha = await this.exec("git", ["-C", cwd, "rev-parse", "--verify", "-q", "HEAD"]).catch(() => null);
    return { sha: sha?.trim() || null, branch: branch.trim() };
  }

  /**
   * After a node: when its worker did not commit (HEAD is where it was) but left changes, commit them as
   * `node(<id>): <title>`, like atp-runner. The librarian's lock files stay out.
   */
  async commit(cwd: string, node: string, title: string, before: AtpHead | null): Promise<AtpCommit> {
    const now = await this.head(cwd);
    if (!now || !before) return { kind: "no-repo" };
    if (now.sha !== before.sha) return { kind: "worker" };
    const status = await this.exec("git", ["-C", cwd, "status", "--porcelain", "--", "."]);
    if (!status.trim()) return { kind: "clean" };
    await this.exec("git", ["-C", cwd, "add", "-A", "--", ".", ":(exclude,glob)**/*.atp.json.lock"]);
    const subject = `node(${node}): ${title.replace(/\s+/g, " ").trim().slice(0, 72)}`;
    await this.exec("git", ["-C", cwd, "commit", "-q", "-m", subject]);
    const sha = (await this.exec("git", ["-C", cwd, "rev-parse", "HEAD"])).trim();
    log.info("atp", `committed ${sha.slice(0, 8)} ${subject}`);
    return { kind: "committed", sha };
  }

  // ── Hold ───────────────────────────────────────────────────────────────────

  heldPlans(): string[] {
    return [...this.held];
  }

  setHeld(plan: string, held: boolean): void {
    checkPlan(plan);
    if (this.held.has(plan) === held) return;
    if (held) this.held.add(plan);
    else this.held.delete(plan);
    this.pushHeld(this.heldPlans());
  }

  /** POST /atp: the orchestrator's atp_pause (waits until no worker holds a node) and atp_resume. */
  route(): Route {
    return async (_handle, body) => {
      const request = body as AtpBridgeRequest;
      if (!isPlanPath(request?.plan)) throw bridgeError(400, "plan must be the absolute path of an .atp.json file");
      if (!(await stat(request.plan).catch(() => undefined))) throw bridgeError(404, `no plan at ${request.plan}`);
      if (request.action === "resume") {
        this.setHeld(request.plan, false);
        return { text: "Resumed: pi-gna's runner claims nodes of this plan again (if the user started it)." };
      }
      if (request.action !== "pause") throw bridgeError(400, "action must be pause or resume");
      this.setHeld(request.plan, true);
      const until = Date.now() + PAUSE_WAIT;
      for (;;) {
        const working = workingNodes(await this.read(request.plan));
        if (!working.length) return { text: "Paused: no worker holds a node, and none is claimed until atp_resume. Change the plan now, then call atp_resume." };
        if (Date.now() > until || !this.held.has(request.plan)) {
          const nodes = working.map((node) => `${node.id} (${node.worker ?? "no agent"}): ${node.title}`).join("; ");
          return { text: `Paused, but workers still hold ${nodes}. No new node is claimed; call atp_pause again to keep waiting for them, or atp_resume.` };
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
  }
}

/** Plan paths come from the window and agents: an absolute `.atp.json`. */
function checkPlan(path: string): string {
  if (!isPlanPath(path)) throw new Error(`not an ATP plan path: ${String(path)}`);
  return path;
}
