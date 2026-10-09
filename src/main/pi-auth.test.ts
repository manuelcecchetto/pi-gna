import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginUpdate } from "../shared/auth";
import { findPiSdk, PiAuth } from "./pi-auth";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

// A stand-in for pi's SDK: the ModelRuntime calls resources/pi-auth.mts makes, with credentials in <agent>/auth.json.
// acme signs in with an account (browser, which wins against the pasted code, or a pasted code); beta takes a key.
// pi-claude-bridge counts as installed while it is in <agent>/npm.
const FAKE_SDK = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const getAgentDir = () => process.env.FAKE_AGENT_DIR;
export const SettingsManager = { create: () => ({ getOrCreateDeviceId: () => "device-1" }) };
export class DefaultPackageManager {
  listConfiguredPackages() {
    const bridge = join(getAgentDir(), "npm", "node_modules", "pi-claude-bridge");
    return existsSync(join(bridge, "package.json")) ? [{ source: "npm:pi-claude-bridge", scope: "user", installedPath: bridge }] : [];
  }
}
const file = () => join(getAgentDir(), "auth.json");
const read = () => JSON.parse(readFileSync(file(), "utf8"));
const save = (creds) => writeFileSync(file(), JSON.stringify(creds));
export class ModelRuntime {
  static async create() { return new ModelRuntime(); }
  getProviders() {
    return [
      { id: "beta", name: "Beta", auth: { apiKey: { name: "Beta key", login() {} } } },
      { id: "acme", name: "Acme", auth: { oauth: { name: "Acme (Pro)", isSubscription: true, loginLabel: "Sign in with Acme" }, apiKey: { name: "Acme API key", login() {} } } },
      { id: "envy", name: "Envy", auth: { apiKey: { name: "Envy key" } } },
    ];
  }
  getProviderAuthStatus(id) {
    if (read()[id]) return { configured: true, source: "stored" };
    return id === "envy" ? { configured: true, source: "environment", label: "ENVY_KEY" } : { configured: false };
  }
  isUsingOAuth(id) { return read()[id]?.type === "oauth"; }
  async listCredentials() { return Object.entries(read()).map(([providerId, c]) => ({ providerId, type: c.type })); }
  async refresh() {}
  async logout(id) { const creds = read(); delete creds[id]; save(creds); }
  async login(id, type, { signal, prompt, notify }, { getDeviceId }) {
    if (type === "api_key") {
      const key = await prompt({ type: "secret", message: "Enter Beta key" });
      save({ ...read(), [id]: { type, key } });
      return;
    }
    const how = await prompt({ type: "select", message: "How?", options: [{ id: "browser", label: "Browser" }, { id: "code", label: "Code" }] });
    if (how === "device") {
      notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://acme.test/device" });
      await new Promise((resolve) => setTimeout(resolve, 30));
    } else if (how === "browser") {
      notify({ type: "auth_url", url: "https://acme.test/auth?device=" + getDeviceId() });
      const pasted = new AbortController();
      const answer = prompt({ type: "manual_code", message: "Paste the code", signal: pasted.signal }).catch(() => "callback");
      setTimeout(() => pasted.abort(), 50);
      await answer;
    } else {
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        prompt({ type: "manual_code", message: "Paste the code" }).then(resolve, reject);
      });
    }
    save({ ...read(), [id]: { type } });
  }
}
`;

// A stand-in for pi's CLI: \`pi install\` copies the package staged in FAKE_BRIDGE_STAGE into <agent>/npm, logging its
// arguments to FAKE_PI_LOG, or fails as npm does with FAKE_PI_FAIL.
const FAKE_PI = `#!/usr/bin/env node
import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
appendFileSync(process.env.FAKE_PI_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.env.FAKE_PI_FAIL) {
  process.stderr.write("npm error code E404\\nnpm error 404 Not Found - pi-claude-bridge\\n");
  process.exit(1);
}
cpSync(process.env.FAKE_BRIDGE_STAGE, join(process.env.FAKE_AGENT_DIR, "npm", "node_modules", "pi-claude-bridge"), { recursive: true });
process.stdout.write("Installed npm:pi-claude-bridge\\n");
`;

// A stand-in for Claude Code's `claude auth`, signed in while FAKE_CLAUDE_STATE exists. Its login prints the link as
// Claude Code 2.1 does (an OSC 8 hyperlink), takes a pasted code#state (anything else is "invalid"), or finishes by
// itself, like the browser callback, with FAKE_CLAUDE_CALLBACK.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { existsSync, rmSync, writeFileSync } = require("node:fs");
const state = process.env.FAKE_CLAUDE_STATE;
const command = process.argv[3];
if (command === "status") {
  const signedIn = existsSync(state);
  process.stdout.write(JSON.stringify(signedIn ? { loggedIn: true, authMethod: "claude.ai", email: "me@example.com", subscriptionType: "max" } : { loggedIn: false, authMethod: "none" }));
  process.exit(signedIn ? 0 : 1);
}
if (command === "logout") {
  rmSync(state, { force: true });
  process.exit(0);
}
const url = "https://claude.test/oauth/authorize?code=true";
process.stdout.write("Opening browser to sign in\\u2026\\nIf the browser didn't open, visit: \\x1b]8;;" + url + "\\x07" + url + "\\x1b]8;;\\x07\\nPaste code here if prompted > ");
const done = () => {
  writeFileSync(state, "1");
  process.stdout.write("Login successful.\\n");
  process.exit(0);
};
if (process.env.FAKE_CLAUDE_CALLBACK) setTimeout(done, 50);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at !== -1; at = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.includes("#")) done();
    else process.stderr.write("Invalid code. Please make sure the full code was copied.\\n");
  }
});
`;

