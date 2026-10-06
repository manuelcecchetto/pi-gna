// The Settings page's Plugins section: connect MCP servers and install pi packages from a short catalog (Discover),
// turn pi's packages and resources on and off for you or for this project (Installed), and pi's built-in extensions
// (Built-in). pi-gna keeps no plugin list: main writes pi's settings.json and mcp.json with pi's own code
// (src/main/plugins.ts), so `pi config` in the terminal shows the same, and chats started afterwards load it.
import { Blocks, Check, ChevronRight, ExternalLink, Globe, Image, LoaderCircle, type IconComponent, Package, Plug, RotateCcw, Search, TriangleAlert, X } from "./icons";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeText } from "./CodeText";
import {
  type CatalogConnection,
  type CatalogEntry,
  type CatalogIcon,
  type CatalogLogo,
  type CatalogPackage,
  type CatalogState,
  emptyPluginsState,
  type McpLoginUpdate,
  type McpStatus,
  type McpStatusState,
  type McpServerInfo,
  packageLabel,
  type PluginGroup,
  type PluginResource,
  type PluginScope,
  type PluginsState,
  type PluginView,
  type ProjectOverride,
  RESOURCE_TYPES,
  type ResourceType,
  samePackage,
} from "../../../shared/plugins";
import { tildify } from "../lib/format";
import { remoteError, toast } from "../state/app";
import { Switch } from "./primitives";
import { CopyButton, host } from "./Providers";
import { Button, ConfirmButton, Segmented } from "./SettingsControls";

type Tab = "discover" | "installed" | "builtin";
const TABS: readonly Tab[] = ["discover", "installed", "builtin"];
const TAB_LABELS: Record<Tab, string> = { discover: "Discover", installed: "Installed", builtin: "Built-in" };
const SCOPES: readonly PluginScope[] = ["global", "project"];
const SCOPE_LABELS: Record<PluginScope, string> = { global: "Personal", project: "This project" };

/** `simple`: only the app connections, in plain words (Setup, for the non-technical). */
export function PluginsSection({ cwd, simple = false }: { cwd: string; simple?: boolean }) {
  const project = cwd && cwd !== window.studio.homeDir ? cwd : undefined;
  const plugins = usePlugins(project);
  const [tab, setTab] = useState<Tab>("discover");
  const [scope, setScope] = useState<PluginScope>("global");
  const [query, setQuery] = useState("");
  const { state } = plugins;
  const view = (scope === "project" && state?.views.project) || state?.views.global;

  if (!state || !plugins.catalog) {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-faint">
        <LoaderCircle size={13} className="animate-spin" /> Asking pi what it has installed…
      </p>
    );
  }
  if (state.error) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[12.5px] text-fg">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="selectable break-words">
            <CodeText text={state.error} />
          </p>
          <p className="mt-1 text-muted">pi-gna changes plugins with the pi on your PATH, the one its chats run.</p>
        </div>
        <Button onClick={plugins.reload}>Try again</Button>
      </div>
    );
  }
  if (simple) return <Discover plugins={plugins} query="" onManage={() => undefined} simple />;
  return (
    <>
      <div className="flex items-center gap-3">
        <Segmented value={tab} options={TABS} labels={TAB_LABELS} onChange={setTab} />
        <div className="flex-1" />
        {tab === "discover" ? (
          <SearchField value={query} onChange={setQuery} />
        ) : state.views.project ? (
          <Segmented value={scope} options={SCOPES} labels={SCOPE_LABELS} onChange={setScope} />
        ) : (
          state.project && (
            <span className="text-[12px] text-faint" title="pi reads a project's .pi/settings.json once you trust the project, when pi asks in a chat">
              pi does not trust this project yet
            </span>
          )
        )}
      </div>
      {tab === "discover" ? (
        <Discover plugins={plugins} query={query} onManage={() => setTab("installed")} />
      ) : view ? (
        <>
          <ScopeNote state={state} scope={view.scope} />
          {tab === "installed" ? <Installed plugins={plugins} view={view} /> : <BuiltIn plugins={plugins} view={view} />}
        </>
      ) : null}
    </>
  );
}

// ── State ────────────────────────────────────────────────────────────────────

interface Plugins {
  cwd?: string;
  catalog?: CatalogState;
  state?: PluginsState;
  status?: McpStatusState;
  /** The change running, by key (a resource, a package, a server or a catalog entry). */
  busy: string | null;
  reload(): void;
  reloadStatus(): void;
  /** Runs one change with `key` busy, then reads pi's state again; a failure is a toast. Resolves true when it worked. */
  run(key: string, change: () => Promise<unknown>, done?: string): Promise<boolean>;
  /** Shows a resource's new state before pi's state is read again. */
  patch(scope: PluginScope, test: (group: PluginGroup, resource: PluginResource) => boolean, changes: Partial<PluginResource>): void;
}

