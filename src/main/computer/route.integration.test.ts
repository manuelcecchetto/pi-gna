// End to end: HTTP POST /computer (session token) -> AgentBridge -> computerRoute -> ComputerAgent -> ComputerService ->
// a fake helper process speaking the real wire protocol. No macOS permissions, Swift or network.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppStateResult, applyComputerOp, type ComputerOp, type ComputerSettings, emptyComputerSettings } from "../../shared/computer";
import { AgentBridge } from "../bridge";
import { ComputerAgent, type ComputerHost, computerRoute } from "./agent";
import { ComputerService, HELPER_APP } from "./service";

vi.mock("../log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const FAKE = join(__dirname, "fixtures", "fake-helper.mjs");
const children: ChildProcess[] = [];
let dir: string;
let bridge: AgentBridge;
let service: ComputerService;
let settings: ComputerSettings;
let token: string;
let answer: string | undefined;
let chose: string[];
let aborted: string[];

async function post(body: Record<string, unknown>, bearer = token): Promise<{ status: number; body: { text?: string; image?: string; error?: string } }> {
  const response = await fetch(`${bridge.url}/computer`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as { text?: string; image?: string; error?: string } };
}

/** Helper calls seen by the fake, as "method" or "method:bundleId". */
async function calls(): Promise<string[]> {
  const raw = await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: { app?: { bundleId?: string } | string } })
    .map(({ method, params }) => (params.app && typeof params.app === "object" ? `${method}:${params.app.bundleId}` : method));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pigna-cu-"));
  await writeFile(join(dir, "calls.jsonl"), "");
  settings = { ...emptyComputerSettings(), enabled: true };
  answer = "Allow once";
  chose = [];
  aborted = [];
  const app = join(dir, "bundled", HELPER_APP);
  service = new ComputerService({
    bundledApp: app,
    installDir: join(dir, "installed"),
    socketDir: dir,
    parentPid: process.pid,
    readVersion: async () => 1,
    install: async () => undefined,
    readRequirement: async () => undefined,
    resetGrants: async () => undefined,
    launch: async (_app, args) => {
      const child = spawn(process.execPath, [FAKE, ...args, "--log", join(dir, "calls.jsonl")], { stdio: "ignore" });
      children.push(child);
    },
    connectTimeoutMs: 5000,
    callTimeoutMs: 5000,
  });
  const host: ComputerHost = {
    choose: async (_handle, title) => {
      chose.push(title);
      return answer;
    },
    chatName: async () => "My chat",
    abort: async (handle) => void aborted.push(handle),
  };
  const policy = { get: async () => settings, apply: async (op: ComputerOp) => void (settings = applyComputerOp(settings, op, 1)) };
  const agent = new ComputerAgent(service, policy, host, { ownNames: ["pi-gna"] });
  bridge = new AgentBridge();
  bridge.route("/computer", computerRoute(() => agent));
  await bridge.start();
  token = bridge.register("chat1");
});