let dir: string;
let auth: PiAuth | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pigna-auth-"));
  mkdirSync(join(dir, "pkg", "dist", "bundle"), { recursive: true });
  writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module" }));
  writeFileSync(join(dir, "pkg", "dist", "index.js"), FAKE_SDK);
  writeFileSync(join(dir, "pkg", "dist", "bundle", "cli.js"), FAKE_PI);
  chmodSync(join(dir, "pkg", "dist", "bundle", "cli.js"), 0o755);
  mkdirSync(join(dir, "agent"));
  writeFileSync(join(dir, "agent", "auth.json"), "{}");
  vi.stubEnv("FAKE_AGENT_DIR", join(dir, "agent"));
});

afterEach(() => {
  auth?.close();
  auth = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** Installs pi-claude-bridge for pi (or puts it in `bridge` for the fake pi to install), with a fake Claude Code in
 * `binDir` of it; returns that Claude Code. */
function installBridge(binDir = "bin", bridge = join(dir, "agent", "npm", "node_modules", "pi-claude-bridge")): string {
  mkdirSync(join(bridge, binDir), { recursive: true });
  writeFileSync(join(bridge, "package.json"), JSON.stringify({ name: "pi-claude-bridge" }));
  const claude = join(bridge, binDir, "claude");
  writeFileSync(claude, FAKE_CLAUDE);
  chmodSync(claude, 0o755);
  vi.stubEnv("FAKE_CLAUDE_STATE", join(dir, "claude-signed-in"));
  return claude;
}

/** `sdk` null: no pi found. */
const start = (sdk: string | null = join(dir, "pkg"), idleMs?: number) =>
  (auth = new PiAuth({ script: resolve("resources/pi-auth.mts"), sdk: () => sdk ?? undefined, node: process.execPath, idleMs }));

/** Answers each prompt with `answers[type]`, or cancels the login on a prompt type listed in `cancelOn`. */
function responder(target: PiAuth, answers: Record<string, string>, cancelOn?: string) {
  const updates: LoginUpdate[] = [];
  return {
    updates,
    onUpdate: (update: LoginUpdate) => {
      updates.push(update);
      if (update.kind !== "prompt") return;
      if (update.prompt.type === cancelOn) target.cancel();
      else if (answers[update.prompt.type] !== undefined) target.answer(update.prompt.n, answers[update.prompt.type] as string);
    },
  };
}

describe("findPiSdk", () => {
  it("follows `pi` on the PATH to the package it belongs to", () => {
    mkdirSync(join(dir, "bin"));
    symlinkSync(join(dir, "pkg", "dist", "bundle", "cli.js"), join(dir, "bin", "pi"));
    expect(findPiSdk("pi", `/nowhere:${join(dir, "bin")}`)).toBe(realpathSync(join(dir, "pkg")));
    expect(findPiSdk(join(dir, "bin", "pi"), "")).toBe(realpathSync(join(dir, "pkg")));
  });

  it("follows a Windows .cmd shim to the script it runs", () => {
    mkdirSync(join(dir, "npm"));
    writeFileSync(join(dir, "npm", "pi.cmd"), `@"%~dp0\\..\\pkg\\dist\\bundle\\cli.js" %*\n`);
    expect(findPiSdk("pi", `C:\\nowhere;${join(dir, "npm")}`, "win32")).toBe(realpathSync(join(dir, "pkg")));
  });

  it("finds nothing without pi, or when the file is not in pi's package", () => {
    expect(findPiSdk("pi", "/nowhere")).toBeUndefined();
    writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "pi-gna" }));
    expect(findPiSdk(join(dir, "pkg", "dist", "bundle", "cli.js"))).toBeUndefined();
  });
});

