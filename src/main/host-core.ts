import type { AtpHead } from "../shared/atp";
import type { AuthMethod } from "../shared/auth";
import type { BoardOp } from "../shared/board";
import type { BrowserCommand } from "../shared/browser";
import type { ComputerOp } from "../shared/computer";
import type { GithubFilter, GithubKind } from "../shared/github";
import { HostError, type MethodScope, type QueueEdit } from "../shared/host-api";
import { type DialogAnswer, IPC, type OpenSessionRequest } from "../shared/ipc";
import type { LamentOp } from "../shared/laments";
import type { ExtensionUiResponse, RpcCommand } from "../shared/protocol";
import type { SettingsOp } from "../shared/settings";
import type { ViewportRequest } from "../shared/viewport";
import { librarianPath } from "./atp";
import { listFiles } from "./files";
import { readCompactionSettings, readPiSettings, writePiSettings } from "./pi-settings";
import { listSessions } from "./session-index";
import { cardWorktree } from "./worktree";
import { describePaths } from "./attachments";
import { log } from "./log";
import type { Atp } from "./atp";
import type { BoardStore } from "./board";
import type { BrowserManager } from "./browser/manager";
import type { CardImages } from "./card-images";
import type { ComputerService } from "./computer/service";
import type { ComputerStore } from "./computer/store";
import type { Github } from "./github";
import type { LamentStore } from "./laments";
import type { PiAuth } from "./pi-auth";
import type { SessionHost } from "./session-host";
import type { SettingsStore } from "./settings";
import type { Updater } from "./updater";

/** Who is calling, and the side effects that belong to that client alone (never broadcast). */
export interface HostContext {
  client: "desktop" | { device: string };
  clientId: string;
  /** Opens a link where the caller is: desktop opens it on the Mac, a remote client gets it in the login update and opens it itself. */
  openExternal(url: string): void;
  /** Login progress goes to the client that started the login. */
  authUpdate(update: unknown): void;
}

/** What only the Mac can do: native dialogs, Finder, the window. */
export interface HostNative {
  pickFolder(): Promise<string | null>;
  pickAttachments(kind: "photos" | "files"): Promise<unknown>;
  showItemInFolder(path: string): void;
  windowFocused(): boolean;
  focusBrowserWindow(id: string): void;
  killVisual(frameId: string): void;
}

export interface HostDeps {
  shellEnv: Promise<void>;
  host: SessionHost;
  board: BoardStore;
  cardImages: CardImages;
  settings: SettingsStore;
  computerPolicy: ComputerStore;
  computerHelper: ComputerService;
  laments: LamentStore;
  github: Github;
  atp: Atp;
  auth: PiAuth;
  browser(): BrowserManager | undefined;
  updater(): Updater | undefined;
  native: HostNative;
}

/** One host method: `validate` turns untrusted arguments into typed ones (throwing on bad input), `run` does the work. */
export interface HostMethodDef {
  scope: MethodScope;
  validate(args: unknown): unknown;
  run(ctx: HostContext, args: any): unknown;
}

const method = <A>(scope: MethodScope, validate: (raw: any) => A, run: (ctx: HostContext, args: A) => unknown): HostMethodDef => ({ scope, validate, run });
/** Arguments are used as sent, as the IPC handlers did before the table. */
const any = <A>(scope: MethodScope, run: (ctx: HostContext, args: A) => unknown) => method<A>(scope, (raw) => raw as A, run);

const tabId = (raw: { id: unknown }) => {
  if (typeof raw.id !== "string") throw new Error("Invalid browser tab");
  return { id: raw.id };
};

/** The caller as a lease holder on chats. */
const presence = (ctx: HostContext) => ({ clientId: ctx.clientId, actor: ctx.client === "desktop" ? "desktop" : ctx.client.device });

/** gh and git run on a project: an absolute folder. */
export const project = (cwd: unknown): string => {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("a project is an absolute path");
  return cwd;
};

