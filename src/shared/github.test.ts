import { describe, expect, it } from "vitest";
import { parseItemInput, parseRemote, pickRemote } from "./github";

describe("parseRemote", () => {
  it("reads https, scp-like and ssh remotes", () => {
    expect(parseRemote("https://github.com/manuelcecchetto/pi-gna.git")).toEqual({ host: "github.com", repo: "manuelcecchetto/pi-gna" });
    expect(parseRemote("https://GitHub.com/CASUS-Tech/casus-review")).toEqual({ host: "github.com", repo: "CASUS-Tech/casus-review" });
    expect(parseRemote("https://user@github.com/a/b.c.git/")).toEqual({ host: "github.com", repo: "a/b.c" });
    expect(parseRemote("git@github.com:a/b.git")).toEqual({ host: "github.com", repo: "a/b" });
    expect(parseRemote("ssh://git@ghe.example.com:2222/team/tool.git")).toEqual({ host: "ghe.example.com", repo: "team/tool" });
  });

  it("leaves out what is not a repository URL", () => {
    for (const url of ["/Users/me/repo", "../repo", "file:///Users/me/a/b", "https://github.com/a", "https://github.com/a/b/c", ""]) expect(parseRemote(url)).toBeUndefined();
  });
});

describe("pickRemote", () => {
  const remote = (name: string, repo: string, resolved?: string) => ({ name, url: `https://github.com/${repo}.git`, resolved });

  it("prefers the remote gh repo set-default chose, then upstream, github and origin", () => {
    expect(pickRemote([remote("fork", "me/x"), remote("origin", "them/x")])?.repo).toBe("them/x");
    expect(pickRemote([remote("origin", "me/x"), remote("upstream", "them/x")])?.repo).toBe("them/x");
    expect(pickRemote([remote("upstream", "them/x"), remote("origin", "me/x", "base")])?.repo).toBe("me/x");
    expect(pickRemote([remote("fork", "me/x")])?.repo).toBe("me/x");
    expect(pickRemote([{ name: "origin", url: "/local/path" }])).toBeUndefined();
  });
});

describe("parseItemInput", () => {
  const repo = { host: "github.com", repo: "acme/tool" };

  it("takes a number or a link into the project's repository", () => {
    expect(parseItemInput(" #12 ", repo)).toEqual({ number: 12 });
    expect(parseItemInput("12", repo)).toEqual({ number: 12 });
    expect(parseItemInput("https://github.com/Acme/Tool/pull/34/files#diff", repo)).toEqual({ number: 34, kind: "pr" });
    expect(parseItemInput("https://github.com/acme/tool/issues/5", repo)).toEqual({ number: 5, kind: "issue" });
  });

  it("says what is wrong otherwise", () => {
    expect(() => parseItemInput("fix the bug", repo)).toThrow("Type an issue or pull request number");
    expect(() => parseItemInput("https://github.com/other/tool/issues/5", repo)).toThrow("That links into other/tool; this project's repository is acme/tool");
  });
});
