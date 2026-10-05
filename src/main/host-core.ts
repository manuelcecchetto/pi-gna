import { isPlanPath } from "../shared/atp";
import type { AuthMethod } from "../shared/auth";
import type { BoardOp, Column } from "../shared/board";
import type { BrowserCommand } from "../shared/browser";
import type { ComputerOp } from "../shared/computer";
import type { GithubFilter, GithubKind } from "../shared/github";
import { type AppInfo, type HostCtx, HostError, type MethodScope, type NewCardAttachment, type QueueEdit, type TaskTarget } from "../shared/host-api";
import { type DialogAnswer, IPC, type OpenSessionRequest } from "../shared/ipc";
import type { LamentOp } from "../shared/laments";
import type { ExtensionUiResponse, RpcCommand } from "../shared/protocol";
import type { KeepAwake, SettingsOp } from "../shared/settings";
import type { UiOp } from "../shared/ui-state";
import type { ViewportRequest } from "../shared/viewport";
import { listFiles } from "./files";
import { readCompactionSettings, readPiSettings, writePiSettings } from "./pi-settings";
import { listSessions } from "./session-index";
import { describePaths } from "./attachments";
import { log } from "./log";
import type { Atp } from "./atp";
import type { AtpRuns } from "./atp-runner";
import type { AtpThreads } from "./atp-threads";
import type { ChatTasks } from "./chat-tasks";
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
import type { UiStateStore } from "./ui-state";
import type { Updater } from "./updater";
import type { DeviceStore } from "./devices";
import type { RemoteHost } from "./remote";

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
  tasks: ChatTasks;
  board: BoardStore;
  cardImages: CardImages;
  settings: SettingsStore;
  uiState: UiStateStore;
  computerPolicy: ComputerStore;
  computerHelper: ComputerService;
  laments: LamentStore;
  github: Github;
  atp: Atp;
  atpRuns: AtpRuns;
  atpThreads: AtpThreads;
  auth: PiAuth;
  browser(): BrowserManager | undefined;
  updater(): Updater | undefined;
  devices: DeviceStore;
  remote: RemoteHost;
  native: HostNative;
  /** What a client needs to show paths and versions (the desktop reads it from its preload arguments). */
  app: AppInfo;
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

/** Turns a snapshot holds; earlier ones come page by page (`before`). */
const SNAPSHOT_TURNS = 40;

const tabId = (raw: { id: unknown }) => {
  if (typeof raw.id !== "string") throw new Error("Invalid browser tab");
  return { id: raw.id };
};

/** The caller as a lease holder on chats. */
/** The caller as session-host's HostCtx, so an answer or event names who acted. */
const callerOf = (ctx: HostContext): HostCtx => ({ caller: ctx.client === "desktop" ? "desktop" : { device: ctx.client.device }, clientId: ctx.clientId, bootId: "" });
const presence = (ctx: HostContext) => ({ clientId: ctx.clientId, actor: ctx.client === "desktop" ? "desktop" : ctx.client.device });

/** gh and git run on a project: an absolute folder. */
/** An ATP plan is an absolute `.atp.json` path. */
const planPath = (plan: unknown): string => {
  if (!isPlanPath(plan)) throw new Error(`not an ATP plan path: ${String(plan)}`);
  return plan;
};

export const project = (cwd: unknown): string => {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Error("a project is an absolute path");
  return cwd;
};

