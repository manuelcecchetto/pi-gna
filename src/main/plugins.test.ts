import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsState } from "../shared/plugins";
import { PiPlugins } from "./plugins";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

// A stand-in for the parts of pi's SDK resources/pi-plugins.mts uses. Settings live in <agent>/settings.json; every
// configured package has one extension, `index.ts`; installing prints to stdout, as npm does.
const FAKE_INDEX = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const getAgentDir = () => process.env.FAKE_AGENT_DIR;
const file = () => join(getAgentDir(), "settings.json");
export const read = () => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {});
const write = (settings) => writeFileSync(file(), JSON.stringify(settings, null, 2));
// As pi's: the setters change globalSettings and save; defaultTools has no setter (markModified + save, private in pi).
export const SettingsManager = {
  create: () => ({
    globalSettings: read(),
    getGlobalSettings() { return this.globalSettings; },
    getProjectSettings: () => ({}),
    setPackages(packages) { this.globalSettings = { ...this.globalSettings, packages }; },
    setExtensions(extensions) { this.globalSettings = { ...this.globalSettings, extensions }; },
    markModified() {},
    save() {},
    isProjectTrusted: () => false,
    async flush() { write(this.globalSettings); },
  }),
};
const source = (pkg) => (typeof pkg === "string" ? pkg : pkg.source);
export class DefaultPackageManager {
  constructor({ settingsManager }) { this.settings = settingsManager; }
  async resolve(onMissing) {
    const settings = this.settings.getGlobalSettings();
    const extensions = [];
    for (const pkg of settings.packages ?? []) {
      if (source(pkg).startsWith("npm:missing")) { await onMissing(source(pkg)); continue; }
      const off = typeof pkg === "object" && Array.isArray(pkg.extensions) && (pkg.extensions.length === 0 || pkg.extensions.includes("-index.ts"));
      extensions.push({ path: "/pkgs/" + source(pkg) + "/index.ts", enabled: !off, metadata: { source: source(pkg), scope: "user", origin: "package" } });
    }
    extensions.push({ path: "/agent/extensions/mine.ts", enabled: true, metadata: { source: "auto", scope: "user", origin: "top-level" } });
    extensions.push({ path: "builtin:mcp", enabled: !(settings.extensions ?? []).includes("-builtin:mcp"), metadata: { source: "builtin", scope: "user", origin: "top-level" } });
    return { extensions, skills: [], prompts: [], themes: [] };
  }
  listConfiguredPackages() {
    return (this.settings.getGlobalSettings().packages ?? []).map((pkg) => ({ source: source(pkg), scope: "user", filtered: false, ...(source(pkg).startsWith("npm:missing") ? {} : { installedPath: "/pkgs/" + source(pkg) }) }));
  }
  async installAndPersist(src) {
    process.stdout.write("added 12 packages in 2s\\n");
    this.settings.setPackages([...(this.settings.getGlobalSettings().packages ?? []), src]);
    await this.settings.flush();
  }
  async removeAndPersist(src) {
    const settings = read();
    const packages = (settings.packages ?? []).filter((pkg) => source(pkg) !== src);
    write({ ...settings, packages });
    return packages.length !== (settings.packages ?? []).length;
  }
}
export class ProjectTrustStore { get() { return false; } }
`;

const FAKE_SELECTOR = `
import { basename } from "node:path";
export class ConfigSelectorComponent {
  constructor(resolved, settingsManager) {
    const groups = new Map();
    for (const item of resolved.global.extensions) {
      const key = item.metadata.origin + ":" + item.metadata.source;
      if (!groups.has(key)) groups.set(key, { key, label: item.metadata.source === "builtin" ? "Built-in" : item.metadata.origin === "package" ? item.metadata.source + " (user)" : "User (~/.pi/agent/)", scope: "user", origin: item.metadata.origin, source: item.metadata.source, subgroups: [{ type: "extensions", items: [] }] });
      groups.get(key).subgroups[0].items.push({ ...item, resourceType: "extensions", displayName: item.metadata.source === "builtin" ? item.path.slice(8) : basename(item.path) });
    }
    this.resourceList = {
      groupsByScope: { global: [...groups.values()], project: [...groups.values()] },
      toggleResource(item) {
        const settings = settingsManager.getGlobalSettings();
        settingsManager.setExtensions([...(settings.extensions ?? []), (item.enabled ? "-" : "+") + item.path]);
        return !item.enabled;
      },
      getProjectOverrideState: () => "inherit",
      getInheritedEnabled: (item) => item.enabled,
      setProjectResourceOverride: () => true,
    };
  }
}
`;

const FAKE_MCP = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { mcpServers: {} });
export function loadMcpConfig({ agentDir }) {
  const path = agentDir + "/mcp.json";
  return { servers: Object.entries(read(path).mcpServers).map(([name, config]) => ({ name, config, source: path, scope: "global" })), errors: [] };
}
export function addMcpServerConfig(path, name, config) {
  const file = read(path);
  file.mcpServers[name] = config;
  writeFileSync(path, JSON.stringify(file));
  return false;
}
export function removeMcpServerConfig(path, name) {
  const file = read(path);
  if (!file.mcpServers[name]) return false;
  delete file.mcpServers[name];
  writeFileSync(path, JSON.stringify(file));
  return true;
}
export function updateMcpServerConfig(path, name, patch) {
  const file = read(path);
  file.mcpServers[name] = { ...file.mcpServers[name], ...patch };
  writeFileSync(path, JSON.stringify(file));
}
`;

