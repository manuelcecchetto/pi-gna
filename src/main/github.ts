// The GitHub page: a project's issues and pull requests through the GitHub CLI (gh), as the gh account that can
// read its repository. gh can be logged in to several accounts per host (say a work and a personal one) but has one
// active account, shared with your terminals and agents, so pi-gna never switches it: every call gets its account's
// token in GH_TOKEN (gh prefers it to the keyring), and tokens stay in this process, in memory, out of logs and errors.
import { execFile } from "node:child_process";
import { githubRef, projectOf } from "../shared/board";
import {
  type AccountReason,
  GITHUB_LIST_LIMIT,
  type GithubFilter,
  type GithubItem,
  type GithubKind,
  type GithubList,
  type GithubLookup,
  type GithubProblem,
  type GithubProject,
  type GithubRepo,
  parseItemInput,
  pickRemote,
  type Remote,
  tokenVariable,
} from "../shared/github";
import { log } from "./log";
import { JsonStore } from "./store";

/** Runs git or gh and resolves with its stdout; rejects with an ExecError. */
export type Exec = (file: "git" | "gh", args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<string>;

export class ExecError extends Error {
  constructor(
    message: string,
    readonly file: "git" | "gh",
    readonly stdout = "",
    /** The program is not installed (or not on PATH). */
    readonly missing = false,
  ) {
    super(message);
  }
}

const execTool: Exec = (file, args, { env }) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(new ExecError(stderr.trim() || error.message, file, stdout, missing));
    }),
  );

