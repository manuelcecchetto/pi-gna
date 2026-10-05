// The ATP page's main side: the project's plans (`*.atp.json`), read and pushed to the window as they change; the
// bundled librarian CLI, which the runner claims and releases nodes with (plans are never written here); git around
// each node, for atp-runner's commit-per-node; and the hold an orchestrator puts on a plan while it changes it.
import { execFile } from "node:child_process";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
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
import { bridgeError, type Route } from "./bridge";
import { log } from "./log";
import { onDisk } from "./resources";

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

export class Atp {
  private project?: { cwd: string; watchers: Map<string, FSWatcher>; timer?: ReturnType<typeof setTimeout> };
  /** Plans an orchestrator paused (atp_pause): the runner claims no node of them. */
  private readonly held = new Set<string>();

  constructor(
    private readonly pushPlans: (plans: AtpProjectPlans) => void,
    private readonly pushHeld: (held: string[]) => void,
    private readonly exec: Run = run,
  ) {}

  // ── Plans ──────────────────────────────────────────────────────────────────

  /** The project's plans; they (and NEW_PLAN_DIR, where new plans go) are watched until another project is. */
  async watch(cwd: string | null): Promise<AtpProjectPlans | null> {
    this.unwatch();
    if (!cwd) return null;
    const project: NonNullable<Atp["project"]> = { cwd, watchers: new Map() };
    this.project = project;
    const plans = await this.scan(cwd);
    if (this.project === project) this.watchDirs(project, plans);
    return plans;
  }

  /**
   * Plans are replaced (the librarian writes a temp file and renames it), so their folders are watched, not the files.
   * So is NEW_PLAN_DIR, which the architect may create: each existing folder on the way to it rescans when the next
   * one appears, and the rescan watches that one.
   */
  private watchDirs(project: NonNullable<Atp["project"]>, plans: AtpProjectPlans): void {
    const chain = newPlanDirs(project.cwd);
    const next = new Map(chain.slice(0, -1).map((dir, i) => [dir, basename(chain[i + 1] as string)]));
    for (const dir of [...chain, ...plans.plans.map((plan) => dirname(plan.path))]) {
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
  }

  private unwatch(): void {
    if (!this.project) return;
    clearTimeout(this.project.timer);
    for (const watcher of this.project.watchers.values()) watcher.close();
    this.project = undefined;
  }

  private changed(project: NonNullable<Atp["project"]>): void {
    clearTimeout(project.timer);
    project.timer = setTimeout(() => {
      void this.scan(project.cwd).then((plans) => {
        if (this.project !== project) return;
        this.watchDirs(project, plans);
        this.pushPlans(plans);
      });
    }, 150);
  }

  /** Every `*.atp.json` under the project (rg: hidden and git-ignored files too, not dependencies or build output). */
  async scan(cwd: string): Promise<AtpProjectPlans> {
    const globs = SKIP_DIRS.flatMap((dir) => ["-g", `!${dir}`]);
    const stdout = await this.exec("rg", ["--files", "--hidden", "--no-ignore-vcs", "--max-depth", MAX_DEPTH, "-g", "*.atp.json", ...globs, cwd], { timeout: 15_000 }).catch(
      (error: Error & { code?: unknown }) => {
        // rg exits 1 when it finds nothing.
        if (error.code === 1 || !error.message) return "";
        log.warn("atp", `cannot look for plans in ${cwd}: ${error.message}`);
        return "";
      },
    );
    const paths = stdout.split("\n").filter(isPlanPath).sort();
    return { cwd, plans: await Promise.all(paths.map((path) => this.readFile(path))) };
  }

  private async readFile(path: string): Promise<AtpPlanFile> {
    try {
      const [info, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
      return { path, modifiedAt: info.mtimeMs, plan: parsePlan(path, JSON.parse(raw)) };
    } catch (error) {
      return { path, modifiedAt: 0, error: (error as Error).message };
    }
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