/** What pi has, read again when you come back to the window (you may have run `pi config` in a terminal). */
function usePlugins(cwd: string | undefined): Plugins {
  const [catalog, setCatalog] = useState<CatalogState>();
  const [state, setState] = useState<PluginsState>();
  const [status, setStatus] = useState<McpStatusState>();
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => {
    void window.studio.plugins.state(cwd).then(setState, (error: unknown) => setState(emptyPluginsState(remoteError(error))));
  }, [cwd]);
  const reloadStatus = useCallback(() => {
    void window.studio.plugins.status(cwd).then(setStatus, (error: unknown) => setStatus({ servers: {}, error: remoteError(error) }));
  }, [cwd]);
  useEffect(() => {
    void window.studio.plugins.catalog().then(setCatalog, (error: unknown) => toast(`Could not read the plugin catalog: ${remoteError(error)}`, "error"));
  }, []);
  useEffect(() => {
    reload();
    reloadStatus();
    const onFocus = () => {
      reload();
      reloadStatus();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload, reloadStatus]);
  const run = useCallback(
    async (key: string, change: () => Promise<unknown>, done?: string) => {
      setBusy(key);
      try {
        await change();
        if (done) toast(done);
        return true;
      } catch (error) {
        toast(remoteError(error), "error");
        return false;
      } finally {
        setBusy(null);
        reload();
      }
    },
    [reload],
  );
  const patch = useCallback((scope: PluginScope, test: (group: PluginGroup, resource: PluginResource) => boolean, changes: Partial<PluginResource>) => {
    setState((current) => {
      const view = current?.views[scope];
      if (!current || !view) return current;
      const groups = view.groups.map((group) => ({ ...group, resources: group.resources.map((resource) => (test(group, resource) ? { ...resource, ...changes } : resource)) }));
      return { ...current, views: { ...current.views, [scope]: { ...view, groups } } };
    });
  }, []);
  return { cwd, catalog, state, status, busy, reload, reloadStatus, run, patch };
}

/** Where a change in this view is saved. */
function ScopeNote({ state, scope }: { state: PluginsState; scope: PluginScope }) {
  const home = window.studio.homeDir;
  return (
    <p className="-mt-3 text-[12px] leading-relaxed text-faint">
      {scope === "global" ? (
        <>
          Saved in pi's <span className="font-mono text-muted">{tildify(state.settingsPath, home)}</span> and <span className="font-mono text-muted">{tildify(state.mcpPath, home)}</span>, which pi in the terminal uses
          too. Chats you start afterwards load the changes.
        </>
      ) : (
        <>
          Saved in <span className="font-mono text-muted">{tildify(`${state.project?.cwd ?? ""}/.pi/settings.json`, home)}</span>, for chats in this project only. A switch that differs from your
          personal setting is marked <ProjectTag />.
        </>
      )}
    </p>
  );
}

// ── Discover ─────────────────────────────────────────────────────────────────