afterEach(async () => {
  await service.stop();
  bridge.stop();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

describe("POST /computer against a fake helper", () => {
  it("rejects requests without a valid session token", async () => {
    expect((await post({ action: "list_apps" }, "nope")).status).toBe(401);
  });

  it("lists apps without the denylisted ones", async () => {
    const { status, body } = await post({ action: "list_apps" });
    expect(status).toBe(200);
    expect(body.text).toContain("Notes (com.example.Notes) running");
    expect(body.text).not.toContain("Terminal");
    expect(chose).toEqual([]);
  });

  it("returns a full state with a screenshot, then a diff, and clicks by index", async () => {
    const first = await post({ action: "get_app_state", app: "Notes" });
    expect(first.status).toBe(200);
    expect(first.body.text).toContain("0 button Save");
    expect(first.body.image).toBe("/9j/FAKE");
    expect(chose).toHaveLength(1);

    const second = await post({ action: "get_app_state", app: "Notes" });
    expect(second.body.text).toMatch(/^diff:/);

    const click = await post({ action: "click", app: "Notes", element_index: 2 });
    expect(click.status).toBe(200);
    expect(click.body.text).toContain("click done (ax)");
    expect(click.body.text).toContain("diff:");
    expect(click.body.image).toBeUndefined();
    expect(chose).toHaveLength(1);
    const sent = await calls();
    expect(sent.filter((c) => c === "click:com.example.Notes")).toHaveLength(1);
  });

  it("surfaces a stale element index as an error the model can act on", async () => {
    await post({ action: "get_app_state", app: "Notes" });
    const stale = await post({ action: "click", app: "Notes", element_index: 42 });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toContain("stale");
  });

  it("refuses a denylisted app without asking or touching the helper", async () => {
    const result = await post({ action: "click", app: "Terminal", element_index: 0 });
    expect(result.status).toBe(403);
    expect(chose).toEqual([]);
    expect((await calls()).filter((c) => c.startsWith("click") || c.startsWith("overlay"))).toEqual([]);
  });

  it("refuses everything when the feature is disabled", async () => {
    settings = { ...settings, enabled: false };
    expect((await post({ action: "list_apps" })).status).toBe(403);
    const result = await post({ action: "get_app_state", app: "Notes" });
    expect(result.status).toBe(403);
    expect(result.body.error).toContain("off");
    expect(await calls()).toEqual([]);
  });

  describe("approval outcomes", () => {
    it("Deny refuses, and is not asked again in the same run", async () => {
      answer = "Deny";
      expect((await post({ action: "get_app_state", app: "Notes" })).status).toBe(403);
      expect((await post({ action: "get_app_state", app: "Notes" })).status).toBe(403);
      expect(chose).toHaveLength(1);
      expect((await calls()).some((c) => c.startsWith("overlay_show"))).toBe(false);
    });

    it("a dismissed card counts as Deny", async () => {
      answer = undefined;
      expect((await post({ action: "get_app_state", app: "Notes" })).status).toBe(403);
    });

    it("Always allow is stored and skips the card for later chats", async () => {
      answer = "Always allow";
      expect((await post({ action: "get_app_state", app: "Notes" })).status).toBe(200);
      expect(settings.alwaysAllowed.map((a) => a.bundleId)).toEqual(["com.example.Notes"]);
      await post({ action: "end" });
      const other = bridge.register("chat2");
      expect((await post({ action: "get_app_state", app: "Notes" }, other)).status).toBe(200);
      expect(chose).toHaveLength(1);
    });

    it("Allow once is forgotten when the run ends", async () => {
      await post({ action: "get_app_state", app: "Notes" });
      await post({ action: "end" });
      await post({ action: "get_app_state", app: "Notes" });
      expect(chose).toHaveLength(2);
    });
  });

  it("shows the overlay on the first action only and hides it when the run ends", async () => {
    await post({ action: "get_app_state", app: "Notes" });
    await post({ action: "click", app: "Notes", element_index: 1 });
    await post({ action: "get_app_state", app: "Calc" });
    let sent = await calls();
    expect(sent.filter((c) => c === "overlay_show:com.example.Notes")).toHaveLength(1);
    expect(sent.filter((c) => c === "overlay_show:com.example.Calc")).toHaveLength(1);
    expect(sent.some((c) => c.startsWith("overlay_hide"))).toBe(false);

    await post({ action: "end" });
    sent = await calls();
    expect(sent).toContain("overlay_hide:com.example.Notes");
    expect(sent).toContain("overlay_hide:com.example.Calc");
  });

  it("the helper's Esc notification aborts the run, hides the overlay and fails the pending call", async () => {
    await post({ action: "get_app_state", app: "Notes" });
    const pending = await post({ action: "type_text", app: "Notes", text: "__esc__" });
    expect(pending.status).toBe(400);
    expect(pending.body.error).toContain("Esc");
    expect(aborted).toEqual(["chat1"]);
    await vi.waitFor(async () => expect(await calls()).toContain("overlay_hide:com.example.Notes"));
    // The next call starts a fresh run and asks for approval again.
    expect((await post({ action: "get_app_state", app: "Notes" })).status).toBe(200);
    expect(chose).toHaveLength(2);
  });

  it("keeps the fake helper's state shape in line with AppStateResult", async () => {
    const state: AppStateResult = await service.call("get_app_state", { app: "Notes" });
    expect(state).toMatchObject({ mode: "full", bundleId: "com.example.Notes", windowId: 1, elementCount: 5 });
  });
});