export function createHostCore(deps: HostDeps): Record<string, HostMethodDef> {
  const { host, board, settings, computerPolicy, computerHelper, laments, github, atp, auth, native } = deps;
  // pi, rg and session listing depend on the login-shell environment (PATH, PI_CODING_AGENT_DIR, API keys).
  const env = () => deps.shellEnv;
  return {
    "chat.list": any("remote", async () => (await env(), listSessions())),
    "chat.open": any<{ request: OpenSessionRequest }>("remote", async (ctx, { request }) => (await env(), host.open(request, { client: presence(ctx) }))),
    "chat.close": any<{ handle: string }>("remote", (_ctx, { handle }) => host.close(handle)),
    "chat.command": any<{ handle: string; command: RpcCommand }>("remote", (_ctx, { handle, command }) => host.command(handle, command)),
    "chat.detach": any<{ handle: string }>("remote", (ctx, { handle }) => host.detach(handle, ctx.clientId)),
    "chat.attach": any<{ handle: string }>("remote", (ctx, { handle }) => {
      try {
        host.attach(handle, presence(ctx));
      } catch {
        return null; // it ended meanwhile
      }
      // Attach and snapshot in one turn: the snapshot's seq says which events the client must still apply.
      return host.snapshot(handle, { turns: Number.MAX_SAFE_INTEGER }) ?? null;
    }),
    "chat.viewing": any<{ handle: string; viewing: boolean }>("remote", (ctx, { handle, viewing }) => host.viewing(handle, ctx.clientId, viewing === true)),
    "chat.live": any("remote", () => host.attentionAll()),
    "chat.interrupt": any<{ handle: string }>("remote", (_ctx, { handle }) => host.interrupt(handle)),
    "chat.editQueue": any<{ handle: string; op: QueueEdit }>("remote", (_ctx, { handle, op }) => host.editQueue(handle, op)),
    "chat.respondDialog": any<{ handle: string; response: ExtensionUiResponse }>("remote", (_ctx, { handle, response }): DialogAnswer => {
      try {
        host.respondDialog(handle, response);
        return { ok: true };
      } catch (error) {
        // Answered elsewhere first (a phone), or the chat ended: the client drops the card; anything else keeps it.
        if (!(error instanceof HostError)) throw error;
        return { ok: false, code: error.code, message: error.message };
      }
    }),
    "chat.files": any<{ cwd: string }>("remote", async (_ctx, { cwd }) => (await env(), listFiles(cwd))),
    "chat.compactionSettings": any("remote", async () => (await env(), readCompactionSettings())),
    "fs.pickFolder": any("desktop", () => native.pickFolder()),
    "fs.pickAttachments": any<{ kind: "photos" | "files" }>("desktop", (_ctx, { kind }) => native.pickAttachments(kind)),
    "fs.describePaths": any<{ paths: string[] }>("remote", (_ctx, { paths }) => describePaths(Array.isArray(paths) ? paths : [])),
    "host.openExternal": any<{ url: string }>("desktop", (ctx, { url }) => ctx.openExternal(url)),
    "host.killVisual": any<{ frameId: string }>("desktop", (_ctx, { frameId }) => native.killVisual(frameId)),
    "host.windowFocused": any("desktop", () => native.windowFocused()),
    "host.relaunch": any("desktop", () => deps.updater()?.restart()),
    "update.get": any("remote", () => deps.updater()?.get() ?? { phase: "idle" }),
    "update.download": any("remote", () => deps.updater()?.download()),

    "browser.layout": any<{ layout: Parameters<BrowserManager["setLayout"]>[0] }>("desktop", (_ctx, { layout }) => deps.browser()?.setLayout(layout)),
    "browser.newTab": any<{ url?: string }>("remote", (_ctx, { url }) => deps.browser()?.createTab(url)),
    "browser.closeTab": any<{ id: string }>("remote", (_ctx, { id }) => deps.browser()?.closeTab(id)),
    "browser.activate": any<{ id: string }>("remote", (ctx, { id }) => {
      deps.browser()?.activate(id);
      // Raising a tab's window is a Mac thing.
      if (ctx.client === "desktop") native.focusBrowserWindow(id);
    }),
    "browser.navigate": any<{ id: string; input: string }>("remote", (_ctx, { id, input }) => deps.browser()?.navigate(id, input)),
    "browser.command": any<{ id: string; command: BrowserCommand }>("remote", (_ctx, { id, command }) => deps.browser()?.command(id, command)),
    "browser.annotate": any<{ on: boolean }>("remote", (_ctx, { on }) => deps.browser()?.setAnnotating(on)),
    "browser.inspect": any<{ id: string }>("remote", (_ctx, { id }) => deps.browser()?.inspect(id)),
    "browser.viewport": method<{ id: string; request: ViewportRequest | null }>(
      "remote",
      (raw) => {
        const { id } = tabId(raw);
        if (raw.request !== null && raw.request !== undefined && (typeof raw.request !== "object" || Array.isArray(raw.request))) throw new Error("Invalid viewport request");
        return { id, request: raw.request ?? null };
      },
      async (_ctx, { id, request }) => {
        const browser = deps.browser();
        if (!browser) throw new Error("Invalid browser tab");
        // Whatever the client sends, the user is the source.
        return (await browser.setViewport(id, request ? { ...request, source: "user" } : undefined)) ?? null;
      },
    ),
    "browser.popOut": method<{ id: string }>("desktop", tabId, async (_ctx, { id }) => {
      const browser = deps.browser();
      if (!browser) throw new Error("Invalid browser tab");
      await browser.popOut(id);
    }),
    "browser.returnToPane": method<{ id: string }>("desktop", tabId, async (_ctx, { id }) => {
      const browser = deps.browser();
      if (!browser) throw new Error("Invalid browser tab");
      await browser.returnToPane(id);
    }),
    "browser.history": any("remote", () => deps.browser()?.getHistory() ?? []),
    "browser.state": any("remote", () => deps.browser()?.snapshot()),

    "board.get": any("remote", () => board.get()),
    "board.apply": any<{ op: BoardOp; baseRev?: number }>("remote", async (_ctx, { op, baseRev }) => {
      const next = await board.apply(op, baseRev);
      if (op.type === "remove") void deps.cardImages.remove(op.id).catch((error: Error) => log.warn("board", `could not delete the images of card ${op.id}: ${error.message}`));
      return next;
    }),
    "board.saveImage": any<{ card: string; image: { mimeType: string; data: string } }>("remote", async (_ctx, { card, image }) => {
      if (!(await board.get()).cards.some((other) => other.id === card)) throw new Error(`no card ${String(card)}`);
      return deps.cardImages.save(card, image);
    }),
    "board.worktree": any<{ id: string }>("desktop", async (_ctx, { id }) => {
      await env();
      const card = (await board.get()).cards.find((other) => other.id === id);
      if (!card) throw new Error(`no card ${String(id)}`);
      return cardWorktree(card.cwd, card);
    }),
    "laments.get": any("remote", () => laments.get()),
    "laments.apply": any<{ op: LamentOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => laments.apply(op, baseRev)),
    "laments.worktree": any<{ id: string }>("desktop", async (_ctx, { id }) => {
      await env();
      const lament = (await laments.get()).laments.find((other) => other.id === id);
      if (!lament) throw new Error(`no lament ${String(id)}`);
      return cardWorktree(lament.cwd, { id: lament.id, title: `fix ${lament.title}` });
    }),

    "computer.get": any("remote", () => computerPolicy.get()),
    "computer.apply": any<{ op: ComputerOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => computerPolicy.apply(op, baseRev)),
    "computer.permissions": any("remote", () => computerHelper.call("permissions", {})),
    "computer.requestPermissions": any<{ pane?: "accessibility" | "screen_recording" }>("remote", async (_ctx, { pane }) => {
      await computerHelper.call("request_permissions", {});
      const permissions = await computerHelper.call("permissions", {});
      // macOS 26 does not prompt for Screen Recording from the background helper ("does not allow prompting") and does
      // not list it in the pane until it is added, so open the pane and show the app to add with + or drag in.
      if (pane === "screen_recording" && !permissions.screenRecording) {
        await computerHelper.call("open_settings", { pane });
        native.showItemInFolder(computerHelper.installedApp);
      }
      return permissions;
    }),
    "computer.openSettings": method<{ pane: "accessibility" | "screen_recording" }>(
      "desktop",
      (raw) => {
        if (raw.pane !== "accessibility" && raw.pane !== "screen_recording") throw new Error("Unknown settings pane");
        return raw;
      },
      async (_ctx, { pane }) => {
        await computerHelper.call("open_settings", { pane });
      },
    ),

    "settings.get": any("remote", () => settings.get()),
    "settings.apply": any<{ op: SettingsOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => settings.apply(op, baseRev)),
    // PI_CODING_AGENT_DIR can come from the login shell.
    "settings.pi": any("remote", async () => (await env(), readPiSettings())),
    "settings.setPi": any<{ patch: unknown }>("remote", async (_ctx, { patch }) => (await env(), writePiSettings(patch))),
    "settings.revealPi": any("desktop", async () => {
      await env();
      native.showItemInFolder((await readPiSettings()).path);
    }),

    // pi's logins (/login), with the pi found on the login shell's PATH.
    "providers.list": any("remote", async () => (await env(), auth.list())),
    "providers.login": method<{ provider: string; method: AuthMethod }>(
      "remote",
      (raw) => {
        if (typeof raw.provider !== "string" || (raw.method !== "oauth" && raw.method !== "api_key")) throw new Error("Unknown login");
        return raw;
      },
      async (ctx, { provider, method }) => {
        await env();
        return auth.signIn(provider, method, (update) => {
          // As pi's /login does, open the sign-in page where the caller is (Claude Code opens its own).
          if (update.kind === "event" && update.event.type === "auth_url" && !update.event.opened) ctx.openExternal(update.event.url);
          ctx.authUpdate(update);
        });
      },
    ),
    "providers.answer": any<{ n: number; value: string }>("remote", (_ctx, { n, value }) => auth.answer(Number(n), String(value))),
    "providers.cancel": any("remote", () => auth.cancel()),
    "providers.logout": any<{ provider: string }>("remote", async (_ctx, { provider }) => {
      await env();
      await auth.signOut(String(provider));
    }),

    // gh runs with the login shell's PATH.
    "github.project": method<{ cwd: string; refresh?: boolean }>("remote", (raw) => ({ cwd: project(raw.cwd), refresh: raw.refresh === true }), async (_ctx, { cwd, refresh }) => (await env(), github.project(cwd, refresh === true))),
    "github.choose": method<{ cwd: string; login: string | null }>("remote", (raw) => ({ cwd: project(raw.cwd), login: typeof raw.login === "string" ? raw.login : null }), async (_ctx, { cwd, login }) => (await env(), github.choose(cwd, login))),
    "github.list": method<{ cwd: string; kind: GithubKind; filter: GithubFilter }>(
      "remote",
      (raw) => {
        if ((raw.kind !== "issue" && raw.kind !== "pr") || (raw.filter !== "open" && raw.filter !== "closed")) throw new Error(`cannot list ${String(raw.filter)} ${String(raw.kind)}s`);
        return { cwd: project(raw.cwd), kind: raw.kind, filter: raw.filter };
      },
      async (_ctx, { cwd, kind, filter }) => (await env(), github.list(cwd, kind, filter)),
    ),
    "github.lookup": method<{ cwd: string; input: string }>("remote", (raw) => ({ cwd: project(raw.cwd), input: String(raw.input).slice(0, 500) }), async (_ctx, { cwd, input }) => (await env(), github.lookup(cwd, input))),

    // python3, rg and git come from the login shell's PATH.
    "atp.watch": method<{ cwd: string | null }>("desktop", (raw) => ({ cwd: raw.cwd === null ? null : project(raw.cwd) }), async (_ctx, { cwd }) => (await env(), atp.watch(cwd))),
    "atp.read": any<{ plan: string }>("remote", (_ctx, { plan }) => atp.read(plan)),
    "atp.activate": any<{ plan: string }>("desktop", async (_ctx, { plan }) => (await env(), atp.activate(plan))),
    "atp.claim": any<{ plan: string; agent: string }>("desktop", async (_ctx, { plan, agent }) => (await env(), atp.claim(plan, String(agent)))),
    "atp.release": any<{ plan: string; node: string; agent: string; reason: string }>("desktop", async (_ctx, { plan, node, agent, reason }) => (await env(), atp.release(plan, String(node), String(agent), String(reason)))),
    "atp.head": method<{ cwd: string }>("desktop", (raw) => ({ cwd: project(raw.cwd) }), async (_ctx, { cwd }) => (await env(), atp.head(cwd))),
    "atp.commit": method<{ cwd: string; node: string; title: string; before: AtpHead | null }>(
      "desktop",
      (raw) => ({ cwd: project(raw.cwd), node: String(raw.node), title: String(raw.title), before: raw.before }),
      async (_ctx, { cwd, node, title, before }) => (await env(), atp.commit(cwd, node, title, before)),
    ),
    "atp.getHeld": any("desktop", () => atp.heldPlans()),
    "atp.setHeld": any<{ plan: string; held: boolean }>("desktop", (_ctx, { plan, held }) => atp.setHeld(plan, held === true)),
    "atp.info": any("desktop", () => ({ librarian: librarianPath() })),
  };
}

