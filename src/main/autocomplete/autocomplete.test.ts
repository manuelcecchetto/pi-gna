import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AutocompleteStatus } from "../../shared/autocomplete";
import { sessionFolder } from "../chat-import/session";
import type { Download, ServerBuild } from "./assets";
import { serverBuilds } from "./assets";
import { PromptHistory, userText } from "./history";
import { Autocomplete } from "./index";
import { type Fetch, fetchVerified } from "./install";

const root = mkdtempSync(join(tmpdir(), "pigna-autocomplete-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** A fetch over in-memory files, counting requests per URL. */
function memoryFetch(files: Record<string, Buffer>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const bytes = files[url];
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404, statusText: "Not Found" });
  };
  return Object.assign(fetch, { calls });
}

const line = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content } });
const PROMPT = "the composer scroll jumps when a long task streams";

describe("fetchVerified", () => {
  const bytes = Buffer.from("model weights");
  const download: Download = { url: "https://example.test/model.gguf", size: bytes.length, sha256: sha(bytes) };

  it("refuses a file that does not match its checksum and leaves nothing behind", async () => {
    const path = join(root, "bad", "model.gguf");
    const fetch = memoryFetch({ [download.url]: Buffer.from("other weights") });
    await expect(fetchVerified(fetch, { ...download, size: 13 }, path, () => undefined)).rejects.toThrow("checksum");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("downloads once, then trusts the verified file", async () => {
    const path = join(root, "good", "model.gguf");
    const fetch = memoryFetch({ [download.url]: bytes });
    let received = 0;
    await fetchVerified(fetch, download, path, (n) => (received += n));
    await fetchVerified(fetch, download, path, (n) => (received += n));
    expect(readFileSync(path, "utf8")).toBe("model weights");
    expect(fetch.calls).toHaveLength(1);
    expect(received).toBe(2 * bytes.length);
  });
});

describe("PromptHistory", () => {
  it("reads typed user messages only", () => {
    expect(userText(line("user", [{ type: "text", text: "hello" }, { type: "image" }]))).toBe("hello");
    expect(userText(line("user", "plain"))).toBe("plain");
    expect(userText(line("assistant", "no"))).toBeUndefined();
    expect(userText('{"role":"user", broken')).toBeUndefined();
  });

  it("lists a project's typed messages, its worktrees' cwd too, newest first and without repeats", async () => {
    const sessions = join(root, "sessions-history");
    const project = "/Users/me/Code/app";
    const folder = sessionFolder(sessions, project);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "1.jsonl"), [line("user", "an older message about the billing page layout"), line("assistant", "ok")].join("\n"));
    writeFileSync(join(folder, "2.jsonl"), [line("user", PROMPT), line("user", "Resolve this card from the project's Kanban board please now"), line("user", "go ahead"), line("user", PROMPT)].join("\n"));
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(folder, "1.jsonl"), old, old);
    const history = new PromptHistory(() => sessions);
    expect(await history.prompts(project)).toEqual([PROMPT, "an older message about the billing page layout"]);
    expect(await history.prompts(`${process.env.HOME}/.pi-gna/worktrees/ab12cd${project}`)).toEqual([PROMPT, "an older message about the billing page layout"]);
  });
});

describe("serverBuilds", () => {
  it("has a pinned build for every platform pi-gna ships, GPU first on Windows", () => {
    for (const key of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"]) expect(serverBuilds(...(key.split("-") as [string, string])).length, key).toBeGreaterThan(0);
    expect(serverBuilds("win32", "x64").map((build) => build.id)).toEqual(["b11553-win-vulkan-x64", "b11553-win-cpu-x64"]);
    expect(serverBuilds("sunos", "x64")).toEqual([]);
  });
});

// The fake server is a Node script run as an executable: no shebangs on Windows.
describe.skipIf(process.platform === "win32")("Autocomplete", () => {
  /** A tar.gz holding the fake llama-server, served at `url`. */
  function build(id: string): { build: ServerBuild; bytes: Buffer } {
    const dir = join(root, `archive-${id}`, "llama-b0");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(__dirname, "fixtures", "fake-llama-server.mjs"), join(dir, "llama-server"));
    chmodSync(join(dir, "llama-server"), 0o755);
    const archive = join(root, `${id}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", join(dir, ".."), "llama-b0"]);
    const bytes = readFileSync(archive);
    return { build: { id, url: `https://example.test/${id}.tar.gz`, size: bytes.length, sha256: sha(bytes) }, bytes };
  }

  function setup(ids: string[]) {
    const dir = join(root, `userdata-${ids.join("-")}`);
    const sessions = join(root, `sessions-${ids.join("-")}`);
    const folder = sessionFolder(sessions, "/Users/me/Code/app");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "1.jsonl"), line("user", PROMPT));
    const weights = Buffer.from("weights");
    const model = { file: "model.gguf", url: "https://example.test/model.gguf", size: weights.length, sha256: sha(weights) };
    const archives = ids.map(build);
    const fetch = memoryFetch({ [model.url]: weights, ...Object.fromEntries(archives.map(({ build, bytes }) => [build.url, bytes])) });
    const statuses: AutocompleteStatus[] = [];
    const service = new Autocomplete({ dir, sessionsDir: () => sessions, fetch, onStatus: (status) => statuses.push(status), builds: archives.map((entry) => entry.build), model });
    return { service, statuses, fetch, dir };
  }

  const request = { cwd: "/Users/me/Code/app", draft: "why does the composer", lastUser: "check it", lastAgent: "Checked." };

  it("downloads on enable, then suggests from the local server with the project's earlier messages", async () => {
    const log = join(root, "requests.log");
    vi.stubEnv("FAKE_LLAMA_LOG", log);
    const { service, statuses } = setup(["gpu"]);
    try {
      expect(await service.suggest("c1", request)).toBe("");
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"), { timeout: 10_000 });
      expect(statuses.some((status) => status.phase === "downloading")).toBe(true);
      expect(await service.suggest("c1", request)).toBe(" the composer scroll");
      const sent = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
      expect(sent).toMatchObject({ n_predict: 16, temperature: 0, stop: ["\n"], cache_prompt: true });
      expect(sent.prompt).toContain(`Earlier messages from the user:\n- ${PROMPT}\n***Roleplay chat below***\nUser: check it\nAgent: Checked.\nUser: why does the composer`);
      service.setEnabled(false);
      expect(service.get().phase).toBe("off");
      expect(await service.suggest("c1", request)).toBe("");
    } finally {
      service.dispose();
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the next build when the first will not start", async () => {
    vi.stubEnv("FAKE_LLAMA_FAIL", "/server/broken/");
    const { service, fetch } = setup(["broken", "cpu"]);
    try {
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"), { timeout: 10_000 });
      expect(await service.suggest("c1", request)).toBe("");
      await vi.waitFor(() => expect(fetch.calls).toContain("https://example.test/cpu.tar.gz"), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await service.suggest("c1", request)).toBe(" the composer scroll"), { timeout: 10_000 });
    } finally {
      service.dispose();
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("lets a newer request overtake an older one from the same client", async () => {
    const { service } = setup(["overtake"]);
    try {
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"), { timeout: 10_000 });
      const [first, second] = await Promise.all([service.suggest("c1", request), service.suggest("c1", request)]);
      expect([first, second]).toEqual(["", " the composer scroll"]);
    } finally {
      service.dispose();
    }
  });
});