const CATALOG = {
  version: 1,
  entries: [
    { id: "acme", kind: "mcp", name: "Acme", publisher: "Acme", description: "CRM", homepage: "https://acme.test", server: "acme", endpoints: [{ id: "default", label: "Acme", url: "https://mcp.acme.test/mcp" }], auth: { type: "oauth" } },
    {
      id: "keyed",
      kind: "mcp",
      name: "Keyed",
      publisher: "Keyed",
      description: "Mail",
      homepage: "https://keyed.test",
      server: "keyed",
      endpoints: [{ id: "default", label: "Keyed", url: "https://mcp.keyed.test/mcp" }],
      auth: { type: "key", label: "MCP token", help: "Make one.", url: "https://keyed.test/keys" },
    },
    { id: "web", kind: "package", name: "Web", publisher: "web", description: "Search", homepage: "https://npm.test/web", source: "npm:pi-web@1.0.0", recommended: true },
    { id: "find", kind: "package", name: "Find", publisher: "@x/find", description: "Find", homepage: "https://npm.test/find", source: "npm:@x/find@2.0.0", recommended: true },
    { id: "extra", kind: "package", name: "Extra", publisher: "extra", description: "Extra", homepage: "https://npm.test/extra", source: "npm:extra@1.0.0" },
  ],
};

let dir: string;
let agent: string;
let plugins: PiPlugins | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pigna-plugins-"));
  agent = join(dir, "agent");
  mkdirSync(agent);
  const dist = join(dir, "pkg", "dist");
  for (const [path, body] of [
    ["index.js", FAKE_INDEX],
    ["modes/interactive/components/config-selector.js", FAKE_SELECTOR],
    ["extensions/index.js", `export const builtInExtensions = [{ name: "mcp", builtin: true }, () => undefined];`],
    ["core/resource-loader.js", `export const isBuiltinExtension = (input) => typeof input !== "function" && input.builtin === true;`],
    ["extensions/mcp/config.js", FAKE_MCP],
  ] as const) {
    mkdirSync(join(dist, path, ".."), { recursive: true });
    writeFileSync(join(dist, path), body);
  }
  writeFileSync(join(dir, "bundled.json"), JSON.stringify(CATALOG));
  writeFileSync(join(dir, "guide.md"), "# Guide\n");
  vi.stubEnv("FAKE_AGENT_DIR", agent);
});

