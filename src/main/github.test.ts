import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyGithubSettings, emptyGithubSettings, type Exec, ExecError, Github, type GithubSettings, type GithubSettingsOp, GithubStore, ghEnv, scrub, type SettingsStore } from "./github";

const PROJECT = "/Users/me/Code/project";
const tokenOf = (login: string) => `gho_${login.replace(/[^A-Za-z0-9]/g, "")}${"x".repeat(30)}`;

interface World {
  remotes?: string;
  /** host -> accounts, in gh's order. */
  hosts?: Record<string, { login: string; active?: boolean }[]>;
  /** login -> repositories (owner/name) it can read. */
  reads?: Record<string, string[]>;
  /** login -> organizations. */
  orgs?: Record<string, string[]>;
  /** gh is not installed. */
  noGh?: boolean;
  /** issue/pr list fails like this, with the caller's token in the text. */
  listError?: (token: string) => string;
}

/** A fake git and gh: accounts, what each can read, and every call with its environment. */
function fake(world: World) {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const loginOf = (env: NodeJS.ProcessEnv) => {
    const token = env.GH_TOKEN ?? env.GH_ENTERPRISE_TOKEN;
    return Object.values(world.hosts ?? {})
      .flat()
      .find((account) => tokenOf(account.login) === token)?.login;
  };
  const exec: Exec = async (file, args, { env }) => {
    calls.push({ file, args, env });
    if (file === "git") {
      if (!world.remotes) throw new ExecError("", "git");
      return world.remotes;
    }
    if (world.noGh) throw new ExecError("spawn gh ENOENT", "gh", "", true);
    const [command, sub] = args;
    if (command === "auth" && sub === "status") return JSON.stringify({ hosts: world.hosts ?? {} });
    if (command === "auth" && sub === "token") {
      const login = args[args.indexOf("--user") + 1] ?? "";
      if (!Object.values(world.hosts ?? {}).flat().some((account) => account.login === login)) throw new ExecError(`no oauth token found for github.com account ${login}`, "gh");
      return `${tokenOf(login)}\n`;
    }
    const login = loginOf(env);
    if (!login) throw new ExecError("gh: Bad credentials (HTTP 401)", "gh");
    if (command === "api") {
      const path = args.find((arg) => arg.startsWith("repos/") || arg === "user/orgs") ?? "";
      if (path === "user/orgs") return (world.orgs?.[login] ?? []).join("\n");
      const repo = path.replace(/^repos\//, "").split("/").slice(0, 2).join("/");
      if (!world.reads?.[login]?.includes(repo)) throw new ExecError("gh: Not Found (HTTP 404)", "gh", '{"message":"Not Found"}');
      if (path.includes("/issues/")) return JSON.stringify({ title: "Crash on start", url: `https://github.com/${repo}/issues/7`, pr: false });
      return repo;
    }
    if (sub === "list") {
      const repo = (args[args.indexOf("--repo") + 1] ?? "").split("/").slice(1).join("/");
      if (world.listError) throw new ExecError(world.listError(tokenOf(login)), "gh");
      if (!world.reads?.[login]?.includes(repo)) throw new ExecError(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`, "gh");
      return JSON.stringify([{ number: 3, title: `seen by ${login}`, state: command === "pr" ? "MERGED" : "OPEN", author: { login }, labels: [{ name: "bug", color: "d73a4a", id: "x" }], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", url: `https://github.com/${repo}/issues/3`, body: "Body", isDraft: false, headRefName: "fix", baseRefName: "main", reviewDecision: "APPROVED" }]);
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { exec, calls };
}

/** Settings in memory. */
function memory(initial: GithubSettings = emptyGithubSettings()): SettingsStore & { value: GithubSettings } {
  const store = {
    value: initial,
    get: async () => store.value,
    apply: async (op: GithubSettingsOp) => {
      store.value = applyGithubSettings(store.value, op);
      return store.value;
    },
  };
  return store;
}

const origin = (url: string) => `remote.origin.url ${url}\n`;
const WORK = "ManuelCasus";
const PERSONAL = "manuelcecchetto";
// The work account is the active one: a repository it can read must still go to the account that owns it.
const accounts = { "github.com": [{ login: WORK, active: true }, { login: PERSONAL }] };
const reads = { [WORK]: ["CASUS-Tech/casus-review", "manuelcecchetto/pi-gna", "acme/tool"], [PERSONAL]: ["manuelcecchetto/pi-gna", "acme/secret"] };
const orgs = { [WORK]: ["CASUS-Tech"], [PERSONAL]: ["OktyAI"] };
const ghCalls = (calls: ReturnType<typeof fake>["calls"]) => calls.filter((call) => call.file === "gh" && call.args[0] !== "auth");

describe("Github account resolution", () => {
  it("uses the work account for a repository of its organization", async () => {
    const { exec, calls } = fake({ remotes: origin("https://github.com/CASUS-Tech/casus-review.git"), hosts: { "github.com": [{ login: PERSONAL, active: true }, { login: WORK }] }, reads, orgs });
    const github = new Github(memory(), exec, () => ({}));
    expect(await github.project(PROJECT)).toEqual({ repo: { host: "github.com", repo: "CASUS-Tech/casus-review" }, account: { login: WORK, reason: "member" }, accounts: [PERSONAL, WORK], chosen: undefined });
    const list = await github.list(PROJECT, "issue", "open");
    expect(list.problem).toBeUndefined();
    expect(list).toMatchObject({ items: [{ number: 3, title: `seen by ${WORK}`, state: "open", labels: [{ name: "bug", color: "d73a4a" }] }], more: false });
    expect(ghCalls(calls).at(-1)?.args.slice(0, 4)).toEqual(["issue", "list", "--repo", "github.com/CASUS-Tech/casus-review"]);
  });

  it("uses the personal account for its own public repository even while the work account is active", async () => {
    const { exec } = fake({ remotes: origin("git@github.com:manuelcecchetto/pi-gna.git"), hosts: accounts, reads, orgs });
    const github = new Github(memory(), exec, () => ({}));
    expect((await github.project(PROJECT)).account).toEqual({ login: PERSONAL, reason: "owner" });
    const list = await github.list(PROJECT, "pr", "closed");
    expect(list).toMatchObject({ items: [{ title: `seen by ${PERSONAL}`, state: "merged", draft: false, head: "fix", base: "main", review: "approved" }] });
  });

  it("tries the next account when one gets a 404", async () => {
    const { exec, calls } = fake({ remotes: origin("https://github.com/acme/secret"), hosts: accounts, reads, orgs });
    const github = new Github(memory(), exec, () => ({}));
    expect((await github.project(PROJECT)).account).toEqual({ login: PERSONAL, reason: "access" });
    const probes = ghCalls(calls).filter((call) => call.args.includes("repos/acme/secret"));
    expect(probes.map((call) => call.env.GH_TOKEN)).toEqual([tokenOf(WORK), tokenOf(PERSONAL)]);
  });

  it("uses the account you chose for the project, and the saved one without asking GitHub again", async () => {
    const { exec, calls } = fake({ remotes: origin("https://github.com/manuelcecchetto/pi-gna"), hosts: accounts, reads, orgs });
    const store = memory();
    const github = new Github(store, exec, () => ({}));
    expect((await github.choose(PROJECT, WORK)).account).toEqual({ login: WORK, reason: "chosen" });
    expect(store.value.chosen).toEqual({ [PROJECT]: WORK });
    expect(ghCalls(calls)).toEqual([]);
    const list = await github.list(PROJECT, "issue", "open");
    expect(list).toMatchObject({ items: [{ title: `seen by ${WORK}` }] });
    // Back to automatic: the owner's account, remembered for the repository.
    expect((await github.choose(PROJECT, null)).account).toEqual({ login: PERSONAL, reason: "owner" });
    expect(store.value).toEqual({ version: 1, chosen: {}, saved: { "github.com/manuelcecchetto/pi-gna": PERSONAL } });
    const fresh = fake({ remotes: origin("https://github.com/manuelcecchetto/pi-gna"), hosts: accounts, reads, orgs });
    expect((await new Github(store, fresh.exec, () => ({})).project(PROJECT)).account).toEqual({ login: PERSONAL, reason: "saved" });
    expect(ghCalls(fresh.calls)).toEqual([]);
  });

  it("refuses to choose an account gh is not logged in to", async () => {
    const { exec } = fake({ remotes: origin("https://github.com/manuelcecchetto/pi-gna"), hosts: accounts, reads, orgs });
    const store = memory();
    const result = await new Github(store, exec, () => ({})).choose(PROJECT, "someone");
    expect(result.problem).toEqual({ kind: "no-login", message: "gh is not logged in to github.com as someone" });
    expect(store.value.chosen).toEqual({});
  });

  it("drops a saved or chosen account that was logged out, and picks again", async () => {
    const { exec } = fake({ remotes: origin("https://github.com/CASUS-Tech/casus-review"), hosts: accounts, reads, orgs });
    const store = memory({ version: 1, chosen: { [PROJECT]: "gone" }, saved: { "github.com/casus-tech/casus-review": "gone-too" } });
    expect((await new Github(store, exec, () => ({})).project(PROJECT)).account).toEqual({ login: WORK, reason: "member" });
    expect(store.value).toEqual({ version: 1, chosen: {}, saved: { "github.com/casus-tech/casus-review": WORK } });
  });

  it("picks again when the saved account lost access to the repository", async () => {
    const { exec } = fake({ remotes: origin("https://github.com/acme/secret"), hosts: accounts, reads, orgs });
    const store = memory({ version: 1, chosen: {}, saved: { "github.com/acme/secret": WORK } });
    const list = await new Github(store, exec, () => ({})).list(PROJECT, "issue", "open");
    expect(list).toMatchObject({ items: [{ title: `seen by ${PERSONAL}` }] });
    expect(store.value.saved).toEqual({ "github.com/acme/secret": PERSONAL });
  });

  it("says so when no account can read the repository", async () => {
    const { exec } = fake({ remotes: origin("https://github.com/someone/private"), hosts: accounts, reads, orgs });
    const result = await new Github(memory(), exec, () => ({})).project(PROJECT);
    expect(result.problem).toEqual({
      kind: "no-access",
      message: "None of your gh accounts (ManuelCasus, manuelcecchetto) can read someone/private. Log in to one that can with `gh auth login` in a terminal, then refresh.",
    });
    expect(result.repo).toEqual({ host: "github.com", repo: "someone/private" });
  });

  it("explains a missing gh, a missing remote and a host gh is not logged in to", async () => {
    expect((await new Github(memory(), fake({ remotes: origin("https://github.com/a/b"), noGh: true }).exec, () => ({})).project(PROJECT)).problem?.kind).toBe("no-gh");
    expect((await new Github(memory(), fake({ hosts: accounts }).exec, () => ({})).project(PROJECT)).problem?.kind).toBe("no-repo");
    expect((await new Github(memory(), fake({ remotes: origin("https://gitlab.com/a/b"), hosts: accounts }).exec, () => ({})).list(PROJECT, "issue", "open")).problem).toEqual({
      kind: "no-login",
      message: "gh is not logged in to gitlab.com. If it is a GitHub Enterprise host, run `gh auth login --hostname gitlab.com` in a terminal, then refresh.",
    });
  });

  it("never passes an inherited token on, and gives an enterprise host its own variable", async () => {
    const inherited = { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_inheritedinheritedinherited00", GH_TOKEN: "ghp_alsoinheritedalsoinherited000", GH_ENTERPRISE_TOKEN: "x", GH_REPO: "other/repo" };
    const { exec, calls } = fake({ remotes: origin("https://github.com/CASUS-Tech/casus-review"), hosts: accounts, reads, orgs });
    await new Github(memory(), exec, () => inherited).list(PROJECT, "issue", "open");
    for (const call of calls.filter((call) => call.file === "gh")) {
      expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(call.env.GH_REPO).toBeUndefined();
      expect(call.env.PATH).toBe("/usr/bin");
      // gh's own auth commands read the keyring: no token at all. Everything else runs as one of your accounts.
      if (call.args[0] === "auth") expect(call.env.GH_TOKEN).toBeUndefined();
      else expect([tokenOf(WORK), tokenOf(PERSONAL)]).toContain(call.env.GH_TOKEN);
    }
    expect(calls.find((call) => call.args[1] === "list")?.env.GH_TOKEN).toBe(tokenOf(WORK));
    expect(ghEnv(inherited, "ghe.example.com", "t")).toMatchObject({ GH_ENTERPRISE_TOKEN: "t", GH_PROMPT_DISABLED: "1" });
    expect(ghEnv(inherited, "ghe.example.com", "t").GH_TOKEN).toBeUndefined();
  });

  it("keeps tokens out of errors", async () => {
    const { exec } = fake({ remotes: origin("https://github.com/CASUS-Tech/casus-review"), hosts: accounts, reads, orgs, listError: (token) => `HTTP 502 for Authorization: token ${token}` });
    const list = await new Github(memory(), exec, () => ({})).list(PROJECT, "issue", "open");
    expect(list.problem?.kind).toBe("failed");
    expect(list.problem?.message).toBe("HTTP 502 for Authorization: token ***");
    expect(scrub("a github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz and ghs_abcdefghijklmnopqrstuvwxyz", [])).toBe("a *** and ***");
  });

  it("asks gh for a token again when GitHub refuses it", async () => {
    const { exec: base, calls } = fake({ remotes: origin("https://github.com/CASUS-Tech/casus-review"), hosts: accounts, reads, orgs });
    let refused = false;
    const exec: Exec = (file, args, options) => {
      if (!refused && args[1] === "list") {
        refused = true;
        return Promise.reject(new ExecError("gh: Bad credentials (HTTP 401)", "gh"));
      }
      return base(file, args, options);
    };
    const list = await new Github(memory(), exec, () => ({})).list(PROJECT, "issue", "open");
    expect(list.problem).toBeUndefined();
    expect(calls.filter((call) => call.args[0] === "auth" && call.args[1] === "token" && call.args.includes(WORK))).toHaveLength(2);
  });

  it("resolves once when the issues and pull requests are asked for together", async () => {
    const { exec, calls } = fake({ remotes: origin("https://github.com/CASUS-Tech/casus-review"), hosts: accounts, reads, orgs });
    const github = new Github(memory(), exec, () => ({}));
    await Promise.all([github.list(PROJECT, "issue", "open"), github.list(PROJECT, "pr", "open")]);
    expect(calls.filter((call) => call.args.includes("repos/CASUS-Tech/casus-review"))).toHaveLength(1);
    expect(calls.filter((call) => call.args[0] === "auth" && call.args[1] === "status")).toHaveLength(1);
  });

  it("looks up an issue or pull request of the project's repository by number or link", async () => {
    const { exec } = fake({ remotes: origin("https://github.com/acme/tool"), hosts: accounts, reads, orgs });
    const github = new Github(memory(), exec, () => ({}));
    expect(await github.lookup(PROJECT, "#7")).toEqual({ ref: { kind: "issue", host: "github.com", repo: "acme/tool", number: 7, url: "https://github.com/acme/tool/issues/7", title: "Crash on start" } });
    expect((await github.lookup(PROJECT, "https://github.com/other/repo/issues/7")).problem?.message).toBe("That links into other/repo; this project's repository is acme/tool");
  });
});

describe("GitHub settings", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pigna-github-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves logins only, and checks what it is given", async () => {
    const file = join(root, "github.json");
    const store = new GithubStore(file);
    await store.apply({ type: "choose", project: PROJECT, login: WORK });
    await store.apply({ type: "save", repo: "github.com/a/b", login: PERSONAL });
    await store.flushed();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ rev: 2, version: 1, chosen: { [PROJECT]: WORK }, saved: { "github.com/a/b": PERSONAL } });
    expect(await new GithubStore(file).get()).toEqual({ rev: 2, version: 1, chosen: { [PROJECT]: WORK }, saved: { "github.com/a/b": PERSONAL } });
    expect(() => applyGithubSettings(emptyGithubSettings(), { type: "choose", project: "relative", login: WORK })).toThrow("invalid project");
    expect(() => applyGithubSettings(emptyGithubSettings(), { type: "save", repo: "github.com/a/b", login: "not a login" })).toThrow("invalid GitHub login");
  });
});