function Discover({ plugins, query, onManage, simple = false }: { plugins: Plugins; query: string; onManage: () => void; simple?: boolean }) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const entries = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (plugins.catalog?.catalog.entries ?? []).filter((entry) => {
      const text = `${entry.name} ${entry.publisher} ${entry.description} ${entry.kind === "mcp" ? "mcp connection server" : "package"}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [plugins.catalog, query]);
  const connections = entries.filter((entry): entry is CatalogConnection => entry.kind === "mcp");
  const packages = entries.filter((entry): entry is CatalogPackage => entry.kind === "package");
  const state = plugins.state as PluginsState;
  const added = (entry: CatalogEntry) =>
    entry.kind === "mcp"
      ? state.servers.some((server) => server.name === entry.server)
      : [...state.views.global.groups.map((group) => group.source), ...state.missing.map((pkg) => pkg.source)].some((source) => samePackage(source, entry));
  const close = useCallback(() => setConnecting(null), []);

  if (!entries.length) return <p className="text-[12.5px] text-faint">Nothing in the catalog matches “{query}”.</p>;
  return (
    <>
      {connections.length > 0 && (
        <section>
          <h2 className="mb-1 text-[13px] font-medium text-fg">{simple ? "Apps" : "Connections"}</h2>
          <p className="mb-2.5 text-[12px] leading-relaxed text-faint">
            {simple ? "Connect one and pi can read and update it in new chats." : "MCP servers of apps you use, added to pi's mcp.json. Their tools reach chats you start afterwards."}
          </p>
          <CardGrid
            entries={connections}
            panelFor={connecting}
            renderCard={(entry) => (
              <CatalogCard
                entry={entry}
                active={connecting === entry.id}
                added={added(entry)}
                busy={plugins.busy !== null || connecting !== null}
                onAction={() => setConnecting(entry.id)}
                onManage={onManage}
                simple={simple}
              />
            )}
            renderPanel={(entry) => <ConnectPanel plugins={plugins} entry={entry} onClose={close} />}
          />
        </section>
      )}
      {packages.length > 0 && !simple && (
        <section>
          <h2 className="mb-1 text-[13px] font-medium text-fg">Packages</h2>
          <p className="mb-2.5 text-[12px] leading-relaxed text-faint">
            pi packages at a version pi-gna has checked, installed with npm the way <Code>pi install</Code> does. A package runs code on this Mac.
          </p>
          <CardGrid
            entries={packages}
            panelFor={null}
            renderCard={(entry) => (
              <CatalogCard
                entry={entry}
                active={plugins.busy === `install:${entry.id}`}
                added={added(entry)}
                busy={plugins.busy !== null}
                onAction={() => void plugins.run(`install:${entry.id}`, () => window.studio.plugins.install(entry.id), `Installed ${entry.name}. Chats you start now load it.`)}
                onManage={onManage}
              />
            )}
          />
        </section>
      )}
    </>
  );
}

/** Two cards a row; a card's panel opens under its row. */
function CardGrid<T extends CatalogEntry>({ entries, panelFor, renderCard, renderPanel }: { entries: T[]; panelFor: string | null; renderCard: (entry: T) => React.ReactNode; renderPanel?: (entry: T) => React.ReactNode }) {
  const active = entries.findIndex((entry) => entry.id === panelFor);
  const after = active === -1 ? -1 : Math.min(active + 1 - (active % 2), entries.length - 1);
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {entries.map((entry, index) => (
        <Fragment key={entry.id}>
          {renderCard(entry)}
          {index === after && renderPanel && <div className="col-span-2">{renderPanel(entries[active] as T)}</div>}
        </Fragment>
      ))}
    </div>
  );
}

function CatalogCard({
  entry,
  active,
  added,
  busy,
  onAction,
  onManage,
  simple = false,
}: {
  entry: CatalogEntry;
  active: boolean;
  added: boolean;
  busy: boolean;
  onAction: () => void;
  onManage: () => void;
  simple?: boolean;
}) {
  const installing = entry.kind === "package" && active;
  return (
    <div className={`flex flex-col gap-2 rounded-xl border p-3 transition-colors ${active ? "border-line-strong bg-raised/50" : "border-line"}`}>
      <div className="flex items-center gap-3">
        <PluginLogo logo={entry.logo} icon={entry.icon} name={entry.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-fg">{entry.name}</div>
          <div className="truncate text-[12px] text-faint" title={entry.kind === "package" ? entry.source : undefined}>
            {entry.kind === "mcp"
              ? simple
                ? entry.auth.type === "key"
                  ? "Needs an access key"
                  : "Sign in with your account"
                : entry.auth.type === "key"
                  ? "MCP server · token"
                  : "MCP server · sign in"
              : `pi package · ${entry.publisher}`}
          </div>
        </div>
        {added && simple ? (
          <span className="flex shrink-0 items-center gap-1 px-1.5 py-1 text-[12px] text-muted">
            <Check size={12} className="text-ok" /> Connected
          </span>
        ) : added ? (
          <button type="button" onClick={onManage} title="Show it under Installed" className="flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-[12px] text-muted hover:bg-raised hover:text-fg">
            <Check size={12} className="text-ok" /> {entry.kind === "mcp" ? "Added" : "Installed"}
          </button>
        ) : (
          <Button disabled={busy} onClick={onAction}>
            {installing ? (
              <>
                <LoaderCircle size={12} className="animate-spin" /> Installing…
              </>
            ) : entry.kind === "mcp" ? (
              "Connect"
            ) : (
              "Install"
            )}
          </Button>
        )}
      </div>
      <p className="line-clamp-2 text-[12px] leading-relaxed text-muted">{entry.description}</p>
      {!simple && (
        <button type="button" onClick={() => window.studio.openExternal(entry.homepage)} className="flex w-fit items-center gap-1 text-[11.5px] text-faint hover:text-fg">
          {host(entry.homepage)} <ExternalLink size={10} />
        </button>
      )}
    </div>
  );
}

type ConnectStep = { step: "form" } | { step: "adding" } | { step: "signing"; url?: string } | { step: "error"; error: string };

/** Adds a catalog connection to mcp.json, then signs in to it with `pi mcp login` (or saves its token). */
function ConnectPanel({ plugins, entry, onClose }: { plugins: Plugins; entry: CatalogConnection; onClose: () => void }) {
  const [endpoint, setEndpoint] = useState(entry.endpoints[0]?.id ?? "");
  const [token, setToken] = useState("");
  const [step, setStep] = useState<ConnectStep>({ step: "form" });
  const { state } = plugins;
  // With pi-mcp-adapter, chats connect through the adapter, which keeps its own sign-ins.
  const adapter = state?.mcpAdapter === true;
  const key = entry.auth.type === "key" ? entry.auth : undefined;
  const signing = useRef(false);
  const cancel = useCallback(() => {
    if (signing.current) window.studio.plugins.cancelLogin();
    signing.current = false;
    onClose();
  }, [onClose]);
  useEffect(() => () => void (signing.current && window.studio.plugins.cancelLogin()), []);
  useEffect(() => window.studio.plugins.onLogin((update: McpLoginUpdate) => update.server === entry.server && setStep((current) => (current.step === "signing" ? { step: "signing", url: update.url } : current))), [entry.server]);

  const connect = async () => {
    setStep({ step: "adding" });
    try {
      await window.studio.plugins.connect(entry.id, endpoint, key ? token : undefined);
    } catch (error) {
      setStep({ step: "error", error: remoteError(error) });
      return;
    }
    plugins.reload();
    if (key || adapter) {
      toast(key ? `Connected ${entry.name}. Chats you start now can use its tools.` : `Added ${entry.name} to mcp.json. Sign in with /mcp-auth ${entry.server} in a chat.`);
      plugins.reloadStatus();
      onClose();
      return;
    }
    setStep({ step: "signing" });
    signing.current = true;
    const result = await window.studio.plugins.login(plugins.cwd, entry.server).catch((error: unknown) => ({ ok: false as const, cancelled: false, error: remoteError(error) }));
    if (!signing.current) return;
    signing.current = false;
    plugins.reloadStatus();
    if (result.ok) {
      toast(`Connected ${entry.name}. Chats you start now can use its tools.`);
      onClose();
    } else if (result.cancelled) onClose();
    else setStep({ step: "error", error: `${result.error ?? "The sign-in failed"}. ${entry.name} stays in mcp.json; sign in again under Installed.` });
  };

  return (
    <Panel title={`Connect ${entry.name}`} logo={<PluginLogo logo={entry.logo} icon={entry.icon} name={entry.name} size={22} />} onCancel={cancel}>
      {step.step === "form" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!key || token.trim()) void connect();
          }}
        >
          {entry.endpoints.length > 1 && (
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[12.5px] text-fg">Where your {entry.name} workspace is hosted</span>
              <Segmented value={endpoint} options={entry.endpoints.map((option) => option.id)} labels={Object.fromEntries(entry.endpoints.map((option) => [option.id, option.label]))} onChange={setEndpoint} />
            </div>
          )}
          {key ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[12.5px] leading-relaxed text-muted">
                {key.help}{" "}
                <button type="button" onClick={() => window.studio.openExternal(key.url)} className="text-accent hover:underline">
                  Open {host(key.url)}
                </button>
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  placeholder={key.label}
                  onChange={(event) => setToken(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-line-strong"
                />
                <SubmitButton disabled={!token.trim()}>Connect</SubmitButton>
              </div>
              <p className="text-[12px] text-faint">Kept in your macOS Keychain; mcp.json only names the Keychain item.</p>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">
                {adapter
                  ? `Adds ${entry.name} to mcp.json. pi-mcp-adapter keeps its own sign-ins: run /mcp-auth ${entry.server} in a chat afterwards.`
                  : `Adds ${entry.name} to mcp.json, then pi opens ${entry.name}'s sign-in page in your browser.`}
              </p>
              <SubmitButton autoFocus>{adapter ? "Add" : "Continue"}</SubmitButton>
            </div>
          )}
        </form>
      )}
      {step.step === "adding" && <Waiting text="Adding it to mcp.json…" />}
      {step.step === "signing" && <SigningIn url={step.url} />}
      {step.step === "error" && <ErrorBox error={step.error} onClose={onClose} />}
    </Panel>
  );
}

