// The Settings page's Plugins section: a catalog of connections and pi packages, and what pi has installed. pi-gna
// keeps no plugin list of its own: every change is written to pi's own files (settings.json's packages and resource
// filters, mcp.json), as `pi config`, `pi install` and `pi mcp add` write them, so pi in the terminal sees the same and
// chats started afterwards load it. main does the work (src/main/plugins.ts, resources/pi-plugins.mts); desktop only.

// ── The catalog ──────────────────────────────────────────────────────────────

/** A mark on its brand tile: an image as a data: URL (never a remote one), drawn at `scale` of the tile. */
export interface CatalogLogo {
  src: string;
  background: string;
  scale: number;
}

/** One way to reach an MCP server; a service with regions has one per region. */
export interface CatalogEndpoint {
  id: string;
  label: string;
  url: string;
}

interface CatalogBase {
  id: string;
  name: string;
  publisher: string;
  description: string;
  homepage: string;
  logo?: CatalogLogo;
  /** A lucide icon the renderer draws when there is no logo. */
  icon?: CatalogIcon;
}

/** A remote MCP server, added to pi's global mcp.json under `server`. */
export interface CatalogConnection extends CatalogBase {
  kind: "mcp";
  server: string;
  endpoints: CatalogEndpoint[];
  /** oauth: `pi mcp login` signs in in the browser. key: a token you paste, kept in the macOS Keychain. */
  auth: CatalogAuth;
}

export type CatalogAuth = { type: "oauth" } | { type: "key"; label: string; help: string; url: string };

/** A pi package at a pinned version, installed as `pi install` does. */
export interface CatalogPackage extends CatalogBase {
  kind: "package";
  source: string;
}

export type CatalogEntry = CatalogConnection | CatalogPackage;

export interface Catalog {
  version: 1;
  entries: CatalogEntry[];
}

export const CATALOG_ICONS = ["globe", "image", "package"] as const;
export type CatalogIcon = (typeof CATALOG_ICONS)[number];

/** Where the catalog came from: fetched now, the copy fetched last time, or the one this build ships. */
export type CatalogOrigin = "remote" | "cache" | "bundled";

export interface CatalogState {
  catalog: Catalog;
  origin: CatalogOrigin;
}

/** An npm source pinned to an exact version: `npm:name@1.2.3` or `npm:@scope/name@1.2.3`. */
const PINNED_NPM = /^npm:((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGO_SRC = /^data:image\/(?:svg\+xml|png);base64,[A-Za-z0-9+/]+=*$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** The catalog, checked: anything malformed throws, so a bad remote copy falls back to the cached or bundled one. */
export function parseCatalog(raw: unknown): Catalog {
  const value = record(raw, "catalog");
  if (value.version !== 1) throw new Error(`unknown catalog version ${String(value.version)}`);
  if (!Array.isArray(value.entries)) throw new Error("catalog: entries is not a list");
  const entries = value.entries.map(parseEntry);
  const ids = new Set<string>();
  const servers = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`catalog: ${entry.id} is listed twice`);
    ids.add(entry.id);
    if (entry.kind !== "mcp") continue;
    if (servers.has(entry.server)) throw new Error(`catalog: server ${entry.server} is listed twice`);
    servers.add(entry.server);
  }
  return { version: 1, entries };
}

