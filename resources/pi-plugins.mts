// pi-gna's way into what pi loads, for the Settings page's Plugins section. main (src/main/plugins.ts) runs this file
// once per request with the `node` that runs pi (pi's SDK needs a newer Node than Electron's), argv[2] being the folder
// of pi's package. The request (PluginsRequest) arrives as JSON on stdin; the reply (PluginsReply) leaves as one JSON
// line on fd 3, since `npm install` writes to stdout. Every change goes through pi's own code: `pi config`'s resource
// list (ConfigSelectorComponent) for toggles, its package manager for installs, its MCP config module for mcp.json.
import { constants, copyFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  McpServerInfo,
  PackageToggle,
  PluginGroup,
  PluginResource,
  PluginScope,
  PluginsReply,
  PluginsRequest,
  PluginsState,
  PluginToggle,
  PluginView,
  ProjectOverride,
  RecommendedDefaults,
  ResourceType,
} from "../src/shared/plugins";

type PackageSource = string | ({ source: string; autoload?: boolean } & Partial<Record<ResourceType, string[]>>);

interface SettingsManager {
  getGlobalSettings(): { packages?: PackageSource[]; defaultTools?: unknown };
  setPackages(packages: PackageSource[]): void;
  isProjectTrusted(): boolean;
  flush(): Promise<void>;
}

interface PackageManager {
  resolve(onMissing?: (source: string) => Promise<"install" | "skip" | "error">): Promise<unknown>;
  listConfiguredPackages(): { source: string; scope: "user" | "project"; installedPath?: string }[];
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
}

interface Sdk {
  SettingsManager: { create(cwd: string, agentDir: string, options?: { projectTrusted?: boolean }): SettingsManager };
  DefaultPackageManager: new (options: { cwd: string; agentDir: string; settingsManager: SettingsManager; builtinExtensions?: string[] }) => PackageManager;
  ProjectTrustStore: new (agentDir: string) => { get(cwd: string): boolean | null | undefined };
  getAgentDir(): string;
}

/** An item of `pi config`'s list (ResourceItem in pi's config-selector.ts). */
interface Item {
  path: string;
  enabled: boolean;
  resourceType: ResourceType;
  displayName: string;
  metadata: { source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level" };
}

interface Group {
  key: string;
  label: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  source: string;
  subgroups: { items: Item[] }[];
}

/** The parts of ResourceList used; they are private in pi's types, not at runtime. */
interface ResourceList {
  groupsByScope: Record<PluginScope, Group[]>;
  toggleResource(item: Item): boolean | undefined;
  setProjectResourceOverride(item: Item, state: ProjectOverride): boolean;
  getProjectOverrideState(item: Item): ProjectOverride;
  getInheritedEnabled(item: Item): boolean;
}

type ConfigSelector = new (
  resolved: Record<PluginScope, unknown>,
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string,
  onClose: () => void,
  onExit: () => void,
  requestRender: () => void,
  terminalHeight: number,
  writeScope: PluginScope,
  projectModeAvailable: boolean,
) => { resourceList: ResourceList };

interface McpConfig {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
    servers: { name: string; scope?: string; source: string; config: { enabled?: boolean; url?: string; command?: string; args?: string[] } }[];
  };
  addMcpServerConfig(path: string, name: string, config: { url: string; headers?: Record<string, string> }): boolean;
  removeMcpServerConfig(path: string, name: string): boolean;
  updateMcpServerConfig(path: string, name: string, patch: { enabled?: boolean }): void;
}

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];
/** The global context files pi reads from its agent folder, any of which is your guide (loadContextFileFromDir). */
const GUIDES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** pi-gna's own folder name of a project's pi files (CONFIG_DIR_NAME in pi). */
const CONFIG_DIR = ".pi";

const root = process.argv[2] ?? "";
const load = (...parts: string[]) => import(pathToFileURL(join(root, "dist", ...parts)).href);