describe("PiAuth", () => {
  it("lists pi's providers by name, with how each is signed in", async () => {
    const state = await start().list();
    expect(state.error).toBeUndefined();
    expect(state.path).toBe(join(dir, "agent", "auth.json"));
    expect(state.providers.map((provider) => provider.id)).toEqual(["acme", "beta", "claude-bridge", "envy"]);
    expect(state.providers[0]).toEqual({ id: "acme", name: "Acme", oauth: { name: "Acme (Pro)", label: "Sign in with Acme", subscription: true }, apiKey: { name: "Acme API key", login: true } });
    expect(state.providers[3]).toEqual({ id: "envy", name: "Envy", apiKey: { name: "Envy key", login: false }, status: { method: "api_key", source: "environment", label: "ENVY_KEY" } });
  });

  it("reports when pi's SDK is missing or will not load", async () => {
    expect((await start(null).list()).error).toMatch(/could not find pi's SDK/);
    auth?.close();
    expect((await start(join(dir, "nothing")).list()).error).toMatch(/could not load pi's SDK from .*nothing/);
  });

  it("saves an API key from the secret prompt, and signs out", async () => {
    const target = start();
    const run = responder(target, { secret: "beta-123" });
    expect(await target.signIn("beta", "api_key", run.onUpdate)).toEqual({ ok: true });
    expect(run.updates[0]).toEqual({ kind: "prompt", prompt: { n: 1, type: "secret", message: "Enter Beta key" } });
    expect(JSON.parse(readFileSync(join(dir, "agent", "auth.json"), "utf8"))).toEqual({ beta: { type: "api_key", key: "beta-123" } });
    const listed = await target.list();
    const beta = listed.providers.find((provider) => provider.id === "beta");
    expect(beta).toMatchObject({ status: { method: "api_key", source: "stored" }, stored: "api_key" });
    // What the phone can read back (providers.list) holds names and statuses, never the saved key.
    expect(JSON.stringify(listed)).not.toContain("beta-123");
    expect(JSON.stringify(run.updates)).not.toContain("beta-123");

    await target.signOut("beta");
    expect((await target.list()).providers.find((provider) => provider.id === "beta")?.status).toBeUndefined();
  });

  it("signs in with an account, withdrawing the paste prompt when the browser wins", async () => {
    const target = start();
    const run = responder(target, { select: "browser" });
    expect(await target.signIn("acme", "oauth", run.onUpdate)).toEqual({ ok: true });
    expect(run.updates).toEqual([
      { kind: "prompt", prompt: { n: 1, type: "select", message: "How?", options: [{ id: "browser", label: "Browser" }, { id: "code", label: "Code" }] } },
      { kind: "event", event: { type: "auth_url", url: "https://acme.test/auth?device=device-1" } },
      { kind: "prompt", prompt: { n: 2, type: "manual_code", message: "Paste the code" } },
      { kind: "withdraw", n: 2 },
      { kind: "event", event: { type: "progress", message: "Refreshing the model list…" } },
    ]);
    expect((await target.list()).providers[0]).toMatchObject({ status: { method: "oauth", source: "stored" }, stored: "oauth" });
  });

  it("passes a device code through to the client that signs in", async () => {
    const target = start();
    const run = responder(target, { select: "device" });
    expect(await target.signIn("acme", "oauth", run.onUpdate)).toEqual({ ok: true });
    expect(run.updates).toContainEqual({ kind: "event", event: { type: "device_code", userCode: "ABCD-1234", verificationUri: "https://acme.test/device" } });
  });

  it("cancels a login", async () => {
    const target = start();
    const run = responder(target, { select: "code" }, "manual_code");
    expect(await target.signIn("acme", "oauth", run.onUpdate)).toMatchObject({ ok: false, cancelled: true });
    expect(JSON.parse(readFileSync(join(dir, "agent", "auth.json"), "utf8"))).toEqual({});
  });

  it("signs claude-bridge in and out with Claude Code's own login", async () => {
    const claude = installBridge();
    writeFileSync(join(dir, "agent", "claude-bridge.json"), JSON.stringify({ provider: { pathToClaudeCodeExecutable: claude } }));
    const target = start();
    const bridge = () => target.list().then((state) => state.providers.find((provider) => provider.id === "claude-bridge"));
    expect(await bridge()).toEqual({
      id: "claude-bridge",
      name: "Claude Code",
      oauth: { name: "Claude Code (Claude subscription)", label: "Sign in with Claude Code's own login, which claude-bridge runs on", subscription: true },
    });

    // A cut-off code is asked for again.
    const updates: LoginUpdate[] = [];
    const codes = ["half-a-code", "code#state"];
    const result = await target.signIn("claude-bridge", "oauth", (update) => {
      updates.push(update);
      if (update.kind === "prompt") target.answer(update.prompt.n, codes.shift() ?? "");
    });
    expect(result).toEqual({ ok: true });
    expect(updates).toEqual([
      { kind: "event", event: { type: "auth_url", url: "https://claude.test/oauth/authorize?code=true", opened: true } },
      { kind: "prompt", prompt: { n: 1, type: "manual_code", message: "If the page shows a code, paste it here", placeholder: "Paste the code" } },
      { kind: "event", event: { type: "progress", message: "Signing in…" } },
      { kind: "prompt", prompt: { n: 2, type: "manual_code", message: "That is not the whole code. Copy all of it from the page and paste it again.", placeholder: "Paste the code" } },
      { kind: "event", event: { type: "progress", message: "Signing in…" } },
    ]);
    expect(await bridge()).toMatchObject({ status: { method: "oauth", source: "claude_code", label: "max" }, stored: "oauth", account: "me@example.com" });
    expect(JSON.parse(readFileSync(join(dir, "agent", "auth.json"), "utf8"))).toEqual({});

    await target.signOut("claude-bridge");
    expect((await bridge())?.status).toBeUndefined();
  });

  it("uses the Agent SDK's Claude Code, and withdraws the paste prompt when the browser finishes", async () => {
    installBridge(join("node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`));
    vi.stubEnv("FAKE_CLAUDE_CALLBACK", "1");
    const target = start();
    const updates: LoginUpdate[] = [];
    expect(await target.signIn("claude-bridge", "oauth", (update) => updates.push(update))).toEqual({ ok: true });
    expect(updates.slice(1)).toEqual([
      { kind: "prompt", prompt: { n: 1, type: "manual_code", message: "If the page shows a code, paste it here", placeholder: "Paste the code" } },
      { kind: "withdraw", n: 1 },
    ]);
    expect((await target.list()).providers.find((provider) => provider.id === "claude-bridge")?.status).toMatchObject({ source: "claude_code" });
  });

  it("installs pi-claude-bridge when pi has none, then signs in and notes the Max plan", async () => {
    installBridge(join("node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`), join(dir, "stage"));
    vi.stubEnv("FAKE_BRIDGE_STAGE", join(dir, "stage"));
    vi.stubEnv("FAKE_PI_LOG", join(dir, "pi.log"));
    vi.stubEnv("FAKE_CLAUDE_CALLBACK", "1");
    writeFileSync(join(dir, "agent", "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "2026-10-01", provider: { strictMcpConfig: false } }));
    const target = start();
    expect((await target.list()).providers.find((provider) => provider.id === "claude-bridge")).toEqual({
      id: "claude-bridge",
      name: "Claude Code",
      oauth: { name: "Claude Code (Claude subscription)", label: "Installs pi-claude-bridge for pi, then signs in with Claude Code's own login", subscription: true },
    });
    const updates: LoginUpdate[] = [];
    expect(await target.signIn("claude-bridge", "oauth", (update) => updates.push(update))).toEqual({ ok: true });
    expect(updates[0]).toEqual({ kind: "event", event: { type: "progress", message: "Installing pi-claude-bridge for pi (a minute or so)…" } });
    expect(readFileSync(join(dir, "pi.log"), "utf8")).toBe("install npm:pi-claude-bridge\n");
    expect((await target.list()).providers.find((provider) => provider.id === "claude-bridge")).toMatchObject({ status: { source: "claude_code", label: "max" } });
    expect(JSON.parse(readFileSync(join(dir, "agent", "claude-bridge.json"), "utf8"))).toEqual({ startupNoticeShown: "2026-10-01", provider: { strictMcpConfig: false, plan: "max" } });
  });

  it("reports a failed install of pi-claude-bridge", async () => {
    vi.stubEnv("FAKE_PI_LOG", join(dir, "pi.log"));
    vi.stubEnv("FAKE_PI_FAIL", "1");
    const target = start();
    expect(await target.signIn("claude-bridge", "oauth", () => undefined)).toEqual({
      ok: false,
      cancelled: false,
      error: "Installing pi-claude-bridge failed: npm error 404 Not Found - pi-claude-bridge",
    });
  });

  it("cancels a Claude Code sign-in", async () => {
    installBridge(join("node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`));
    const target = start();
    const run = responder(target, {}, "manual_code");
    expect(await target.signIn("claude-bridge", "oauth", run.onUpdate)).toMatchObject({ ok: false, cancelled: true });
    expect((await target.list()).providers.find((provider) => provider.id === "claude-bridge")?.status).toBeUndefined();
  });

  it("stops when idle and starts again on the next request", async () => {
    const target = start(join(dir, "pkg"), 20);
    expect((await target.list()).providers).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((target as unknown as { helper?: unknown }).helper).toBeUndefined();
    expect((await target.list()).providers).toHaveLength(4);
  });
});