function parseEntry(raw: unknown, index: number): CatalogEntry {
  const value = record(raw, `catalog entry ${index}`);
  const id = text(value.id, "id");
  if (!ID.test(id)) throw new Error(`catalog: bad id ${JSON.stringify(id)}`);
  const at = (what: string) => `catalog entry ${id}: ${what}`;
  const base: CatalogBase = {
    id,
    name: text(value.name, at("name")),
    publisher: text(value.publisher, at("publisher")),
    description: text(value.description, at("description")),
    homepage: https(value.homepage, at("homepage")),
    ...(value.logo !== undefined && { logo: parseLogo(value.logo, at("logo")) }),
    ...(value.icon !== undefined && { icon: oneOf(value.icon, CATALOG_ICONS, at("icon")) }),
  };
  if (value.kind === "package") {
    const source = text(value.source, at("source"));
    if (!PINNED_NPM.test(source)) throw new Error(at(`source ${JSON.stringify(source)} is not an npm package at an exact version`));
    return { ...base, kind: "package", source };
  }
  if (value.kind !== "mcp") throw new Error(at(`unknown kind ${JSON.stringify(value.kind)}`));
  const server = text(value.server, at("server"));
  if (!SERVER_NAME.test(server)) throw new Error(at(`bad server name ${JSON.stringify(server)}`));
  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) throw new Error(at("no endpoints"));
  const endpoints = value.endpoints.map((endpoint: unknown) => {
    const item = record(endpoint, at("endpoint"));
    return { id: text(item.id, at("endpoint id")), label: text(item.label, at("endpoint label")), url: https(item.url, at("endpoint url")) };
  });
  const auth = record(value.auth, at("auth"));
  return {
    ...base,
    kind: "mcp",
    server,
    endpoints,
    auth:
      auth.type === "oauth"
        ? { type: "oauth" }
        : auth.type === "key"
          ? { type: "key", label: text(auth.label, at("auth label")), help: text(auth.help, at("auth help")), url: https(auth.url, at("auth url")) }
          : (() => {
              throw new Error(at(`unknown auth ${JSON.stringify(auth.type)}`));
            })(),
  };
}

function parseLogo(raw: unknown, what: string): CatalogLogo {
  const value = record(raw, what);
  const src = text(value.src, what);
  if (!LOGO_SRC.test(src)) throw new Error(`${what} is not a base64 SVG or PNG data: URL`);
  const background = text(value.background, what);
  if (!COLOR.test(background)) throw new Error(`${what}: background is not a #rrggbb color`);
  const scale = value.scale;
  if (typeof scale !== "number" || !(scale > 0 && scale <= 1)) throw new Error(`${what}: scale is not in (0, 1]`);
  return { src, background, scale };
}

function record(raw: unknown, what: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${what} is not an object`);
  return raw as Record<string, unknown>;
}

function text(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${what} is missing`);
  return raw;
}