// ── Installed ────────────────────────────────────────────────────────────────

function Installed({ plugins, view }: { plugins: Plugins; view: PluginView }) {
  const state = plugins.state as PluginsState;
  const packages = view.groups.filter((group) => group.kind === "package");
  const own = view.groups.filter((group) => group.kind === "own");
  return (
    <>
      <Connections plugins={plugins} />
      <section>
        <h2 className="mb-2 text-[13px] font-medium text-fg">Packages</h2>
        {state.missing.length > 0 && (
          <div className="mb-2.5 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[12.5px]">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
            <p className="min-w-0 flex-1 text-muted">
              Not installed yet: <span className="font-mono text-[12px] text-fg">{state.missing.map((pkg) => pkg.source).join(", ")}</span>. pi installs {state.missing.length === 1 ? "it" : "them"} when a chat starts.
            </p>
          </div>
        )}
        {packages.length ? (
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {packages.map((group) => (
              <GroupRow key={group.key} plugins={plugins} view={view} group={group} />
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-faint">
            No packages. Install one under Discover, or with <Code>pi install</Code> in a terminal.
          </p>
        )}
      </section>
      {own.length > 0 && (
        <section>
          <h2 className="mb-1 text-[13px] font-medium text-fg">Your own</h2>
          <p className="mb-2 text-[12px] leading-relaxed text-faint">Extensions, skills and prompts in pi's folders and settings, outside any package.</p>
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {own.map((group) => (
              <GroupRow key={group.key} plugins={plugins} view={view} group={group} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Connections({ plugins }: { plugins: Plugins }) {
  const state = plugins.state as PluginsState;
  const [signingIn, setSigningIn] = useState<{ server: string; url?: string; error?: string } | null>(null);
  const running = useRef<string | null>(null);
  useEffect(() => window.studio.plugins.onLogin((update) => setSigningIn((current) => (current?.server === update.server ? { ...current, url: update.url } : current))), []);
  useEffect(() => () => void (running.current && window.studio.plugins.cancelLogin()), []);
  const cancel = useCallback(() => {
    if (running.current) window.studio.plugins.cancelLogin();
    running.current = null;
    setSigningIn(null);
  }, []);
  const signIn = async (server: string) => {
    running.current = server;
    setSigningIn({ server });
    const result = await window.studio.plugins.login(plugins.cwd, server).catch((error: unknown) => ({ ok: false as const, cancelled: false, error: remoteError(error) }));
    if (running.current !== server) return;
    running.current = null;
    plugins.reloadStatus();
    if (result.ok) {
      toast(`Signed in to ${server}. Chats you start now can use its tools.`);
      setSigningIn(null);
    } else if (result.cancelled) setSigningIn(null);
    else setSigningIn({ server, error: result.error ?? "The sign-in failed" });
  };
  const change = (key: string, work: () => Promise<unknown>, done?: string) =>
    void plugins.run(key, work, done).then(() => plugins.reloadStatus());

  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="flex-1 text-[13px] font-medium text-fg">Connections</h2>
        {plugins.status?.error && (
          <span className="flex items-center gap-1.5 text-[12px] text-warn" title={plugins.status.error}>
            <TriangleAlert size={12} /> No status from pi
          </span>
        )}
      </div>
      {state.mcpAdapter && (
        <div className="mb-2.5 flex items-start gap-2.5 rounded-lg border border-line bg-sunken/60 px-3 py-2 text-[12.5px]">
          <Plug size={14} className="mt-0.5 shrink-0 text-muted" />
          <p className="min-w-0 flex-1 leading-relaxed text-muted">
            pi-mcp-adapter is installed, so chats reach these servers through it, and it keeps its own sign-ins: run <span className="font-mono text-[12px] text-fg">/mcp-auth</span> in a chat. The
            status here is pi's own connection.
          </p>
        </div>
      )}
      {state.servers.length ? (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {state.servers.map((server) => {
            const entry = plugins.catalog?.catalog.entries.find((candidate): candidate is CatalogConnection => candidate.kind === "mcp" && candidate.server === server.name);
            const key = `server:${server.scope}:${server.name}`;
            return (
              <div key={key}>
                <ServerRow
                  server={server}
                  entry={entry}
                  status={plugins.status ? (plugins.status.servers[server.name] ?? null) : undefined}
                  busy={plugins.busy === key}
                  canSignIn={!state.mcpAdapter && signingIn === null}
                  onSignIn={() => void signIn(server.name)}
                  onEnable={(enabled) => change(key, () => window.studio.plugins.enableServer(plugins.cwd, server.name, server.scope, enabled))}
                  onRemove={() => change(key, () => window.studio.plugins.disconnect(plugins.cwd, server.name, server.scope), `Removed ${entry?.name ?? server.name} from mcp.json`)}
                />
                {signingIn?.server === server.name && (
                  <div className="px-3 pb-3">
                    <Panel title={`Sign in to ${entry?.name ?? server.name}`} logo={<PluginLogo logo={entry?.logo} icon={entry?.icon} name={server.name} size={22} />} onCancel={cancel}>
                      {signingIn.error ? <ErrorBox error={signingIn.error} onClose={cancel} /> : <SigningIn url={signingIn.url} />}
                    </Panel>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[12.5px] text-faint">
          No MCP servers. Connect one under Discover, or with <Code>pi mcp add</Code> in a terminal.
        </p>
      )}
    </section>
  );
}

/** `status` undefined: still asking pi; null: pi did not report the server. */
function ServerRow({
  server,
  entry,
  status,
  busy,
  canSignIn,
  onSignIn,
  onEnable,
  onRemove,
}: {
  server: McpServerInfo;
  entry?: CatalogConnection;
  status: McpStatus | null | undefined;
  busy: boolean;
  canSignIn: boolean;
  onSignIn: () => void;
  onEnable: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const shown = server.enabled ? status : ({ state: "disabled", tools: 0 } as const);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <PluginLogo logo={entry?.logo} icon={entry ? entry.icon : "plug"} name={server.name} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] text-fg">{entry?.name ?? server.name}</span>
          {server.scope === "project" && <ProjectTag />}
        </div>
        <div className="truncate font-mono text-[11.5px] text-faint" title={server.target}>
          {/^https?:/.test(server.target) ? host(server.target) : tildify(server.target, window.studio.homeDir)}
        </div>
      </div>
      <ServerStatus status={shown} />
      {server.enabled && shown?.state === "needs-auth" && canSignIn && (
        <Button primary onClick={onSignIn}>
          Sign in
        </Button>
      )}
      <ConfirmButton label="Remove" confirm="Remove?" title={`Remove ${server.name} from ${tildify(server.file, window.studio.homeDir)}`} onConfirm={onRemove} />
      <Switch on={server.enabled} disabled={busy} title={server.enabled ? "Turn off: pi stops connecting to it" : "Turn on"} onChange={onEnable} />
    </div>
  );
}

const STATUS_TEXT: Record<McpStatus["state"], string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  "needs-auth": "Needs sign-in",
  failed: "Failed",
  closed: "Closed",
  disabled: "Off",
};

function ServerStatus({ status }: { status: McpStatus | null | undefined }) {
  if (status === undefined) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-faint">
        <LoaderCircle size={11} className="animate-spin" /> Checking
      </span>
    );
  }
  if (status === null) return null;
  const tone = status.state === "connected" ? "bg-ok" : status.state === "needs-auth" ? "bg-warn" : status.state === "failed" ? "bg-bad" : "bg-line-strong";
  const text = status.state === "connected" ? `${status.tools} tool${status.tools === 1 ? "" : "s"}` : STATUS_TEXT[status.state];
  return (
    <span className={`flex max-w-40 shrink-0 items-center gap-1.5 text-[12px] ${status.state === "disabled" ? "text-faint" : "text-muted"}`} title={status.error ?? STATUS_TEXT[status.state]}>
      <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />
      <span className="truncate">{text}</span>
    </span>
  );
}

const TYPE_LABELS: Record<ResourceType, [string, string]> = {
  extensions: ["extension", "extensions"],
  skills: ["skill", "skills"],
  prompts: ["prompt", "prompts"],
  themes: ["theme", "themes"],
};

/** A package, or a folder of your own resources: one switch for all of it, and each resource when opened. */
function GroupRow({ plugins, view, group }: { plugins: Plugins; view: PluginView; group: PluginGroup }) {
  const [open, setOpen] = useState(false);
  const entry = plugins.catalog?.catalog.entries.find((candidate): candidate is CatalogPackage => candidate.kind === "package" && samePackage(group.source, candidate));
  const on = group.resources.filter((resource) => resource.enabled).length;
  const counts = RESOURCE_TYPES.map((type) => [type, group.resources.filter((resource) => resource.type === type).length] as const)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${TYPE_LABELS[type][count === 1 ? 0 : 1]}`)
    .join(", ");
  const isPackage = group.kind === "package";
  const key = `group:${group.key}`;
  const busy = plugins.busy !== null;
  // A package is removed from the settings that list it, in the view of those settings.
  const removable = isPackage && (view.scope === "global" ? group.scope === "user" : group.scope === "project");
  const overridden = view.scope === "project" && group.resources.some((resource) => resource.override && resource.override !== "inherit");
  const togglePackage = (enabled: boolean) => {
    plugins.patch(view.scope, (other) => other.key === group.key, { enabled });
    void plugins.run(key, () => window.studio.plugins.togglePackage(plugins.cwd, { scope: view.scope, source: group.source, packageScope: group.scope, enabled }));
  };
  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight size={13} className={`shrink-0 text-faint transition-transform group-hover:text-fg ${open ? "rotate-90" : ""}`} />
          <PluginLogo logo={entry?.logo} icon={entry?.icon ?? (isPackage ? "package" : undefined)} name={group.label} size={26} folder={!isPackage} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] text-fg">{isPackage ? packageLabel(group.source) : ownLabel(group)}</span>
              {overridden && <ProjectTag />}
            </div>
            <div className="truncate text-[11.5px] text-faint">
              {counts}
              {on < group.resources.length && ` · ${on} of ${group.resources.length} on`}
            </div>
          </div>
        </button>
        {isPackage && <Switch on={on > 0} disabled={busy} title={on > 0 ? "Turn the whole package off" : "Turn the whole package on"} onChange={togglePackage} />}
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 border-t border-line bg-sunken/40 px-3 py-2">
          {RESOURCE_TYPES.map((type) => {
            const resources = group.resources.filter((resource) => resource.type === type);
            if (!resources.length) return null;
            return (
              <div key={type} className="flex flex-col">
                <div className="pt-1.5 pb-0.5 pl-[38px] text-[11px] font-medium tracking-wide text-faint uppercase">{TYPE_LABELS[type][1]}</div>
                {resources.map((resource) => (
                  <ResourceRow key={resource.path} plugins={plugins} view={view} group={group} resource={resource} />
                ))}
              </div>
            );
          })}
          <div className="mt-1.5 flex items-center gap-3 pl-[38px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint" title={group.source}>
              {isPackage ? group.source : group.label}
            </span>
            {removable && (
              <ConfirmButton
                label="Uninstall"
                confirm="Uninstall?"
                title={`Remove it from ${view.scope === "global" ? "your" : "this project's"} settings and delete its files`}
                onConfirm={() => void plugins.run(key, () => window.studio.plugins.remove(plugins.cwd, group.source, group.scope), `Uninstalled ${packageLabel(group.source)}`)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResourceRow({ plugins, view, group, resource }: { plugins: Plugins; view: PluginView; group: PluginGroup; resource: PluginResource }) {
  const toggle = useResourceToggle(plugins, view);
  // In the personal view, what the project configures is not yours to change (pi config leaves it alone too).
  const locked = view.scope === "global" && group.scope === "project";
  return (
    <div className="flex items-center gap-3 py-1 pl-[38px]">
      <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${resource.enabled ? "text-fg" : "text-faint"}`} title={resource.path}>
        {resource.name}
      </span>
      <OverrideMark resource={resource} onReset={() => toggle(resource, undefined)} />
      <Switch on={resource.enabled} disabled={plugins.busy !== null || locked} onChange={(enabled) => toggle(resource, enabled)} />
    </div>
  );
}

/** Turns one resource on or off in the view: personal settings directly, project settings as an override of them.
 * `enabled` undefined resets a project override. */
function useResourceToggle(plugins: Plugins, view: PluginView) {
  const global = plugins.state?.views.global;
  return (resource: PluginResource, enabled: boolean | undefined) => {
    const same = (_group: PluginGroup, other: PluginResource) => other.path === resource.path && other.type === resource.type;
    if (view.scope === "global") {
      if (enabled === undefined) return;
      plugins.patch("global", same, { enabled });
      void plugins.run(`resource:${resource.path}`, () => window.studio.plugins.toggle(plugins.cwd, { scope: "global", path: resource.path, type: resource.type, enabled }));
      return;
    }
    // As pi config does: a project resource, or one of yours pi does not list, inherits "on".
    const inherited = global?.groups.flatMap((group) => group.resources).find((other) => same({} as PluginGroup, other))?.enabled ?? true;
    const next = enabled ?? inherited;
    const override: ProjectOverride = enabled === undefined || next === inherited ? "inherit" : next ? "load" : "unload";
    plugins.patch("project", same, { enabled: next, override });
    void plugins.run(`resource:${resource.path}`, () => window.studio.plugins.toggle(plugins.cwd, { scope: "project", path: resource.path, type: resource.type, override }));
  };
}

function OverrideMark({ resource, onReset }: { resource: PluginResource; onReset: () => void }) {
  if (!resource.override || resource.override === "inherit") return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <ProjectTag title={resource.override === "load" ? "This project turns it on" : "This project turns it off"} />
      <button type="button" title="Back to your personal setting" onClick={onReset} className="rounded-md p-0.5 text-faint hover:bg-raised hover:text-fg">
        <RotateCcw size={11} />
      </button>
    </span>
  );
}

function ProjectTag({ title }: { title?: string }) {
  return (
    <span title={title ?? "Set by this project's .pi/settings.json"} className="shrink-0 rounded border border-line px-1 py-px text-[10.5px] leading-none text-muted">
      project
    </span>
  );
}

/** pi's label of a group of your own resources, without its scope word: `User (~/.pi/agent/)` → `~/.pi/agent/`. */
function ownLabel(group: PluginGroup): string {
  return /\(([^)]+)\)$/.exec(group.label)?.[1] ?? group.label;
}

// ── Built-in ─────────────────────────────────────────────────────────────────

const BUILTINS: { name: string; title: string; about: string }[] = [
  { name: "mcp", title: "MCP", about: "Connects the servers in mcp.json and adds /mcp. An extension with its own /mcp, such as pi-mcp-adapter, replaces it in chats." },
  { name: "codemode", title: "Codemode", about: "The codemode tool: the model writes a script that calls other tools, and only the script's output comes back. MCP servers use it unless set otherwise." },
  { name: "tool-search", title: "Tool search", about: "The tool_search tool, which finds tools not declared to the model, such as deferred MCP tools, and declares them." },
  { name: "llama.cpp", title: "llama.cpp", about: "The llama.cpp provider and /llama, for local models served by a llama.cpp router." },
];

function BuiltIn({ plugins, view }: { plugins: Plugins; view: PluginView }) {
  const toggle = useResourceToggle(plugins, view);
  const resources = view.groups.filter((group) => group.kind === "builtin").flatMap((group) => group.resources);
  const known = new Set(BUILTINS.map((builtin) => `builtin:${builtin.name}`));
  const rows = [
    ...BUILTINS.flatMap((builtin) => {
      const resource = resources.find((other) => other.path === `builtin:${builtin.name}`);
      return resource ? [{ resource, title: builtin.title, about: builtin.about }] : [];
    }),
    // A built-in of a newer pi than this list knows.
    ...resources.filter((resource) => !known.has(resource.path)).map((resource) => ({ resource, title: resource.name, about: undefined })),
  ];
  if (!rows.length) return <p className="text-[12.5px] text-faint">This pi has no built-in extensions.</p>;
  return (
    <section>
      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {rows.map(({ resource, title, about }) => (
          <div key={resource.path} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] text-fg">{title}</span>
                <span className="font-mono text-[11px] text-faint">{resource.path}</span>
              </div>
              {about && <div className="mt-0.5 text-[12px] leading-relaxed text-faint">{about}</div>}
            </div>
            <OverrideMark resource={resource} onReset={() => toggle(resource, undefined)} />
            <Switch on={resource.enabled} disabled={plugins.busy !== null} onChange={(enabled) => toggle(resource, enabled)} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-faint">
        As <Code>pi config</Code> lists them under Built-in; one that is off is <Code>-builtin:name</Code> in the settings.
      </p>
    </section>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

const ICONS: Record<CatalogIcon, IconComponent> = { globe: Globe, image: Image, package: Package };

/** A catalog logo on its brand tile; else an icon, a folder of your own, or the name's initial. */
function PluginLogo({ logo, icon, name, size, folder }: { logo?: CatalogLogo; icon?: CatalogIcon | "plug"; name: string; size: number; folder?: boolean }) {
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.26) };
  if (logo) {
    const mark = Math.round(size * logo.scale);
    return (
      <span aria-hidden="true" style={{ ...box, background: logo.background }} className="flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-black/10 ring-inset dark:ring-white/10">
        <img src={logo.src} alt="" width={mark} height={mark} draggable={false} className="object-contain" />
      </span>
    );
  }
  const Icon = folder ? Blocks : icon === "plug" ? Plug : icon ? ICONS[icon] : undefined;
  return (
    <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.45) }} className="flex shrink-0 items-center justify-center bg-raised font-semibold text-muted ring-1 ring-line ring-inset">
      {Icon ? <Icon size={Math.round(size * 0.5)} strokeWidth={1.75} /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A connect or sign-in under its card or row; esc cancels it. */
function Panel({ title, logo, onCancel, children }: { title: string; logo: React.ReactNode; onCancel: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLInputElement && !ref.current?.contains(event.target)) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div ref={ref} className="flex flex-col gap-3 rounded-xl border border-line-strong bg-panel p-3.5 shadow-sm">
      <div className="flex items-center gap-2.5">
        {logo}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{title}</span>
        <button type="button" onClick={onCancel} title="Cancel (esc)" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {children}
    </div>
  );
}

function SigningIn({ url }: { url?: string }) {
  if (!url) return <Waiting text="Starting the sign-in…" />;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-fg">
        Your browser opened <span className="font-mono text-[12px]">{host(url)}</span>. Finish signing in there.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => window.studio.openExternal(url)}>
          <ExternalLink size={12} /> Open again
        </Button>
        <CopyButton text={url} label="Copy link" />
      </div>
      <Waiting text="Waiting for the browser…" />
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-faint">
      <LoaderCircle size={12} className="animate-spin" />
      {text}
    </p>
  );
}

function ErrorBox({ error, onClose }: { error: string; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-[12.5px] text-fg">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-bad" />
      <p className="selectable min-w-0 flex-1 break-words">{error}</p>
      <Button onClick={onClose}>Close</Button>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11.5px] text-muted">{children}</span>;
}

function SubmitButton({ disabled, autoFocus, children }: { disabled?: boolean; autoFocus?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      autoFocus={autoFocus}
      className="shrink-0 rounded-lg border border-accent bg-accent px-3 py-1 text-[12px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex w-52 items-center gap-2 rounded-lg bg-sunken px-2.5 py-1 focus-within:ring-1 focus-within:ring-line-strong">
      <Search size={12} className="shrink-0 text-faint" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
        placeholder="Search plugins"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
      />
    </label>
  );
}