export type HostCore = ReturnType<typeof createHostCore>;

/**
 * Runs one method for a caller: unknown names and desktop-only methods called by a remote client are refused
 * before anything is validated or run.
 */
export function dispatch(core: HostCore, ctx: HostContext, name: string, args: unknown): unknown {
  const def = Object.hasOwn(core, name) ? core[name] : undefined;
  if (!def) throw new HostError("not_found", `unknown method ${name}`);
  if (def.scope === "desktop" && ctx.client !== "desktop") throw new HostError("scope_denied", `${name} is only available on the Mac`);
  return def.run(ctx, def.validate(args ?? {}));
}

/** How the desktop window reaches the table: its IPC channel, the method, and how positional arguments become the argument object. */
export interface IpcRoute {
  channel: string;
  method: string;
  /** Fire-and-forget (`ipcRenderer.send`) rather than invoke. */
  send?: true;
  args: (...positional: any[]) => Record<string, unknown>;
}

const route = (channel: string, method: string, args: IpcRoute["args"] = () => ({}), send?: true): IpcRoute => ({ channel, method, args, ...(send ? { send } : {}) });

export const IPC_ROUTES: IpcRoute[] = [
  route(IPC.listSessions, "chat.list"),
  route(IPC.openSession, "chat.open", (request) => ({ request })),
  route(IPC.closeSession, "chat.close", (handle) => ({ handle })),
  route(IPC.command, "chat.command", (handle, command) => ({ handle, command })),
  route(IPC.detachSession, "chat.detach", (handle) => ({ handle })),
  route(IPC.attachSession, "chat.attach", (handle) => ({ handle })),
  route(IPC.viewing, "chat.viewing", (handle, viewing) => ({ handle, viewing }), true),
  route(IPC.liveChats, "chat.live"),
  route(IPC.interrupt, "chat.interrupt", (handle) => ({ handle })),
  route(IPC.editQueue, "chat.editQueue", (handle, op) => ({ handle, op })),
  route(IPC.respondDialog, "chat.respondDialog", (handle, response) => ({ handle, response })),
  route(IPC.listFiles, "chat.files", (cwd) => ({ cwd })),
  route(IPC.pickFolder, "fs.pickFolder"),
  route(IPC.openExternal, "host.openExternal", (url) => ({ url }), true),
  route(IPC.visualKill, "host.killVisual", (frameId) => ({ frameId }), true),
  route(IPC.compactionSettings, "chat.compactionSettings"),
  route(IPC.windowFocused, "host.windowFocused"),
  route(IPC.describePaths, "fs.describePaths", (paths) => ({ paths })),
  route(IPC.pickAttachments, "fs.pickAttachments", (kind) => ({ kind })),
  route(IPC.browserLayout, "browser.layout", (layout) => ({ layout }), true),
  route(IPC.browserNewTab, "browser.newTab", (url) => ({ url }), true),
  route(IPC.browserCloseTab, "browser.closeTab", (id) => ({ id }), true),
  route(IPC.browserActivate, "browser.activate", (id) => ({ id }), true),
  route(IPC.browserNavigate, "browser.navigate", (id, input) => ({ id, input }), true),
  route(IPC.browserCommand, "browser.command", (id, command) => ({ id, command }), true),
  route(IPC.browserAnnotate, "browser.annotate", (on) => ({ on }), true),
  route(IPC.browserInspect, "browser.inspect", (id) => ({ id }), true),
  route(IPC.browserViewport, "browser.viewport", (id, request) => ({ id, request })),
  route(IPC.browserPopOut, "browser.popOut", (id) => ({ id })),
  route(IPC.browserReturn, "browser.returnToPane", (id) => ({ id })),
  route(IPC.browserHistory, "browser.history"),
  route(IPC.browserGetState, "browser.state"),
  route(IPC.boardGet, "board.get"),
  route(IPC.boardApply, "board.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.boardSaveImage, "board.saveImage", (card, image) => ({ card, image })),
  route(IPC.cardWorktree, "board.worktree", (id) => ({ id })),
  route(IPC.lamentsGet, "laments.get"),
  route(IPC.lamentsApply, "laments.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.lamentWorktree, "laments.worktree", (id) => ({ id })),
  route(IPC.computerGet, "computer.get"),
  route(IPC.computerApply, "computer.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.computerPermissions, "computer.permissions"),
  route(IPC.computerRequest, "computer.requestPermissions", (pane) => ({ pane })),
  route(IPC.computerOpenSettings, "computer.openSettings", (pane) => ({ pane })),
  route(IPC.settingsGet, "settings.get"),
  route(IPC.settingsApply, "settings.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.piSettingsGet, "settings.pi"),
  route(IPC.piSettingsApply, "settings.setPi", (patch) => ({ patch })),
  route(IPC.piSettingsReveal, "settings.revealPi"),
  route(IPC.authList, "providers.list"),
  route(IPC.authLogin, "providers.login", (provider, method) => ({ provider, method })),
  route(IPC.authAnswer, "providers.answer", (n, value) => ({ n, value }), true),
  route(IPC.authCancel, "providers.cancel", () => ({}), true),
  route(IPC.authLogout, "providers.logout", (provider) => ({ provider })),
  route(IPC.githubProject, "github.project", (cwd, refresh) => ({ cwd, refresh })),
  route(IPC.githubChoose, "github.choose", (cwd, login) => ({ cwd, login })),
  route(IPC.githubList, "github.list", (cwd, kind, filter) => ({ cwd, kind, filter })),
  route(IPC.githubLookup, "github.lookup", (cwd, input) => ({ cwd, input })),
  route(IPC.atpWatch, "atp.watch", (cwd) => ({ cwd })),
  route(IPC.atpRead, "atp.read", (plan) => ({ plan })),
  route(IPC.atpActivate, "atp.activate", (plan) => ({ plan })),
  route(IPC.atpClaim, "atp.claim", (plan, agent) => ({ plan, agent })),
  route(IPC.atpRelease, "atp.release", (plan, node, agent, reason) => ({ plan, node, agent, reason })),
  route(IPC.atpHead, "atp.head", (cwd) => ({ cwd })),
  route(IPC.atpCommit, "atp.commit", (cwd, node, title, before) => ({ cwd, node, title, before })),
  route(IPC.atpGetHeld, "atp.getHeld"),
  route(IPC.atpSetHeld, "atp.setHeld", (plan, held) => ({ plan, held })),
  route(IPC.atpInfo, "atp.info"),
  route(IPC.relaunch, "host.relaunch"),
  route(IPC.updateGet, "update.get"),
  route(IPC.updateDownload, "update.download"),
];