function https(raw: unknown, what: string): string {
  const value = text(raw, what);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${what} is not an https URL`);
  return value;
}

function oneOf<T extends string>(raw: unknown, values: readonly T[], what: string): T {
  if (!values.includes(raw as T)) throw new Error(`${what}: unknown ${JSON.stringify(raw)}`);
  return raw as T;
}

/** The package name of an npm source (`npm:name@1.2.3` → `name`), else undefined. */
export function npmName(source: string): string | undefined {
  const match = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/.exec(source.trim());
  return match?.[1];
}

/** The catalog package a configured source installs, compared by npm name (any version). */
export function samePackage(source: string, entry: CatalogPackage): boolean {
  const name = npmName(source);
  return name !== undefined && name === npmName(entry.source);
}

// ── What pi has ─────────────────────────────────────────────────────────────

export const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Personal: ~/.pi/agent/settings.json. Project: the project's .pi/settings.json, which overrides it there. */
export type PluginScope = "global" | "project";

/** In the project view, what the project's settings say about a resource: nothing (it inherits), load, or unload. */
export type ProjectOverride = "inherit" | "load" | "unload";

export interface PluginResource {
  /** pi's path for it (`builtin:codemode` for a built-in). */
  path: string;
  type: ResourceType;
  name: string;
  /** Loaded in this view. */
  enabled: boolean;
  /** Project view only. */
  override?: ProjectOverride;
}

/** One group of `pi config`: a package, the resources of a settings file or folder, or pi's built-ins. */
export interface PluginGroup {
  key: string;
  /** package: an installed package. own: your own extensions, skills and prompts. builtin: pi's built-in extensions. */
  kind: "package" | "own" | "builtin";
  /** The package source, or a label for the others. */
  source: string;
  label: string;
  /** Where it is configured: user (global) or project. */
  scope: "user" | "project";
  resources: PluginResource[];
}

export interface PluginView {
  scope: PluginScope;
  groups: PluginGroup[];
}

/** A server of an mcp.json, as pi reads it. */
export interface McpServerInfo {
  name: string;
  scope: "global" | "project";
  /** The mcp.json that defines it. */
  file: string;
  enabled: boolean;
  /** Its URL, or its command. */
  target: string;
}

export interface PluginsState {
  agentDir: string;
  /** ~/.pi/agent/settings.json */
  settingsPath: string;
  /** ~/.pi/agent/mcp.json */
  mcpPath: string;
  /** The project the project view is of; absent without one. `trusted` false: pi does not read its settings. */
  project?: { cwd: string; trusted: boolean };
  views: { global: PluginView; project?: PluginView };
  /** Packages in the settings that are not installed (pi installs them when a chat starts). */
  missing: { source: string; scope: "user" | "project" }[];
  servers: McpServerInfo[];
  /** pi-mcp-adapter is loaded, which reads mcp.json too and signs in with its own /mcp-auth. */
  mcpAdapter: boolean;
  /** pi's own MCP support (builtin:mcp) is loaded. */
  builtinMcp: boolean;
  /** Set when pi's state cannot be read; the rest is then empty. */
  error?: string;
}

export const emptyPluginsState = (error: string): PluginsState => ({
  agentDir: "",
  settingsPath: "",
  mcpPath: "",
  views: { global: { scope: "global", groups: [] } },
  missing: [],
  servers: [],
  mcpAdapter: false,
  builtinMcp: false,
  error,
});

/** A server's state as `pi mcp list` reports it. */
export type McpState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed" | "disabled";

export interface McpStatus {
  state: McpState;
  tools: number;
  error?: string;
}

/** By server name; `error` when pi could not be asked. */
export interface McpStatusState {
  servers: Record<string, McpStatus>;
  error?: string;
}

// ── Changes ─────────────────────────────────────────────────────────────────

/** A change to what pi loads, by the resource's path in one view. */
export type PluginToggle =
  | { scope: "global"; path: string; type: ResourceType; enabled: boolean }
  | { scope: "project"; path: string; type: ResourceType; override: ProjectOverride };

/** A whole package on or off in one view. */
export interface PackageToggle {
  scope: PluginScope;
  source: string;
  /** Where the package is configured. */
  packageScope: "user" | "project";
  enabled: boolean;
}

/** A sign-in of `pi mcp login`, pushed to the window while it runs. */
export type McpLoginUpdate = { server: string; url: string };

export interface McpLoginResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
}

/** The helper's requests (resources/pi-plugins.mts); one per run. */
export type PluginsRequest =
  | { op: "state"; cwd?: string }
  | { op: "toggle"; cwd?: string; toggle: PluginToggle }
  | { op: "togglePackage"; cwd?: string; toggle: PackageToggle }
  | { op: "install"; cwd?: string; source: string }
  | { op: "remove"; cwd?: string; source: string; scope: "user" | "project" }
  | { op: "mcpAdd"; name: string; url: string; headers?: Record<string, string> }
  | { op: "mcpRemove"; cwd?: string; name: string; scope: "global" | "project" }
  | { op: "mcpEnable"; cwd?: string; name: string; scope: "global" | "project"; enabled: boolean };

export type PluginsReply = { ok: true; value?: unknown } | { ok: false; error: string };

/** A pi package's name for people: the npm name, or the last part of a git URL or path. */
export function packageLabel(source: string): string {
  const name = npmName(source);
  if (name) return name;
  const trimmed = source.replace(/^git:/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return trimmed.split("/").at(-1) || source;
}