/** Something in the way that the page explains (no remote, no account that can read the repository). */
class Problem extends Error {
  constructor(
    readonly kind: GithubProblem["kind"],
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

/**
 * gh's environment: none of the inherited tokens (one would win over the account's), repository or debug output, no
 * prompts; `token` as the variable gh reads for `host` (GH_TOKEN for github.com and GHE.com, else the enterprise one).
 */
export function ghEnv(base: NodeJS.ProcessEnv, host: string, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  for (const name of [...TOKEN_VARIABLES, "GH_HOST", "GH_REPO", "GH_DEBUG", "DEBUG"]) delete env[name];
  if (token) env[tokenVariable(host)] = token;
  return env;
}

const TOKEN_PATTERN = /\b(?:gh[opsur]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;

/** Text that may leave this process (an error, a log line), with every token we know and anything shaped like one masked. */
export function scrub(text: string, tokens: Iterable<string>): string {
  let clean = text;
  for (const token of tokens) if (token) clean = clean.split(token).join("***");
  return clean.replace(TOKEN_PATTERN, "***");
}

// ── Settings: the account you chose per project, and the one that worked per repository ──────────────────────────

export interface GithubSettings {
  version: 1;
  /** Project folder -> the login you chose for it. */
  chosen: Record<string, string>;
  /** Repository ("host/owner/name", lowercase) -> the login that could read it last time. */
  saved: Record<string, string>;
}

export type GithubSettingsOp = { type: "choose"; project: string; login: string | null } | { type: "save"; repo: string; login: string | null };

const LOGIN = /^[A-Za-z0-9][\w-]{0,63}$/;

export const emptyGithubSettings = (): GithubSettings => ({ version: 1, chosen: {}, saved: {} });

/** Set or clear (null) a project's chosen or a repository's saved login. */
export function applyGithubSettings(settings: GithubSettings, op: GithubSettingsOp): GithubSettings {
  const field = op.type === "choose" ? "chosen" : "saved";
  const key = op.type === "choose" ? op.project : op.repo;
  if (typeof key !== "string" || !key || (op.type === "choose" && !key.startsWith("/"))) throw new Error(`invalid ${op.type === "choose" ? "project" : "repository"} ${String(key)}`);
  if (op.login !== null && (typeof op.login !== "string" || !LOGIN.test(op.login))) throw new Error(`invalid GitHub login ${String(op.login)}`);
  if ((settings[field][key] ?? null) === op.login) return settings;
  const { [key]: _previous, ...rest } = settings[field];
  return { ...settings, [field]: op.login === null ? rest : { ...rest, [key]: op.login } };
}

export function parseGithubSettings(raw: unknown): { value: GithubSettings; dropped: number } {
  const value = raw as Partial<GithubSettings> | null;
  if (typeof value?.chosen !== "object" || typeof value.saved !== "object" || !value.chosen || !value.saved) throw new Error("not GitHub settings");
  let dropped = 0;
  const logins = (record: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(record).filter(([, login]) => {
        const ok = typeof login === "string" && LOGIN.test(login);
        if (!ok) dropped++;
        return ok;
      }),
    ) as Record<string, string>;
  return { value: { version: 1, chosen: logins(value.chosen), saved: logins(value.saved) }, dropped };
}

/** userData/github.json. Logins only: tokens are never written anywhere. */
export class GithubStore extends JsonStore<GithubSettings, GithubSettingsOp> {
  constructor(file: string) {
    super(file, { name: "github", item: "account", empty: emptyGithubSettings, apply: (value, op) => applyGithubSettings(value, op), parse: parseGithubSettings }, () => undefined);
  }
}

/** What the account resolver reads and writes, so tests can use a plain object. */
export interface SettingsStore {
  get(): Promise<GithubSettings>;
  apply(op: GithubSettingsOp): Promise<GithubSettings>;
}

// ── gh ───────────────────────────────────────────────────────────────────────

const ACCOUNTS_TTL = 10 * 60_000;
const BODY = 20_000;
const ISSUE_FIELDS = ["number", "title", "state", "author", "labels", "createdAt", "updatedAt", "url", "body"];
const PR_FIELDS = [...ISSUE_FIELDS, "isDraft", "headRefName", "baseRefName", "reviewDecision"];

interface Account {
  login: string;
  reason: AccountReason;
}

const repoKey = (repo: GithubRepo) => `${repo.host}/${repo.repo}`.toLowerCase();

/** gh's HTTP status in an error ("gh: Not Found (HTTP 404)"). */
const httpStatus = (error: unknown): number | undefined => {
  const match = error instanceof ExecError ? error.message.match(/\(HTTP (\d{3})\)/) : null;
  return match ? Number(match[1]) : undefined;
};
const unauthorized = (error: unknown) => httpStatus(error) === 401 || (error instanceof ExecError && /Bad credentials/i.test(error.message));
/** The account cannot see the repository: GitHub answers as if it did not exist. */
const unreadable = (error: unknown) => error instanceof ExecError && /Could not resolve to a Repository/i.test(error.message);

export class Github {
  private accounts?: { at: number; hosts: Promise<Record<string, string[]>> };
  private readonly tokens = new Map<string, Promise<string>>();
  /** Every token read, to mask them in what leaves this process. */
  private readonly secrets = new Set<string>();
  private readonly orgs = new Map<string, Promise<Set<string>>>();
  private readonly resolving = new Map<string, Promise<Account>>();

  constructor(
    private readonly store: SettingsStore,
    private readonly exec: Exec = execTool,
    /** The environment gh starts from: read per call, since a Finder launch imports the shell's after startup. */
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
    private readonly now: () => number = Date.now,
  ) {}

  /** The project's repository and its account. `refresh` asks gh for its accounts again (after a `gh auth login`). */
  async project(cwd: string, refresh = false): Promise<GithubProject> {
    if (refresh) this.forget();
    const project = projectOf(cwd);
    let repo: GithubRepo | undefined;
    let accounts: string[] = [];
    try {
      repo = await this.repoOf(project);
      accounts = await this.logins(repo.host);
      const account = await this.account(project, repo);
      return { repo, account, accounts, chosen: (await this.store.get()).chosen[project] };
    } catch (error) {
      return { repo, accounts, chosen: (await this.store.get()).chosen[project], problem: this.problem(error) };
    }
  }

  /** Use `login` for the project's repository from now on, or let pi-gna pick again (null). */
  async choose(cwd: string, login: string | null): Promise<GithubProject> {
    const project = projectOf(cwd);
    try {
      if (login !== null) {
        const repo = await this.repoOf(project);
        if (!(await this.logins(repo.host)).includes(login)) throw new Problem("no-login", `gh is not logged in to ${repo.host} as ${login}`);
      }
      await this.store.apply({ type: "choose", project, login });
    } catch (error) {
      return { accounts: [], problem: this.problem(error) };
    }
    return this.project(project);
  }

  /** The project's open or closed issues or pull requests (closed ones include merged), newest first. */
  async list(cwd: string, kind: GithubKind, filter: GithubFilter): Promise<GithubList> {
    try {
      const fields = (kind === "pr" ? PR_FIELDS : ISSUE_FIELDS).join(",");
      const limit = String(GITHUB_LIST_LIMIT + 1);
      const stdout = await this.gh(projectOf(cwd), (repo) => [kind, "list", "--repo", `${repo.host}/${repo.repo}`, "--state", filter, "--limit", limit, "--json", fields]);
      const items = (JSON.parse(stdout) as RawItem[]).map((raw) => toItem(kind, raw));
      return { items: items.slice(0, GITHUB_LIST_LIMIT), more: items.length > GITHUB_LIST_LIMIT };
    } catch (error) {
      return { problem: this.problem(error) };
    }
  }

  /** An issue or pull request of the project's repository, from "#12" or its link, as a card's GitHub link. */
  async lookup(cwd: string, input: string): Promise<GithubLookup> {
    const project = projectOf(cwd);
    try {
      const repo = await this.repoOf(project);
      let number: number;
      try {
        number = parseItemInput(input, repo).number;
      } catch (error) {
        throw new Problem("failed", (error as Error).message);
      }
      const path = `repos/${repo.repo}/issues/${number}`;
      const stdout = await this.gh(project, () => ["api", "--hostname", repo.host, path, "--jq", "{title, url: .html_url, pr: (.pull_request != null)}"]).catch((error) => {
        if (httpStatus(error) === 404 || httpStatus(error) === 410) throw new Problem("failed", `${repo.repo} has no issue or pull request #${number}`);
        throw error;
      });
      const found = JSON.parse(stdout) as { title: string; url: string; pr: boolean };
      return { ref: githubRef({ kind: found.pr ? "pr" : "issue", host: repo.host, repo: repo.repo, number, url: found.url, title: found.title }) };
    } catch (error) {
      return { problem: this.problem(error) };
    }
  }

  /** Ask gh for its accounts, organizations and tokens again. */
  private forget(): void {
    this.accounts = undefined;
    this.orgs.clear();
    this.tokens.clear();
  }

  /** The repository gh would use in the project: its remotes, the one `gh repo set-default` chose first. */
  private async repoOf(project: string): Promise<GithubRepo> {
    // Exits 1 when there is no remote (or no repository).
    const config = await this.exec("git", ["-C", project, "config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], { env: { ...this.env(), LC_ALL: "C" } }).catch(
      (error: ExecError) => {
        if (error.missing) throw error;
        return "";
      },
    );
    const remotes = new Map<string, Remote>();
    for (const line of config.split("\n")) {
      const match = line.match(/^remote\.(.+)\.(url|gh-resolved) (.*)$/);
      if (!match?.[1] || match[3] === undefined) continue;
      const remote = remotes.get(match[1]) ?? { name: match[1], url: "" };
      if (match[2] === "url") remote.url ||= match[3];
      else remote.resolved = match[3];
      remotes.set(match[1], remote);
    }
    const repo = pickRemote([...remotes.values()]);
    if (!repo) throw new Problem("no-repo", `${project} has no GitHub remote: it is not a git repository, or none of its remotes is on GitHub.`);
    return repo;
  }

  /** gh's logged-in accounts on `host`, the active one first. */
  private async logins(host: string): Promise<string[]> {
    if (!this.accounts || this.now() - this.accounts.at > ACCOUNTS_TTL) {
      // Exits 1 when an account's token is invalid, after printing every account.
      const hosts = this.exec("gh", ["auth", "status", "--json", "hosts"], { env: ghEnv(this.env(), host) })
        .catch((error: ExecError) => {
          if (error.stdout.trim().startsWith("{")) return error.stdout;
          throw error;
        })
        .then(parseAccounts);
      const entry = { at: this.now(), hosts };
      this.accounts = entry;
      hosts.catch(() => {
        if (this.accounts === entry) this.accounts = undefined;
      });
    }
    const logins = (await this.accounts.hosts)[host] ?? [];
    if (!logins.length) {
      throw new Problem(
        "no-login",
        host === "github.com"
          ? "gh is not logged in to github.com. Run `gh auth login` in a terminal, then refresh."
          : `gh is not logged in to ${host}. If it is a GitHub Enterprise host, run \`gh auth login --hostname ${host}\` in a terminal, then refresh.`,
      );
    }
    return logins;
  }

  /** The account for the project's repository; one resolution at a time per project. */
  private account(project: string, repo: GithubRepo): Promise<Account> {
    const key = `${project}\n${repoKey(repo)}`;
    let pending = this.resolving.get(key);
    if (!pending) {
      pending = this.resolve(project, repo).finally(() => this.resolving.delete(key));
      this.resolving.set(key, pending);
    }
    return pending;
  }

  /**
   * The first that applies: the account you chose for the project, the one that read the repository last time, then
   * the first that can read it (a 404 means it cannot), trying the account named like the owner first, then members of
   * the owner organization, then the rest, the active one first. A public repository is readable by every account,
   * but what you do there is done as the account, so the owner's comes before the active one.
   */
  private async resolve(project: string, repo: GithubRepo): Promise<Account> {
    const logins = await this.logins(repo.host);
    const settings = await this.store.get();
    const key = repoKey(repo);
    const chosen = settings.chosen[project];
    if (chosen && logins.includes(chosen)) return { login: chosen, reason: "chosen" };
    if (chosen) {
      log.warn("github", `${chosen}, chosen for ${project}, is no longer logged in to ${repo.host}; picking another account`);
      await this.store.apply({ type: "choose", project, login: null });
    }
    const saved = settings.saved[key];
    if (saved && logins.includes(saved)) return { login: saved, reason: "saved" };
    if (saved) await this.store.apply({ type: "save", repo: key, login: null });

    const owner = repo.repo.split("/")[0]?.toLowerCase();
    const owners = logins.filter((login) => login.toLowerCase() === owner);
    const tried = new Set<string>();
    const attempt = async (candidates: string[], reason: AccountReason): Promise<Account | undefined> => {
      for (const login of candidates) {
        if (tried.has(login)) continue;
        tried.add(login);
        if (!(await this.canRead(repo, login))) continue;
        await this.store.apply({ type: "save", repo: key, login });
        log.info("github", `${key} uses ${login}: ${reason}`);
        return { login, reason };
      }
      return undefined;
    };
    const found = await attempt(owners, "owner");
    if (found) return found;
    const others = logins.filter((login) => !owners.includes(login));
    const orgs = await Promise.all(others.map((login) => this.memberOf(repo.host, login)));
    const members = others.filter((_login, index) => owner !== undefined && orgs[index]?.has(owner));
    const account = (await attempt(members, "member")) ?? (await attempt(others, "access"));
    if (account) return account;
    const login = `gh auth login${repo.host === "github.com" ? "" : ` --hostname ${repo.host}`}`;
    throw new Problem("no-access", `None of your gh accounts (${logins.join(", ")}) can read ${repo.repo}. Log in to one that can with \`${login}\` in a terminal, then refresh.`);
  }

  /** Whether `login` can read the repository: GitHub answers 404 for a private one it cannot see. */
  private async canRead(repo: GithubRepo, login: string): Promise<boolean> {
    try {
      await this.as(repo.host, login, ["api", "--hostname", repo.host, `repos/${repo.repo}`, "--jq", ".full_name"]);
      return true;
    } catch (error) {
      const status = httpStatus(error);
      if (status === 401 || status === 403 || status === 404) return false;
      throw error;
    }
  }

  /** The organizations `login` belongs to, lowercase; none when gh cannot tell. */
  private memberOf(host: string, login: string): Promise<Set<string>> {
    const key = `${host} ${login}`;
    let orgs = this.orgs.get(key);
    if (!orgs) {
      orgs = this.as(host, login, ["api", "--hostname", host, "user/orgs", "--paginate", "--jq", ".[].login"]).then(
        (stdout) => new Set(stdout.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean)),
        () => new Set<string>(),
      );
      this.orgs.set(key, orgs);
    }
    return orgs;
  }

  /** Run gh on the project's repository as its account. When the saved account lost access, pick again once. */
  private async gh(project: string, args: (repo: GithubRepo) => string[]): Promise<string> {
    const repo = await this.repoOf(project);
    const account = await this.account(project, repo);
    try {
      return await this.as(repo.host, account.login, args(repo));
    } catch (error) {
      if (!unreadable(error)) throw error;
      if (account.reason === "chosen") {
        throw new Problem("no-access", `${account.login}, the account chosen for this project, cannot read ${repo.repo}. Choose another account.`);
      }
      await this.store.apply({ type: "save", repo: repoKey(repo), login: null });
      const next = await this.account(project, repo);
      return await this.as(repo.host, next.login, args(repo));
    }
  }

  /** Run gh as `login`, with its token in the environment; a token GitHub refuses is read from gh again, once. */
  private async as(host: string, login: string, args: string[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(host, login);
      try {
        return await this.exec("gh", args, { env: ghEnv(this.env(), host, token) });
      } catch (error) {
        if (attempt > 0 || !unauthorized(error)) throw error;
        this.tokens.delete(`${host} ${login}`);
      }
    }
  }

  private token(host: string, login: string): Promise<string> {
    const key = `${host} ${login}`;
    let token = this.tokens.get(key);
    if (!token) {
      token = this.exec("gh", ["auth", "token", "--hostname", host, "--user", login], { env: ghEnv(this.env(), host) }).then((stdout) => {
        const value = stdout.trim();
        if (!value) throw new Problem("no-login", `gh has no token for ${login} on ${host}`);
        this.secrets.add(value);
        return value;
      });
      const pending = token;
      this.tokens.set(key, pending);
      pending.catch(() => {
        if (this.tokens.get(key) === pending) this.tokens.delete(key);
      });
    }
    return token;
  }

  private problem(error: unknown): GithubProblem {
    if (error instanceof Problem) return { kind: error.kind, message: error.message };
    if (error instanceof ExecError && error.missing) {
      return error.file === "gh"
        ? { kind: "no-gh", message: "pi-gna reads issues and pull requests with the GitHub CLI, gh, which is not installed or not on your PATH. Install it (brew install gh), log in with `gh auth login`, then refresh." }
        : { kind: "failed", message: "git is not installed or not on your PATH." };
    }
    const message = scrub(error instanceof Error ? error.message : String(error), this.secrets);
    log.warn("github", message);
    return { kind: "failed", message };
  }
}

/** `gh auth status --json hosts`: each host's logins, the active one first. */
function parseAccounts(stdout: string): Record<string, string[]> {
  const hosts = (JSON.parse(stdout) as { hosts?: Record<string, { login?: string; active?: boolean }[]> }).hosts ?? {};
  return Object.fromEntries(
    Object.entries(hosts).map(([host, accounts]) => {
      const logins = [...accounts].sort((a, b) => Number(b.active === true) - Number(a.active === true)).flatMap((account) => (typeof account.login === "string" && LOGIN.test(account.login) ? [account.login] : []));
      return [host.toLowerCase(), [...new Set(logins)]];
    }),
  );
}

interface RawItem {
  number: number;
  title: string;
  state: string;
  author?: { login?: string } | null;
  labels?: { name: string; color: string }[];
  createdAt: string;
  updatedAt: string;
  url: string;
  body?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string;
}

function toItem(kind: GithubKind, raw: RawItem): GithubItem {
  const body = raw.body ?? "";
  const item: GithubItem = {
    kind,
    number: raw.number,
    title: raw.title,
    state: raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open",
    author: raw.author?.login || "ghost",
    labels: (raw.labels ?? []).map(({ name, color }) => ({ name, color })),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    url: raw.url,
    body: body.length > BODY ? `${body.slice(0, BODY)}…` : body,
  };
  if (kind === "pr") {
    item.draft = raw.isDraft === true;
    item.head = raw.headRefName;
    item.base = raw.baseRefName;
    const review = raw.reviewDecision?.toLowerCase();
    if (review === "approved" || review === "changes_requested" || review === "review_required") item.review = review;
  }
  return item;
}