export function createHostCore(deps: HostDeps): Record<string, HostMethodDef> {
  const { host, tasks, board, settings, uiState, computerPolicy, computerHelper, laments, github, atp, atpRuns, atpThreads, auth, native } = deps;
  // pi, rg and session listing depend on the login-shell environment (PATH, PI_CODING_AGENT_DIR, API keys).
  const env = () => deps.shellEnv;
  return {
    "app.info": any("remote", () => deps.app),
    "chat.list": any("remote", async () => (await env(), listSessions())),
    "chat.open": any<{ request: OpenSessionRequest }>("remote", async (ctx, { request }) => {
      await env();
      const opened = await host.open(request, { client: presence(ctx) });
      // A phone reads the chat through chat.snapshot (paged); the session file's whole branch would only cost bandwidth.
      return ctx.client === "desktop" ? opened : { ...opened, entries: [] };
    }),
    "chat.snapshot": method<{ handle: string; before?: number }>(
      "remote",
      (raw) => {
        if (typeof raw.handle !== "string") throw new Error("Invalid chat");
        if (raw.before !== undefined && !(Number.isInteger(raw.before) && raw.before >= 0)) throw new Error("Invalid turn cursor");
        return { handle: raw.handle, before: raw.before as number | undefined };
      },
      (_ctx, { handle, before }) => {
        const snapshot = host.snapshot(handle, { turns: SNAPSHOT_TURNS, beforeTurn: before });
        if (!snapshot) throw new HostError("not_found", "session is not running");
        const { seq, ...value } = snapshot;
        return { seq, value };
      },
    ),
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
    "chat.respondDialog": any<{ handle: string; response: ExtensionUiResponse }>("remote", (ctx, { handle, response }): DialogAnswer => {
      try {
        host.respondDialog(handle, response, callerOf(ctx));
        return { ok: true };
      } catch (error) {
        // Answered elsewhere first (a phone), or the chat ended: the client drops the card; anything else keeps it.
        if (!(error instanceof HostError)) throw error;
        return { ok: false, code: error.code, message: error.message };
      }
    }),
    "chat.startTask": any<{ target: TaskTarget }>("remote", async (ctx, { target }) => tasks.start(presence(ctx), target)),
    "chat.send": any<{ handle: string; text: string; mode?: "send" | "followUp"; cardId?: string; attachments?: unknown[]; annotations?: unknown[] }>("remote", async (_ctx, args) => {
      // Attachments and annotations are composed host-side once the host holds uploads and annotations (the phone's).
      if (args.attachments?.length || args.annotations?.length) throw new HostError("bad_request", "attachments and annotations are not supported by chat.send yet");
      return tasks.send(String(args.handle), String(args.text ?? ""), args.mode === "followUp" ? "followUp" : "send", args.cardId);
    }),
    "chat.files": any<{ cwd: string }>("remote", async (_ctx, { cwd }) => (await env(), listFiles(cwd))),
    "chat.compactionSettings": any("remote", async () => (await env(), readCompactionSettings())),
    "fs.pickFolder": any("desktop", () => native.pickFolder()),
    "fs.pickAttachments": any<{ kind: "photos" | "files" }>("desktop", (_ctx, { kind }) => native.pickAttachments(kind)),
    "fs.describePaths": any<{ paths: string[] }>("desktop", (_ctx, { paths }) => describePaths(Array.isArray(paths) ? paths : [])),
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
    "board.addCard": method<{ cwd: string; column: Column; description: string; attachments?: NewCardAttachment[] }>(
      "remote",
      (raw) => ({ cwd: project(raw.cwd), column: raw.column, description: String(raw.description ?? ""), attachments: Array.isArray(raw.attachments) ? raw.attachments : [] }),
      async (_ctx, { cwd, column, description, attachments }) => tasks.addCard(cwd, column, description, attachments),
    ),
    "laments.get": any("remote", () => laments.get()),
    "laments.apply": any<{ op: LamentOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => laments.apply(op, baseRev)),

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
    "ui.get": any("remote", () => uiState.get()),
    "ui.apply": any<{ op: UiOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => uiState.apply(op, baseRev)),
    "ui.importLegacy": any<{ ui: unknown }>("desktop", async (_ctx, { ui }) => (await uiState.importLegacy(ui), null)),
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
    "atp.start": method<{ plan: string; cwd: string }>("remote", (raw) => ({ plan: planPath(raw.plan), cwd: project(raw.cwd) }), (_ctx, { plan, cwd }) => (atpRuns.start(plan, cwd), null)),
    "atp.stop": method<{ plan: string }>("remote", (raw) => ({ plan: planPath(raw.plan) }), async (_ctx, { plan }) => (await atpRuns.stop(plan), null)),
    "atp.releaseInterrupted": method<{ plan: string; node: string }>(
      "remote",
      (raw) => ({ plan: planPath(raw.plan), node: String(raw.node) }),
      async (_ctx, { plan, node }) => (await env(), await atpRuns.releaseInterrupted(plan, node), null),
    ),
    "atp.liftHold": method<{ plan: string }>("remote", (raw) => ({ plan: planPath(raw.plan) }), (_ctx, { plan }) => (atpRuns.liftHold(plan), null)),
    "atp.threads": method<{ plan: string }>("remote", (raw) => ({ plan: planPath(raw.plan) }), (_ctx, { plan }) => atpThreads.get(plan)),
    "atp.orchestrator": method<{ cwd: string; plan?: string }>(
      "remote",
      (raw) => ({ cwd: project(raw.cwd), plan: raw.plan === undefined ? undefined : planPath(raw.plan) }),
      (ctx, { cwd, plan }) => atpRuns.orchestrator(presence(ctx), cwd, plan),
    ),
    "atp.releaseOrchestrators": any("remote", (ctx) => (atpRuns.releaseOrchestrators(presence(ctx)), null)),
    "atp.discardNewPlan": method<{ cwd: string }>("remote", (raw) => ({ cwd: project(raw.cwd) }), (_ctx, { cwd }) => (atpRuns.discardNewPlan(cwd), null)),
    "atp.importThreads": any<{ threads: unknown }>("desktop", async (_ctx, { threads }) => (await atpThreads.importLegacy(threads), null)),
    "atp.state": any("remote", () => ({ ...atpRuns.state(), held: atp.heldPlans() })),

    // Remote access. Everything that changes the tailnet, pairs a device or turns access on is the Mac's alone.
    "devices.list": any("remote", (ctx) => deps.devices.list(ctx.client === "desktop" ? undefined : ctx.client.device)),
    "devices.rename": method<{ id: string; name: string }>("remote", (raw) => ({ id: String(raw.id), name: String(raw.name) }), (_ctx, { id, name }) => deps.devices.rename(id, name)),
    "devices.revoke": method<{ id: string }>("remote", (raw) => ({ id: String(raw.id) }), (_ctx, { id }) => deps.devices.revoke(id)),
    "devices.revokeAll": any("desktop", () => deps.devices.revokeAll()),
    "devices.pairStart": any("desktop", () => deps.devices.startPairing()),
    "devices.pairing": any("desktop", () => deps.devices.pairingStatus()),
    "devices.pairDecide": method<{ request: string; allow: boolean }>("desktop", (raw) => ({ request: String(raw.request), allow: raw.allow === true }), (_ctx, { request, allow }) => deps.devices.decide(request, allow)),
    // The Mac re-reads Tailscale when it asks; a phone gets the last reading.
    "remote.get": any("remote", (ctx) => (ctx.client === "desktop" ? deps.remote.check() : deps.remote.status())),
    "remote.enable": method<{ port?: number }>("desktop", (raw) => ({ port: raw.port === undefined || raw.port === null ? undefined : Number(raw.port) }), (_ctx, { port }) => deps.remote.enable(port)),
    "remote.disable": any("desktop", () => deps.remote.disable()),
    "remote.serve": any("desktop", () => deps.remote.serve()),
    "remote.unserve": any("desktop", () => deps.remote.unserve()),
    "remote.setKeepAwake": method<{ keepAwake: KeepAwake }>("desktop", (raw) => ({ keepAwake: raw.keepAwake }), (_ctx, { keepAwake }) => deps.remote.setKeepAwake(keepAwake)),
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
  let checked: unknown;
  try {
    checked = def.validate(args ?? {});
  } catch (error) {
    // Bad input is the caller's fault: a HostError keeps its code, anything else becomes bad_request (not a 500).
    throw error instanceof HostError ? error : new HostError("bad_request", error instanceof Error ? error.message : String(error));
  }
  return def.run(ctx, checked);
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
  route(IPC.startTask, "chat.startTask", (target) => ({ target })),
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
  route(IPC.addCard, "board.addCard", (cwd, column, description, attachments) => ({ cwd, column, description, attachments })),
  route(IPC.lamentsGet, "laments.get"),
  route(IPC.lamentsApply, "laments.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.computerGet, "computer.get"),
  route(IPC.computerApply, "computer.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.computerPermissions, "computer.permissions"),
  route(IPC.computerRequest, "computer.requestPermissions", (pane) => ({ pane })),
  route(IPC.computerOpenSettings, "computer.openSettings", (pane) => ({ pane })),
  route(IPC.settingsGet, "settings.get"),
  route(IPC.settingsApply, "settings.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.uiGet, "ui.get"),
  route(IPC.uiApply, "ui.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.uiImportLegacy, "ui.importLegacy", (ui) => ({ ui })),
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
  route(IPC.atpState, "atp.state"),
  route(IPC.atpStart, "atp.start", (plan, cwd) => ({ plan, cwd })),
  route(IPC.atpStop, "atp.stop", (plan) => ({ plan })),
  route(IPC.atpReleaseInterrupted, "atp.releaseInterrupted", (plan, node) => ({ plan, node })),
  route(IPC.atpLiftHold, "atp.liftHold", (plan) => ({ plan })),
  route(IPC.atpThreads, "atp.threads", (plan) => ({ plan })),
  route(IPC.atpOrchestrator, "atp.orchestrator", (cwd, plan) => ({ cwd, plan })),
  route(IPC.atpReleaseOrchestrators, "atp.releaseOrchestrators"),
  route(IPC.atpDiscardNewPlan, "atp.discardNewPlan", (cwd) => ({ cwd })),
  route(IPC.atpImportThreads, "atp.importThreads", (threads) => ({ threads })),
  route(IPC.relaunch, "host.relaunch"),
  route(IPC.updateGet, "update.get"),
  route(IPC.updateDownload, "update.download"),
  route(IPC.remoteGet, "remote.get"),
  route(IPC.remoteEnable, "remote.enable", (port) => ({ port })),
  route(IPC.remoteDisable, "remote.disable"),
  route(IPC.remoteServe, "remote.serve"),
  route(IPC.remoteUnserve, "remote.unserve"),
  route(IPC.devicesList, "devices.list"),
  route(IPC.devicesRevoke, "devices.revoke", (id) => ({ id })),
  route(IPC.devicesRevokeAll, "devices.revokeAll"),
  route(IPC.pairStart, "devices.pairStart"),
  route(IPC.pairing, "devices.pairing"),
  route(IPC.pairDecide, "devices.pairDecide", (request, allow) => ({ request, allow })),
];