function reply(value: PluginsReply): void {
  writeSync(3, `${JSON.stringify(value)}\n`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

class Plugins {
  readonly agentDir: string;
  readonly cwd: string;
  /** cwd is a project (not the home folder) and pi trusts it. */
  readonly trusted: boolean;
  readonly isProject: boolean;
  /** Reads and writes ~/.pi/agent/settings.json only, as `pi config` does for its global list. */
  readonly global: SettingsManager;
  /** Reads the project's settings too when it is trusted. */
  readonly local: SettingsManager;

  readonly sdk: Sdk;
  readonly ConfigSelectorComponent: ConfigSelector;
  readonly builtins: string[];

  // No parameter properties: Node only strips types.
  constructor(sdk: Sdk, ConfigSelectorComponent: ConfigSelector, builtins: string[], cwd: string | undefined) {
    this.sdk = sdk;
    this.ConfigSelectorComponent = ConfigSelectorComponent;
    this.builtins = builtins;
    this.agentDir = sdk.getAgentDir();
    this.cwd = cwd ?? homedir();
    this.isProject = cwd !== undefined && cwd !== homedir();
    this.trusted = this.isProject && new sdk.ProjectTrustStore(this.agentDir).get(this.cwd) === true;
    this.global = sdk.SettingsManager.create(this.cwd, this.agentDir, { projectTrusted: false });
    this.local = this.trusted ? sdk.SettingsManager.create(this.cwd, this.agentDir, { projectTrusted: true }) : this.global;
  }

  packages(settings: SettingsManager): PackageManager {
    return new this.sdk.DefaultPackageManager({ cwd: this.cwd, agentDir: this.agentDir, settingsManager: settings, builtinExtensions: this.builtins });
  }

  /** `pi config`'s list, with its writes going to `scope`'s settings. Missing packages are skipped, never installed. */
  async list(scope: PluginScope, missing?: Set<string>): Promise<ResourceList> {
    const skip = async (source: string) => (missing?.add(source), "skip" as const);
    const global = await this.packages(this.global).resolve(skip);
    const project = this.trusted ? await this.packages(this.local).resolve(skip) : global;
    const selector = new this.ConfigSelectorComponent({ global, project }, this.local, this.cwd, this.agentDir, noop, noop, noop, 40, scope, this.trusted);
    return selector.resourceList;
  }

  async state(): Promise<PluginsState> {
    const missing = new Set<string>();
    const globalList = await this.list("global", missing);
    const views: PluginsState["views"] = { global: view("global", globalList) };
    if (this.trusted) views.project = view("project", await this.list("project", missing));
    const effective = views.project ?? views.global;
    const loaded = (test: (group: PluginGroup) => boolean, path?: string) =>
      effective.groups.some((group) => test(group) && group.resources.some((resource) => resource.enabled && (path === undefined || resource.path === path)));
    return {
      agentDir: this.agentDir,
      settingsPath: join(this.agentDir, "settings.json"),
      mcpPath: join(this.agentDir, "mcp.json"),
      ...(this.isProject && { project: { cwd: this.cwd, trusted: this.trusted } }),
      views,
      missing: this.packages(this.local)
        .listConfiguredPackages()
        .filter((pkg) => !pkg.installedPath || missing.has(pkg.source))
        .map(({ source, scope }) => ({ source, scope })),
      servers: await this.servers(),
      mcpAdapter: loaded((group) => group.kind === "package" && isAdapter(group.source)),
      builtinMcp: loaded((group) => group.kind === "builtin", "builtin:mcp"),
      defaults: this.defaults(),
    };
  }

  defaults(): RecommendedDefaults {
    return { codemode: codemode(this.global.getGlobalSettings().defaultTools), guide: GUIDES.some((name) => existsSync(join(this.agentDir, name))) };
  }

  /** The recommended setup: each of `sources` your settings lack (by npm name, any version), codemode on unless your
   * defaultTools name it, and pi-gna's guide as the global AGENTS.md unless you have one. Never replaces a choice. */
  async recommend(sources: string[], guide: string): Promise<void> {
    const configured = new Set(this.packages(this.global).listConfiguredPackages().map((pkg) => npmName(pkg.source)));
    for (const source of sources) if (!configured.has(npmName(source))) await this.install(source);
    const tools = this.global.getGlobalSettings().defaultTools;
    if (codemode(tools) === "unset") {
      setGlobal(this.global, "defaultTools", [...(Array.isArray(tools) ? tools : []), "+codemode"]);
      await this.global.flush();
    }
    if (this.defaults().guide) return;
    try {
      copyFileSync(guide, join(this.agentDir, "AGENTS.md"), constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async servers(): Promise<McpServerInfo[]> {
    const mcp = (await load("extensions", "mcp", "config.js")) as McpConfig;
    return mcp
      .loadMcpConfig({ agentDir: this.agentDir, cwd: this.cwd, projectTrusted: this.trusted })
      .servers.filter((server) => server.scope === "global" || server.scope === "project")
      .map((server) => ({
        name: server.name,
        scope: server.scope as "global" | "project",
        file: server.source,
        enabled: server.config.enabled !== false,
        target: server.config.url ?? [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(" "),
      }));
  }

  /** One resource on or off, as space does in `pi config` (the project view sets an override instead). */
  async toggle(toggle: PluginToggle): Promise<void> {
    if (toggle.scope === "project") this.needTrust();
    const list = await this.list(toggle.scope);
    const item = findItem(list, toggle.scope, (candidate) => candidate.path === toggle.path && candidate.resourceType === toggle.type);
    if (toggle.scope === "project") list.setProjectResourceOverride(item, toggle.override);
    else if (item.metadata.scope !== "user") throw new Error(`${item.displayName} is configured by the project`);
    else if (item.enabled !== toggle.enabled) list.toggleResource(item);
    await this.local.flush();
  }

  /** A whole package on or off. Personal: every resource type filtered to nothing (`[]`), or no filters at all. Project:
   * an override per resource, or none where the package already loads as wanted. */
  async togglePackage(toggle: PackageToggle): Promise<void> {
    if (toggle.scope === "project") {
      this.needTrust();
      const list = await this.list("project");
      const items = groupItems(list, "project", toggle.source, toggle.packageScope);
      for (const item of items) {
        const inherited = list.getInheritedEnabled(item);
        list.setProjectResourceOverride(item, toggle.enabled === inherited ? "inherit" : toggle.enabled ? "load" : "unload");
      }
      await this.local.flush();
      return;
    }
    if (toggle.packageScope !== "user") throw new Error("A project's package is turned on and off in the project view");
    const packages = [...(this.global.getGlobalSettings().packages ?? [])];
    const index = packages.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === toggle.source);
    const current = packages[index];
    if (current === undefined) throw new Error(`${toggle.source} is not in your settings`);
    const entry = typeof current === "string" ? { source: current } : { ...current };
    for (const type of RESOURCE_TYPES) {
      if (toggle.enabled) delete entry[type];
      else entry[type] = [];
    }
    packages[index] = Object.keys(entry).length === 1 ? entry.source : entry;
    this.global.setPackages(packages);
    await this.global.flush();
  }

  async install(source: string): Promise<void> {
    await this.packages(this.global).installAndPersist(source);
  }

  async remove(source: string, scope: "user" | "project"): Promise<void> {
    if (scope === "project") this.needTrust();
    if (!(await this.packages(scope === "project" ? this.local : this.global).removeAndPersist(source, { local: scope === "project" }))) throw new Error(`${source} is not in the settings`);
  }

  mcpFile(scope: "global" | "project"): string {
    if (scope === "global") return join(this.agentDir, "mcp.json");
    this.needTrust();
    return join(this.cwd, CONFIG_DIR, "mcp.json");
  }

  needTrust(): void {
    if (!this.trusted) throw new Error("pi does not trust this project, so it does not read its settings");
  }
}

function view(scope: PluginScope, list: ResourceList): PluginView {
  const groups = list.groupsByScope[scope]
    .filter((group) => group.scope !== "temporary")
    .map(
      (group): PluginGroup => ({
        key: group.key,
        kind: group.source === "builtin" ? "builtin" : group.origin === "package" ? "package" : "own",
        source: group.source,
        label: group.label,
        scope: group.scope === "project" ? "project" : "user",
        resources: group.subgroups.flatMap((subgroup) =>
          subgroup.items.map(
            (item): PluginResource => ({
              path: item.path,
              type: item.resourceType,
              name: item.displayName,
              enabled: item.enabled,
              ...(scope === "project" && { override: list.getProjectOverrideState(item) }),
            }),
          ),
        ),
      }),
    );
  return { scope, groups };
}

function findItem(list: ResourceList, scope: PluginScope, test: (item: Item) => boolean): Item {
  for (const group of list.groupsByScope[scope]) for (const subgroup of group.subgroups) for (const item of subgroup.items) if (test(item)) return item;
  throw new Error("pi no longer lists this resource; reload the page");
}

function groupItems(list: ResourceList, scope: PluginScope, source: string, packageScope: "user" | "project"): Item[] {
  const group = list.groupsByScope[scope].find((candidate) => candidate.origin === "package" && candidate.source === source && candidate.scope === packageScope);
  if (!group) throw new Error(`pi no longer lists ${source}; reload the page`);
  return group.subgroups.flatMap((subgroup) => subgroup.items);
}

/** pi-mcp-adapter by its npm name, or a local checkout of it. */
function isAdapter(source: string): boolean {
  if (/^npm:pi-mcp-adapter(@|$)/.test(source)) return true;
  try {
    return (JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { name?: unknown }).name === "pi-mcp-adapter";
  } catch {
    return false;
  }
}

/** What `defaultTools` says about codemode: `codemode` or `+codemode` add it, `-codemode` removes it. */
function codemode(defaultTools: unknown): RecommendedDefaults["codemode"] {
  const tools = Array.isArray(defaultTools) ? defaultTools.filter((tool): tool is string => typeof tool === "string") : [];
  if (tools.includes("-codemode")) return "off";
  return tools.includes("codemode") || tools.includes("+codemode") ? "on" : "unset";
}

/** The npm name of a source (`npm:@scope/name@1.2.3` → `@scope/name`), else the source (npmName in src/shared). */
function npmName(source: string): string {
  return /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/.exec(source.trim())?.[1] ?? source;
}

/** A global setting pi's SettingsManager has no setter for (defaultTools), written as its setters write theirs:
 * private at type level only, like the ResourceList parts above. */
function setGlobal(settings: SettingsManager, key: string, value: unknown): void {
  const internal = settings as unknown as { globalSettings?: Record<string, unknown>; markModified?(field: string): void; save?(): void };
  if (!internal.globalSettings || typeof internal.markModified !== "function" || typeof internal.save !== "function") {
    throw new Error(`This pi's settings cannot be changed from pi-gna; add "+codemode" to defaultTools in settings.json yourself`);
  }
  internal.globalSettings[key] = value;
  internal.markModified(key);
  internal.save();
}

function noop(): void {}

async function run(request: PluginsRequest): Promise<unknown> {
  const sdk = (await load("index.js")) as Sdk;
  const { ConfigSelectorComponent } = (await load("modes", "interactive", "components", "config-selector.js")) as { ConfigSelectorComponent: ConfigSelector };
  const { builtInExtensions } = (await load("extensions", "index.js")) as { builtInExtensions: unknown[] };
  const { isBuiltinExtension } = (await load("core", "resource-loader.js")) as { isBuiltinExtension(input: unknown): boolean };
  const builtins = builtInExtensions.filter(isBuiltinExtension).map((extension) => (extension as { name: string }).name);
  const plugins = new Plugins(sdk, ConfigSelectorComponent, builtins, "cwd" in request ? request.cwd : undefined);
  switch (request.op) {
    case "state":
      return plugins.state();
    case "toggle":
      return plugins.toggle(request.toggle);
    case "togglePackage":
      return plugins.togglePackage(request.toggle);
    case "install":
      return plugins.install(request.source);
    case "remove":
      return plugins.remove(request.source, request.scope);
    case "recommend":
      return plugins.recommend(request.sources, request.guide);
    case "mcpAdd": {
      const mcp = (await load("extensions", "mcp", "config.js")) as McpConfig;
      mcp.addMcpServerConfig(plugins.mcpFile("global"), request.name, { url: request.url, ...(request.headers && { headers: request.headers }) });
      return;
    }
    case "mcpRemove": {
      const mcp = (await load("extensions", "mcp", "config.js")) as McpConfig;
      if (!mcp.removeMcpServerConfig(plugins.mcpFile(request.scope), request.name)) throw new Error(`${request.name} is not in that mcp.json`);
      return;
    }
    case "mcpEnable": {
      const mcp = (await load("extensions", "mcp", "config.js")) as McpConfig;
      mcp.updateMcpServerConfig(plugins.mcpFile(request.scope), request.name, { enabled: request.enabled });
      return;
    }
    default:
      throw new Error(`unknown request ${JSON.stringify((request as { op?: unknown }).op)}`);
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => (input += chunk));
process.stdin.on("end", () => {
  let request: PluginsRequest;
  try {
    request = JSON.parse(input) as PluginsRequest;
  } catch {
    reply({ ok: false, error: "pi-gna sent pi's plugin helper a request it could not read" });
    return;
  }
  run(request).then(
    (value) => {
      reply({ ok: true, ...(value !== undefined && { value }) });
      process.exit(0);
    },
    (error: unknown) => {
      reply({ ok: false, error: message(error) });
      process.exit(0);
    },
  );
});