afterEach(() => {
  plugins?.close();
  plugins = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const settings = () => JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")) as { packages?: unknown[]; extensions?: string[]; defaultTools?: string[] };
const writeSettings = (value: unknown) => writeFileSync(join(agent, "settings.json"), JSON.stringify(value));

/** `fetched`: the remote catalog's body, or an error. */
function start(options: { sdk?: string | null; fetched?: unknown } = {}) {
  const fetchCatalog = vi.fn(async () => {
    if (options.fetched instanceof Error || options.fetched === undefined) throw options.fetched ?? new Error("offline");
    return new Response(JSON.stringify(options.fetched));
  });
  plugins = new PiPlugins({
    script: resolve("resources/pi-plugins.mts"),
    bundled: join(dir, "bundled.json"),
    cache: join(dir, "cache", "catalog.json"),
    remote: "https://catalog.test/catalog.json",
    guide: join(dir, "guide.md"),
    onLogin: vi.fn(),
    sdk: () => (options.sdk === null ? undefined : (options.sdk ?? join(dir, "pkg"))),
    node: process.execPath,
    fetch: fetchCatalog as unknown as typeof fetch,
  });
  return { plugins, fetchCatalog };
}

describe("the catalog", () => {
  it("is fetched once per launch and kept for the next", async () => {
    const remote = { ...CATALOG, entries: CATALOG.entries.slice(0, 1) };
    const { plugins, fetchCatalog } = start({ fetched: remote });
    expect(await plugins.catalog()).toEqual({ catalog: remote, origin: "remote" });
    await plugins.catalog();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, "cache", "catalog.json"), "utf8"))).toEqual(remote);
  });

  it("falls back to the kept copy, then to the bundled one, when the remote one fails or is invalid", async () => {
    expect((await start({ fetched: { version: 1, entries: [{ id: "x", kind: "package", source: "npm:x" }] } }).plugins.catalog()).origin).toBe("bundled");
    mkdirSync(join(dir, "cache"));
    writeFileSync(join(dir, "cache", "catalog.json"), JSON.stringify({ ...CATALOG, entries: [] }));
    expect(await start().plugins.catalog()).toEqual({ catalog: { version: 1, entries: [] }, origin: "cache" });
  });
});

describe("pi's state", () => {
  it("lists packages, your own resources and the built-ins, with what is missing and pi-mcp-adapter", async () => {
    writeSettings({ packages: ["npm:pi-mcp-adapter", "npm:missing-one"], extensions: ["-builtin:mcp"] });
    const state = (await start().plugins.state(undefined)) as PluginsState;
    expect(state.error).toBeUndefined();
    expect(state.views.global.groups.map((group) => [group.kind, group.source, group.resources.map((resource) => [resource.name, resource.enabled])])).toEqual([
      ["package", "npm:pi-mcp-adapter", [["index.ts", true]]],
      ["own", "auto", [["mine.ts", true]]],
      ["builtin", "builtin", [["mcp", false]]],
    ]);
    expect(state.missing).toEqual([{ source: "npm:missing-one", scope: "user" }]);
    expect(state.mcpAdapter).toBe(true);
    expect(state.builtinMcp).toBe(false);
    expect(state.defaults).toEqual({ codemode: "unset", guide: false });
    expect(state.project).toBeUndefined();
  });

  it("says why when pi cannot be found", async () => {
    expect((await start({ sdk: null }).plugins.state(undefined)).error).toMatch(/could not find pi's SDK/);
  });
});

describe("changes", () => {
  it("turns a whole package off with empty filters and on again without any", async () => {
    writeSettings({ packages: ["npm:a", { source: "npm:b", skills: ["-x"] }] });
    const { plugins } = start();
    await plugins.togglePackage(undefined, { scope: "global", source: "npm:a", packageScope: "user", enabled: false });
    expect(settings().packages).toEqual([{ source: "npm:a", extensions: [], skills: [], prompts: [], themes: [] }, { source: "npm:b", skills: ["-x"] }]);
    await plugins.togglePackage(undefined, { scope: "global", source: "npm:a", packageScope: "user", enabled: true });
    await plugins.togglePackage(undefined, { scope: "global", source: "npm:b", packageScope: "user", enabled: true });
    expect(settings().packages).toEqual(["npm:a", "npm:b"]);
  });

  it("toggles one resource through pi's own list, only when it changes", async () => {
    writeSettings({});
    const { plugins } = start();
    await plugins.toggle(undefined, { scope: "global", path: "builtin:mcp", type: "extensions", enabled: true });
    await plugins.toggle(undefined, { scope: "global", path: "builtin:mcp", type: "extensions", enabled: false });
    expect(settings().extensions).toEqual(["-builtin:mcp"]);
    await expect(plugins.toggle(undefined, { scope: "global", path: "/gone.ts", type: "extensions", enabled: false })).rejects.toThrow(/no longer lists/);
    await expect(plugins.toggle(undefined, { scope: "project", path: "builtin:mcp", type: "extensions", override: "load" })).rejects.toThrow(/does not trust/);
  });

  it("installs a catalog package while npm writes to stdout, and runs changes one at a time", async () => {
    writeSettings({ packages: ["npm:a"] });
    const { plugins } = start();
    await Promise.all([plugins.install("web"), plugins.togglePackage(undefined, { scope: "global", source: "npm:a", packageScope: "user", enabled: false })]);
    expect(settings().packages).toEqual([{ source: "npm:a", extensions: [], skills: [], prompts: [], themes: [] }, "npm:pi-web@1.0.0"]);
    await expect(plugins.install("acme")).rejects.toThrow(/no package acme/);
    await plugins.remove(undefined, "npm:pi-web@1.0.0", "user");
    expect(settings().packages).toHaveLength(1);
  });

  it("applies the recommended setup: the recommended packages it lacks, codemode, and the guide when there is none", async () => {
    writeSettings({ packages: ["npm:pi-web@0.9.0"], defaultTools: ["read", "bash"] });
    const { plugins } = start();
    await plugins.recommend();
    expect(settings()).toEqual({ packages: ["npm:pi-web@0.9.0", "npm:@x/find@2.0.0"], defaultTools: ["read", "bash", "+codemode"] });
    expect(readFileSync(join(agent, "AGENTS.md"), "utf8")).toBe("# Guide\n");
    expect((await plugins.state(undefined)).defaults).toEqual({ codemode: "on", guide: true });
  });

  it("leaves your choices alone: codemode turned off, and an AGENTS.md or CLAUDE.md of your own", async () => {
    writeSettings({ packages: ["npm:pi-web@1.0.0", "npm:@x/find"], defaultTools: ["-codemode"] });
    writeFileSync(join(agent, "CLAUDE.md"), "mine");
    const { plugins } = start();
    await plugins.recommend();
    expect(settings()).toEqual({ packages: ["npm:pi-web@1.0.0", "npm:@x/find"], defaultTools: ["-codemode"] });
    expect(existsSync(join(agent, "AGENTS.md"))).toBe(false);
    expect((await plugins.state(undefined)).defaults).toEqual({ codemode: "off", guide: true });
  });

  it("adds a catalog connection to mcp.json, turns it off and on, and checks a token before keeping it", async () => {
    const { plugins } = start();
    await plugins.connect("acme", "default");
    await plugins.enableServer(undefined, "acme", "global", false);
    const mcp = () => JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8")).mcpServers;
    expect(mcp()).toEqual({ acme: { url: "https://mcp.acme.test/mcp", enabled: false } });
    expect((await plugins.state(undefined)).servers).toEqual([{ name: "acme", scope: "global", file: join(agent, "mcp.json"), enabled: false, target: "https://mcp.acme.test/mcp" }]);
    await expect(plugins.connect("acme", "eu")).rejects.toThrow(/no endpoint eu/);
    await expect(plugins.connect("keyed", "default", "not a token")).rejects.toThrow(/does not look like a MCP token/);
    await expect(plugins.connect("web", "default")).rejects.toThrow(/no connection web/);
  });
});
