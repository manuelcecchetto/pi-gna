import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { isPlanPath } from "../shared/atp";
import type { AuthMethod } from "../shared/auth";
import { type BoardOp, type Column, projectOf } from "../shared/board";
import { PAGE_BYTES, PAGE_TURNS } from "../shared/chat-page";
import { parseAnnotations } from "../shared/annotations";
import type { Annotation, BrowserCommand } from "../shared/browser";
import type { ComputerOp } from "../shared/computer";
import type { GithubFilter, GithubKind } from "../shared/github";
import { type AppInfo, type AttachmentRef, type BrowserInput, type HostCtx, HostError, type MethodScope, type NewCardAttachment, type QueueEdit, type TaskTarget } from "../shared/host-api";
import { type DialogAnswer, IPC, type OpenSessionRequest, type PickedPath } from "../shared/ipc";
import type { LamentOp } from "../shared/laments";
import type { ThemeOp } from "../shared/themes";
import type { UsageQuery } from "../shared/usage";
import { kindFor, parseLinkTarget, type PreviewMode, type PreviewOpenOptions } from "../shared/preview";
import { embeddedImageTargets } from "../shared/markdown-images";
import { type PackageToggle, type PluginToggle, RESOURCE_TYPES } from "../shared/plugins";
import type { AssistantMessage, ExtensionUiResponse, RpcCommand } from "../shared/protocol";
import type { KeepAwake, SettingsOp } from "../shared/settings";
import type { UiOp } from "../shared/ui-state";
import type { ViewportRequest } from "../shared/viewport";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../shared/uploads";
import { readPreviewImage, readPreviewText, resolvePreviewTargets, within } from "./browser/resolve-targets";
import { listFiles } from "./files";
import { siteIcon } from "./site-icons";
import { readCompactionSettings, readPiSettings, writePiSettings } from "./pi-settings";
import { listSessions } from "./session-index";
import { describePaths } from "./attachments";
import { browse } from "./browse";
import type { Uploads } from "./uploads";
import { log } from "./log";
import type { Atp } from "./atp";
import type { AtpRuns } from "./atp-runner";
import type { AtpThreads } from "./atp-threads";
import type { ChatTasks } from "./chat-tasks";
import type { BoardStore } from "./board";
import type { BrowserManager } from "./browser/manager";
import type { RemoteBrowser } from "./browser/remote-view";
import type { CardImages } from "./card-images";
import type { ComputerPreviews } from "./computer/preview";
import type { ComputerService } from "./computer/service";
import type { ComputerStore } from "./computer/store";
import type { Github } from "./github";
import type { LamentStore } from "./laments";
import { applyTheme, type ThemeStore, themeImage } from "./themes";
import type { PiAuth } from "./pi-auth";
import type { PiPlugins } from "./plugins";
import type { ChatImporter } from "./chat-import";
import type { PiSetup } from "./setup";
import type { SessionHost } from "./session-host";
import type { SettingsStore } from "./settings";
import { parseUsageQuery, type UsageService } from "./usage-service";
import type { UiStateStore } from "./ui-state";
import type { Updater } from "./updater";
import type { DeviceStore } from "./devices";
import type { RemoteHost } from "./remote";
import type { PushService } from "./push-service";

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
  /** The login shell's environment: spawning pi, rg, git, gh or node waits for it. */
  shellEnv: Promise<void>;
  /** pi's folders (PI_CODING_AGENT_DIR can come from the login shell): reading pi's files waits only for these. */
  piDirs: Promise<void>;
  host: SessionHost;
  tasks: ChatTasks;
  board: BoardStore;
  cardImages: CardImages;
  settings: SettingsStore;
  uiState: UiStateStore;
  computerPolicy: ComputerStore;
  computerHelper: ComputerService;
  computerPreviews: ComputerPreviews;
  laments: LamentStore;
  usage: UsageService;
  themes: ThemeStore;
  /** The project on the window's screen changed (themes.active). */
  activeProject(project: string | null): void;
  github: Github;
  atp: Atp;
  atpRuns: AtpRuns;
  atpThreads: AtpThreads;
  auth: PiAuth;
  plugins: PiPlugins;
  chatImport: ChatImporter;
  setup: PiSetup;
  browser(): BrowserManager | undefined;
  /** Frames and input for phones; exists with the browser manager. */
  remoteBrowser(): RemoteBrowser | undefined;
  updater(): Updater | undefined;
  devices: DeviceStore;
  push: PushService;
  /** Files a phone sent. */
  uploads: Uploads;
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

/** Minimum gap between `computer.preview` calls of one client. */
const PREVIEW_INTERVAL_MS = 1000;

/** The desktop's view of a chat: the last page and a line for each earlier turn (its turn rail pages them in). */
const DESKTOP_PAGE = { turns: PAGE_TURNS, bytes: PAGE_BYTES, outline: true };

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

/** Uploads belong to a device; the desktop never has one. */
const deviceOf = (ctx: HostContext): string => {
  if (ctx.client === "desktop") throw new HostError("scope_denied", "uploads belong to a phone");
  return ctx.client.device;
};

const chatHandle = (handle: unknown): string => {
  if (typeof handle !== "string" || !handle) throw new Error("Invalid chat");
  return handle;
};

export const project = (cwd: unknown): string => {
  if (typeof cwd !== "string" || cwd.includes("\0") || !isAbsolute(cwd)) throw new Error("a project is an absolute path");
  return cwd;
};

/** The Plugins section's project, when the page has one. */
const maybeProject = (cwd: unknown): string | undefined => (cwd === undefined || cwd === null ? undefined : project(cwd));

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value || value.length > 4096) throw new Error(`invalid ${what}`);
  return value;
};

const mcpScope = (scope: unknown): "global" | "project" => {
  if (scope !== "global" && scope !== "project") throw new Error("invalid mcp.json scope");
  return scope;
};

const packageScope = (scope: unknown): "user" | "project" => {
  if (scope !== "user" && scope !== "project") throw new Error("invalid package scope");
  return scope;
};

const pluginToggle = (raw: any): PluginToggle => {
  const path = text(raw?.path, "resource");
  if (!RESOURCE_TYPES.includes(raw.type)) throw new Error("invalid resource type");
  if (raw.scope === "global" && typeof raw.enabled === "boolean") return { scope: "global", path, type: raw.type, enabled: raw.enabled };
  if (raw.scope === "project" && ["inherit", "load", "unload"].includes(raw.override)) return { scope: "project", path, type: raw.type, override: raw.override };
  throw new Error("invalid toggle");
};

const packageToggle = (raw: any): PackageToggle => {
  if ((raw?.scope !== "global" && raw?.scope !== "project") || typeof raw.enabled !== "boolean") throw new Error("invalid package toggle");
  return { scope: raw.scope, source: text(raw.source, "package"), packageScope: packageScope(raw.packageScope), enabled: raw.enabled };
};

/** A dependency's failure that explains itself (the Computer Use helper missing from the build, not starting) as a
 * HostError, which a phone sees; the remote server answers any other error with a bare "internal error". */
const explained = <T>(work: Promise<T>): Promise<T> =>
  work.catch((error: unknown) => {
    throw error instanceof HostError ? error : new HostError("unavailable", error instanceof Error ? error.message : String(error));
  });

/** The image targets of each finished answer: a phone's every image would otherwise lex the whole chat again. */
const answerImages = new WeakMap<AssistantMessage, string[]>();

export function createHostCore(deps: HostDeps): Record<string, HostMethodDef> {
  const { host, tasks, board, settings, uiState, computerPolicy, computerHelper, computerPreviews, laments, usage, github, atp, atpRuns, atpThreads, auth, plugins, native } = deps;
  // Spawning pi, rg, git, gh or node needs the login-shell environment (PATH, API keys); reading pi's files needs only
  // its folders (PI_CODING_AGENT_DIR), which are known sooner.
  const env = () => deps.shellEnv;
  const piDirs = () => deps.piDirs;
  /** clientId -> when it last asked for a Computer Use preview. */
  const previews = new Map<string, number>();
  /** A live chat's directory and the folders whose files it may open on a phone: the directory and its project. */
  const chatRoots = (handle: string): { cwd: string; roots: string[] } => {
    const cwd = host.cwdOf(handle);
    if (!cwd) throw new HostError("not_found", "session is not running");
    return { cwd, roots: [...new Set([cwd, projectOf(cwd)])] };
  };
  /**
   * The image files the chat's own answers embed, as paths, which a phone loads wherever they are: the agent showed
   * them, and it reads any file a phone could ask it for, so this adds nothing a phone could not already get. Only
   * the agent's answers count (a phone writes the user's messages) and only images (other embeds are file links,
   * confined like any link). docs/REMOTE_THREAT_MODEL.md.
   */
  const shownImages = (handle: string, cwd: string): Set<string> => {
    const shown = new Set<string>();
    for (const item of host.stateOf(handle)?.items ?? []) {
      if (item.kind !== "assistant") continue;
      let targets = answerImages.get(item.message);
      if (!targets) {
        targets = item.message.content.flatMap((block) => (block.type === "text" ? embeddedImageTargets(block.text) : []));
        if (!item.streaming) answerImages.set(item.message, targets);
      }
      for (const target of targets) {
        const path = parseLinkTarget(target, cwd, homedir())?.path;
        if (path && kindFor(path) === "image") shown.add(path);
      }
    }
    return shown;
  };
  /** Where a phone's link targets resolve: the chat's cwd, or `from` (the folder of a file it shows) inside its folders. */
  const linkBase = async (handle: string, from: string | undefined): Promise<{ base: string; roots: string[] }> => {
    const { cwd, roots } = chatRoots(handle);
    if (from === undefined) return { base: cwd, roots };
    if (!(await within(from, roots))) throw new HostError("scope_denied", "the folder is outside this chat's folders");
    return { base: from, roots };
  };
  const linkFrom = (raw: unknown): string | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !isAbsolute(raw) || raw.length > 4096 || raw.includes("\0")) throw new Error("Invalid from");
    return raw;
  };
  /** What a send names, as attachments: the caller's own uploads by id, or paths on the host (as the desktop picker gives them). */
  const resolveAttachments = async (ctx: HostContext, refs: AttachmentRef[] | undefined): Promise<PickedPath[]> => {
    if (refs === undefined) return [];
    if (!Array.isArray(refs) || refs.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new HostError("bad_request", `at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
    return Promise.all(
      refs.map(async (ref) => {
        if (ref && typeof ref === "object" && "upload" in ref) return deps.uploads.resolve(deviceOf(ctx), ref.upload);
        const path = (ref as { path?: unknown } | undefined)?.path;
        const [picked] = await describePaths(typeof path === "string" ? [path] : []);
        if (!picked) throw new HostError("not_found", "no such file on the host");
        return picked;
      }),
    );
  };
  return {
    "app.info": any("remote", () => deps.app),
    "chat.list": any("remote", async () => (await piDirs(), listSessions())),
    "chat.open": any<{ request: OpenSessionRequest }>("remote", async (ctx, { request }) => {
      await env();
      // The window gets its first page with the answer; a phone reads the chat through chat.snapshot (a shorter page).
      return host.open(request, { client: presence(ctx) }, ctx.client === "desktop" ? DESKTOP_PAGE : undefined);
    }),
    "chat.snapshot": method<{ handle: string; before?: number; offset?: number; turns?: number; bytes?: number }>(
      "remote",
      (raw) => {
        if (typeof raw.handle !== "string") throw new Error("Invalid chat");
        if (raw.before !== undefined && !(Number.isInteger(raw.before) && raw.before >= 0)) throw new Error("Invalid turn cursor");
        if (raw.offset !== undefined && !(raw.before !== undefined && Number.isInteger(raw.offset) && raw.offset >= 0)) throw new Error("Invalid turn cursor");
        if (raw.turns !== undefined && !(Number.isInteger(raw.turns) && raw.turns >= 1 && raw.turns <= PAGE_TURNS)) throw new Error("Invalid page size");
        if (raw.bytes !== undefined && !(Number.isInteger(raw.bytes) && raw.bytes >= 1 && raw.bytes <= PAGE_BYTES)) throw new Error("Invalid page size");
        return { handle: raw.handle, before: raw.before as number | undefined, offset: raw.offset as number | undefined, turns: raw.turns as number | undefined, bytes: raw.bytes as number | undefined };
      },
      async (ctx, { handle, before, offset, turns, bytes }) => {
        const page = { turns: turns ?? PAGE_TURNS, beforeTurn: before, offset, bytes: bytes ?? PAGE_BYTES };
        const snapshot = await host.snapshot(handle, ctx.client === "desktop" ? page : { ...page, imagesByUrl: true });
        if (!snapshot) throw new HostError("not_found", "session is not running");
        const { seq, ...value } = snapshot;
        return { seq, value };
      },
    ),
    "chat.close": any<{ handle: string }>("remote", (_ctx, { handle }) => host.close(handle)),
    "chat.command": any<{ handle: string; command: RpcCommand }>("remote", (_ctx, { handle, command }) => host.command(handle, command)),
    "chat.detach": any<{ handle: string }>("remote", (ctx, { handle }) => host.detach(handle, ctx.clientId)),
    "chat.attach": any<{ handle: string }>("remote", async (ctx, { handle }) => {
      try {
        host.attach(handle, presence(ctx));
      } catch {
        return null; // it ended meanwhile
      }
      // Attach and snapshot in one turn: the snapshot's seq says which events the client must still apply. Both page
      // the transcript in through chat.snapshot: the window gets its first page here, a phone only the seq.
      const snapshot = await host.snapshot(handle, ctx.client === "desktop" ? DESKTOP_PAGE : { turns: 1 });
      if (!snapshot) return null;
      return ctx.client === "desktop" ? snapshot : { seq: snapshot.seq };
    }),
    "chat.viewing": any<{ handle: string; viewing: boolean }>("remote", (ctx, { handle, viewing }) => host.viewing(handle, ctx.clientId, viewing === true)),
    "chat.shown": any<{ handle: string; shown: boolean }>("desktop", (ctx, { handle, shown }) => host.shown(handle, ctx.clientId, shown === true)),
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
    "chat.send": any<{ handle: string; text: string; mode?: "send" | "followUp"; cardId?: string; attachments?: AttachmentRef[]; annotations?: unknown[] }>("remote", async (ctx, args) => {
      // The phone keeps its browser comments and sends them with the prompt; the host composes the block and the crops.
      let annotations: Annotation[] = [];
      try {
        annotations = args.annotations?.length ? parseAnnotations(args.annotations) : [];
      } catch (error) {
        throw new HostError("bad_request", (error as Error).message);
      }
      const attachments = await resolveAttachments(ctx, args.attachments);
      return tasks.send(String(args.handle), String(args.text ?? ""), args.mode === "followUp" ? "followUp" : "send", args.cardId, attachments, annotations);
    }),
    "chat.files": any<{ cwd: string }>("remote", async (_ctx, { cwd }) => (await env(), listFiles(cwd))),
    "chat.compactionSettings": any("remote", async () => (await piDirs(), readCompactionSettings())),
    "fs.browseFolders": any<{ path?: string; files?: boolean; hidden?: boolean }>("remote", (_ctx, { path, files, hidden }) => browse(deps.app.homeDir, path, files === true, hidden === true)),
    "uploads.discard": any<{ id: string }>("remote", async (ctx, { id }) => {
      await deps.uploads.discard(deviceOf(ctx), id);
      return null;
    }),
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
    "browser.still": any("desktop", async () => (await deps.browser()?.still()) ?? null),
    "browser.focus": any<{ chat?: string }>("desktop", (_ctx, { chat }) => deps.browser()?.focus(typeof chat === "string" ? chat : undefined)),
    // `agent`: the chat the tab belongs to (a phone opens tabs from a chat's browser); otherwise the chat on the Mac's screen.
    "browser.newTab": any<{ url?: string; agent?: string }>("remote", (_ctx, { url, agent }) => {
      const tab = deps.browser()?.createTab(url, typeof agent === "string" ? agent : undefined);
      return tab ? { id: tab.id } : null;
    }),
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
    // The frames themselves ride GET /api/browser/view/<tab> (remote-server); this names the stream and checks the tab.
    "browser.view": method<{ id: string; on: boolean }>(
      "remote",
      (raw) => ({ ...tabId(raw), on: raw.on === true }),
      (_ctx, { id, on }) => (on && deps.browser()?.tabs.has(id) ? { stream: `/api/browser/view/${id}` } : null),
    ),
    "browser.input": method<{ id: string; input: BrowserInput }>(
      "remote",
      (raw) => {
        if (!raw.input || typeof raw.input !== "object" || typeof raw.input.type !== "string") throw new Error("Invalid browser input");
        return { ...tabId(raw), input: raw.input as BrowserInput };
      },
      (_ctx, { id, input }) => {
        const remote = deps.remoteBrowser();
        if (!remote) throw new HostError("unavailable", "The browser is not ready");
        return remote.input(id, input);
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
    "browser.preview": method<{ path: string; options?: PreviewOpenOptions }>(
      "desktop",
      (raw) => {
        if (typeof raw.path !== "string" || !isAbsolute(raw.path) || raw.path.length > 4096 || raw.path.includes("\0")) throw new Error("Invalid file path");
        const o = raw.options && typeof raw.options === "object" ? raw.options : {};
        const options: PreviewOpenOptions = {
          newTab: o.newTab === true,
          into: typeof o.into === "string" ? o.into : undefined,
          line: Number.isInteger(o.line) && o.line > 0 ? o.line : undefined,
          mode: o.mode === "rendered" || o.mode === "raw" ? o.mode : undefined,
          root: typeof o.root === "string" && isAbsolute(o.root) ? o.root : undefined,
        };
        return { path: raw.path, options };
      },
      async (_ctx, { path, options }) => {
        const browser = deps.browser();
        if (!browser) throw new Error("The browser is not ready");
        return (await browser.openPreview(path, options)).id;
      },
    ),
    "browser.card": method<{ card: string }>(
      "desktop",
      (raw) => {
        if (typeof raw.card !== "string" || !raw.card) throw new Error("Invalid card id");
        return { card: raw.card };
      },
      (_ctx, { card }) => {
        const browser = deps.browser();
        if (!browser) throw new Error("The browser is not ready");
        return browser.openCard(card).id;
      },
    ),
    "browser.previewMode": method<{ id: string; mode: PreviewMode }>(
      "remote",
      (raw) => {
        if (raw.mode !== "rendered" && raw.mode !== "raw") throw new Error("Invalid preview mode");
        return { ...tabId(raw), mode: raw.mode as PreviewMode };
      },
      (_ctx, { id, mode }) => {
        deps.browser()?.setPreviewMode(id, mode);
      },
    ),
    "browser.previewReveal": method<{ id: string }>("desktop", tabId, (_ctx, { id }) => {
      deps.browser()?.revealPreview(id);
    }),
    "browser.previewOpen": method<{ id: string }>("desktop", tabId, async (_ctx, { id }) => {
      await deps.browser()?.openPreviewExternally(id);
    }),
    "browser.resolveTargets": method<{ cwd: string; targets: string[] }>(
      "desktop",
      (raw) => {
        if (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd) || raw.cwd.includes("\0")) throw new Error("Invalid directory");
        if (!Array.isArray(raw.targets) || (raw.targets as unknown[]).some((t) => typeof t !== "string" || t.length > 4096 || t.includes("\0"))) throw new Error("Invalid targets");
        return { cwd: raw.cwd, targets: raw.targets as string[] };
      },
      (_ctx, { cwd, targets }) => resolvePreviewTargets(cwd, targets),
    ),
    "browser.readImage": method<{ cwd: string; target: string }>(
      "desktop",
      (raw) => {
        if (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd) || raw.cwd.includes("\0")) throw new Error("Invalid directory");
        if (typeof raw.target !== "string" || raw.target.length > 4096 || raw.target.includes("\0")) throw new Error("Invalid target");
        return { cwd: raw.cwd, target: raw.target };
      },
      (_ctx, { cwd, target }) => readPreviewImage(cwd, target),
    ),
    "browser.siteIcon": method<{ url: string }>(
      "desktop",
      (raw) => {
        if (typeof raw.url !== "string" || raw.url.length > 4096) throw new Error("Invalid url");
        return { url: raw.url };
      },
      (_ctx, { url }) => siteIcon(url),
    ),
    // What a chat links to, for a phone: confined to the chat's folders (`chatRoots`), unlike the desktop methods above,
    // except the images the chat's answers embed (`shownImages`).
    "chat.resolveLinks": method<{ handle: string; targets: string[]; from?: string }>(
      "remote",
      (raw) => {
        if (!Array.isArray(raw.targets) || (raw.targets as unknown[]).some((t) => typeof t !== "string" || t.length > 4096 || t.includes("\0"))) throw new Error("Invalid targets");
        return { handle: chatHandle(raw.handle), targets: raw.targets as string[], from: linkFrom(raw.from) };
      },
      async (_ctx, { handle, targets, from }) => {
        const { base, roots } = await linkBase(handle, from);
        const paths = await resolvePreviewTargets(base, targets);
        const confined = await Promise.all(paths.map((path) => within(path, roots)));
        // Outside the folders, a chat's answer still shows the images it embeds (not those of a file it shows).
        if (from !== undefined || paths.every((path, index) => !path || confined[index])) return confined;
        const shown = shownImages(handle, base);
        return confined.map((path, index) => path ?? (paths[index] && shown.has(paths[index]) ? paths[index] : null));
      },
    ),
    "chat.linkImage": method<{ handle: string; target: string; from?: string }>(
      "remote",
      (raw) => {
        if (typeof raw.target !== "string" || raw.target.length > 4096 || raw.target.includes("\0")) throw new Error("Invalid target");
        return { handle: chatHandle(raw.handle), target: raw.target, from: linkFrom(raw.from) };
      },
      async (_ctx, { handle, target, from }) => {
        const { base, roots } = await linkBase(handle, from);
        const shown = from === undefined && shownImages(handle, base).has(parseLinkTarget(target, base, homedir())?.path ?? "");
        return readPreviewImage(base, target, shown ? undefined : roots);
      },
    ),
    // A text file the phone draws itself instead of streaming the Mac's preview tab (docs/FILE_PREVIEW.md, Phone).
    "chat.readFile": method<{ handle: string; path: string }>(
      "remote",
      (raw) => {
        if (typeof raw.path !== "string" || !isAbsolute(raw.path) || raw.path.length > 4096 || raw.path.includes("\0")) throw new Error("Invalid file path");
        return { handle: chatHandle(raw.handle), path: raw.path };
      },
      async (_ctx, { handle, path }) => {
        const { roots } = chatRoots(handle);
        if (!(await within(path, roots))) throw new HostError("scope_denied", "the file is outside this chat's folders");
        const file = await readPreviewText(path, roots);
        if (!file) throw new HostError("not_found", "no such file");
        return file;
      },
    ),
    "chat.openFile": method<{ handle: string; path: string; line?: number }>(
      "remote",
      (raw) => {
        if (typeof raw.path !== "string" || !isAbsolute(raw.path) || raw.path.length > 4096 || raw.path.includes("\0")) throw new Error("Invalid file path");
        return { handle: chatHandle(raw.handle), path: raw.path, line: Number.isInteger(raw.line) && (raw.line as number) > 0 ? (raw.line as number) : undefined };
      },
      async (_ctx, { handle, path, line }) => {
        const { cwd, roots } = chatRoots(handle);
        const browser = deps.browser();
        if (!browser) throw new Error("The browser is not ready");
        if (!(await within(path, roots))) throw new HostError("scope_denied", "the file is outside this chat's folders");
        return { id: (await browser.openPreview(path, { agent: handle, root: cwd, line })).id };
      },
    ),
    "browser.history": any("remote", () => deps.browser()?.getHistory() ?? []),
    "browser.favicon": method<{ key: string }>(
      "remote",
      (raw) => {
        if (typeof raw.key !== "string" || raw.key.length > 64) throw new Error("Invalid favicon key");
        return { key: raw.key };
      },
      (_ctx, { key }) => deps.browser()?.favicon(key) ?? null,
    ),
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
    "themes.get": any("remote", () => deps.themes.get()),
    "themes.apply": any<{ op: ThemeOp; baseRev?: number }>("desktop", (_ctx, { op, baseRev }) => applyTheme(deps.themes, op, baseRev)),
    "themes.image": method<{ project: string; kind: "wallpaper" | "logo" }>(
      "remote",
      (raw) => {
        if (typeof raw?.project !== "string" || (raw.kind !== "wallpaper" && raw.kind !== "logo")) throw new HostError("bad_request", "a project and wallpaper or logo");
        return { project: raw.project, kind: raw.kind };
      },
      async (_ctx, { project, kind }) => themeImage(await deps.themes.get(), project, kind),
    ),
    "themes.active": any<{ project: string | null }>("desktop", (_ctx, { project }) => {
      deps.activeProject(typeof project === "string" ? project : null);
      return null;
    }),

    "computer.get": any("remote", () => computerPolicy.get()),
    "computer.apply": any<{ op: ComputerOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => computerPolicy.apply(op, baseRev)),
    "computer.permissions": any("remote", () => explained(computerHelper.call("permissions", {}))),
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
    // A viewer may ask for a frame at most once per PREVIEW_INTERVAL_MS; the chat must hold the app (ComputerAgent.preview).
    "computer.preview": any<{ handle: string; since?: string }>("remote", (ctx, { handle, since }) => {
      if (typeof handle !== "string") throw new HostError("bad_request", "handle is required");
      const now = Date.now();
      if (now - (previews.get(ctx.clientId) ?? 0) < PREVIEW_INTERVAL_MS) throw new HostError("rate_limited", "computer previews are limited to one per second");
      previews.set(ctx.clientId, now);
      if (previews.size > 200) for (const [id, at] of previews) if (now - at > PREVIEW_INTERVAL_MS) previews.delete(id);
      return computerPreviews.frame(handle, since);
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

    "usage.get": method<{ query: UsageQuery }>("remote", (raw) => ({ query: parseUsageQuery(raw?.query) }), (_ctx, { query }) => usage.get(query)),
    "usage.refresh": any("remote", async () => {
      await usage.refresh();
      return null;
    }),
    "settings.get": any("remote", () => settings.get()),
    "settings.apply": any<{ op: SettingsOp; baseRev?: number }>("remote", (ctx, { op, baseRev }) => {
      // Yolo lets every chat act without asking: only the person at the Mac may switch it.
      if (op?.type === "yolo" && ctx.client !== "desktop") throw new HostError("scope_denied", "yolo can only be changed on the Mac");
      return settings.apply(op, baseRev);
    }),
    "ui.get": any("remote", () => uiState.get()),
    "ui.apply": any<{ op: UiOp; baseRev?: number }>("remote", (_ctx, { op, baseRev }) => uiState.apply(op, baseRev)),
    "ui.importLegacy": any<{ ui: unknown }>("desktop", async (_ctx, { ui }) => (await uiState.importLegacy(ui), null)),
    // pi's settings.json moves with PI_CODING_AGENT_DIR, which can come from the login shell.
    "settings.pi": any("remote", async () => (await piDirs(), readPiSettings())),
    "settings.setPi": any<{ patch: unknown }>("remote", async (_ctx, { patch }) => (await piDirs(), writePiSettings(patch))),
    "settings.revealPi": any("desktop", async () => {
      await piDirs();
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

    // pi's packages and MCP servers, changed in pi's own files with the pi on the login shell's PATH.
    "plugins.catalog": any("desktop", () => plugins.catalog()),
    "plugins.state": method<{ cwd?: string }>("desktop", (raw) => ({ cwd: maybeProject(raw.cwd) }), async (_ctx, { cwd }) => (await env(), plugins.state(cwd))),
    "plugins.status": method<{ cwd?: string }>("desktop", (raw) => ({ cwd: maybeProject(raw.cwd) }), async (_ctx, { cwd }) => (await env(), plugins.status(cwd))),
    "plugins.toggle": method<{ cwd?: string; toggle: PluginToggle }>(
      "desktop",
      (raw) => ({ cwd: maybeProject(raw.cwd), toggle: pluginToggle(raw.toggle) }),
      async (_ctx, { cwd, toggle }) => (await env(), await plugins.toggle(cwd, toggle), null),
    ),
    "plugins.togglePackage": method<{ cwd?: string; toggle: PackageToggle }>(
      "desktop",
      (raw) => ({ cwd: maybeProject(raw.cwd), toggle: packageToggle(raw.toggle) }),
      async (_ctx, { cwd, toggle }) => (await env(), await plugins.togglePackage(cwd, toggle), null),
    ),
    "plugins.install": method<{ id: string }>("desktop", (raw) => ({ id: text(raw.id, "catalog id") }), async (_ctx, { id }) => (await env(), await plugins.install(id), null)),
    "plugins.recommend": any("desktop", async () => (await env(), await plugins.recommend(), null)),
    "plugins.remove": method<{ cwd?: string; source: string; scope: "user" | "project" }>(
      "desktop",
      (raw) => ({ cwd: maybeProject(raw.cwd), source: text(raw.source, "package"), scope: packageScope(raw.scope) }),
      async (_ctx, { cwd, source, scope }) => (await env(), await plugins.remove(cwd, source, scope), null),
    ),
    "plugins.connect": method<{ id: string; endpoint: string; token?: string }>(
      "desktop",
      (raw) => ({ id: text(raw.id, "catalog id"), endpoint: text(raw.endpoint, "endpoint"), ...(raw.token !== undefined && raw.token !== null && { token: text(raw.token, "token") }) }),
      async (_ctx, { id, endpoint, token }) => (await env(), await plugins.connect(id, endpoint, token), null),
    ),
    "plugins.disconnect": method<{ cwd?: string; server: string; scope: "global" | "project" }>(
      "desktop",
      (raw) => ({ cwd: maybeProject(raw.cwd), server: text(raw.server, "server"), scope: mcpScope(raw.scope) }),
      async (_ctx, { cwd, server, scope }) => (await env(), await plugins.disconnect(cwd, server, scope), null),
    ),
    "plugins.enableServer": method<{ cwd?: string; server: string; scope: "global" | "project"; enabled: boolean }>(
      "desktop",
      (raw) => {
        if (typeof raw.enabled !== "boolean") throw new Error("invalid enabled");
        return { cwd: maybeProject(raw.cwd), server: text(raw.server, "server"), scope: mcpScope(raw.scope), enabled: raw.enabled };
      },
      async (_ctx, { cwd, server, scope, enabled }) => (await env(), await plugins.enableServer(cwd, server, scope, enabled), null),
    ),
    "plugins.login": method<{ cwd?: string; server: string }>(
      "desktop",
      (raw) => ({ cwd: maybeProject(raw.cwd), server: text(raw.server, "server") }),
      async (_ctx, { cwd, server }) => (await env(), plugins.signIn(server, cwd)),
    ),
    // First-run Setup: Node.js, pi and pi's package, with the login shell's PATH; installs pi with npm.
    "setup.status": any("desktop", async () => (await env(), deps.setup.status())),
    "setup.installPi": any("desktop", async () => (await env(), deps.setup.installPi())),

    // CODEX_HOME, CLAUDE_CONFIG_DIR and PI_CODING_AGENT_DIR can come from the login shell.
    "import.scan": any("desktop", async () => (await env(), deps.chatImport.scan())),
    "import.run": method<{ projects: string[] }>(
      "desktop",
      (raw) => {
        if (!Array.isArray(raw.projects) || raw.projects.length > 10_000) throw new Error("invalid projects");
        return { projects: raw.projects.map(project) };
      },
      async (_ctx, { projects }) => (await env(), deps.chatImport.run(projects)),
    ),
    "plugins.cancelLogin": any("desktop", () => (plugins.cancelSignIn(), null)),
    "plugins.logout": method<{ cwd?: string; server: string }>(
      "desktop",
      (raw) => ({ cwd: maybeProject(raw.cwd), server: text(raw.server, "server") }),
      async (_ctx, { cwd, server }) => (await env(), await plugins.signOut(server, cwd), null),
    ),

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
    // A project's plans without watching it: the phone asks again while its ATP page is open (the desktop's watch is one project for all).
    "atp.plans": method<{ cwd: string }>("remote", (raw) => ({ cwd: project(raw.cwd) }), async (_ctx, { cwd }) => (await env(), atp.scan(cwd))),
    "atp.read": method<{ plan: string }>("remote", (raw) => ({ plan: planPath(raw.plan) }), (_ctx, { plan }) => atp.read(plan)),
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
    // Notifications belong to the phone that asks (a subscription is per device); the desktop has none.
    "push.vapidKey": any("remote", () => deps.push.vapidKey()),
    "push.state": any("remote", (ctx) => deps.push.state(deviceOf(ctx))),
    "push.subscribe": method<{ endpoint: unknown; p256dh: unknown; auth: unknown }>("remote", (raw) => ({ endpoint: raw.endpoint, p256dh: raw.p256dh, auth: raw.auth }), (ctx, args) => (deps.push.subscribe(deviceOf(ctx), args), null)),
    "push.unsubscribe": any("remote", (ctx) => (deps.push.unsubscribe(deviceOf(ctx)), null)),
    "push.setPrefs": method<{ prefs: unknown }>("remote", (raw) => ({ prefs: raw.prefs }), (ctx, { prefs }) => deps.push.setPrefs(deviceOf(ctx), prefs)),
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
  route(IPC.pageSession, "chat.snapshot", (handle, before, turns, offset) => ({ handle, before, turns, ...(offset !== undefined && { offset }) })),
  route(IPC.viewing, "chat.viewing", (handle, viewing) => ({ handle, viewing }), true),
  route(IPC.shown, "chat.shown", (handle, shown) => ({ handle, shown }), true),
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
  route(IPC.browserStill, "browser.still"),
  route(IPC.browserFocus, "browser.focus", (chat) => ({ chat }), true),
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
  route(IPC.browserPreview, "browser.preview", (path, options) => ({ path, options })),
  route(IPC.browserCard, "browser.card", (card) => ({ card })),
  route(IPC.browserPreviewMode, "browser.previewMode", (id, mode) => ({ id, mode })),
  route(IPC.browserPreviewReveal, "browser.previewReveal", (id) => ({ id })),
  route(IPC.browserResolveTargets, "browser.resolveTargets", (cwd, targets) => ({ cwd, targets })),
  route(IPC.browserReadImage, "browser.readImage", (cwd, target) => ({ cwd, target })),
  route(IPC.browserSiteIcon, "browser.siteIcon", (url) => ({ url })),
  route(IPC.browserPreviewOpen, "browser.previewOpen", (id) => ({ id })),
  route(IPC.browserHistory, "browser.history"),
  route(IPC.browserFavicon, "browser.favicon", (key) => ({ key })),
  route(IPC.browserGetState, "browser.state"),
  route(IPC.boardGet, "board.get"),
  route(IPC.boardApply, "board.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.boardSaveImage, "board.saveImage", (card, image) => ({ card, image })),
  route(IPC.addCard, "board.addCard", (cwd, column, description, attachments) => ({ cwd, column, description, attachments })),
  route(IPC.lamentsGet, "laments.get"),
  route(IPC.lamentsApply, "laments.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.themesGet, "themes.get"),
  route(IPC.themesApply, "themes.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.themesImage, "themes.image", (project, kind) => ({ project, kind })),
  route(IPC.themesActive, "themes.active", (project) => ({ project }), true),
  route(IPC.computerGet, "computer.get"),
  route(IPC.computerApply, "computer.apply", (op, baseRev) => ({ op, baseRev })),
  route(IPC.computerPermissions, "computer.permissions"),
  route(IPC.computerRequest, "computer.requestPermissions", (pane) => ({ pane })),
  route(IPC.computerOpenSettings, "computer.openSettings", (pane) => ({ pane })),
  route(IPC.settingsGet, "settings.get"),
  route(IPC.usageGet, "usage.get", (query) => ({ query })),
  route(IPC.usageRefresh, "usage.refresh"),
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
  route(IPC.pluginsCatalog, "plugins.catalog"),
  route(IPC.pluginsState, "plugins.state", (cwd) => ({ cwd })),
  route(IPC.pluginsStatus, "plugins.status", (cwd) => ({ cwd })),
  route(IPC.pluginsToggle, "plugins.toggle", (cwd, toggle) => ({ cwd, toggle })),
  route(IPC.pluginsTogglePackage, "plugins.togglePackage", (cwd, toggle) => ({ cwd, toggle })),
  route(IPC.pluginsInstall, "plugins.install", (id) => ({ id })),
  route(IPC.pluginsRecommend, "plugins.recommend"),
  route(IPC.pluginsRemove, "plugins.remove", (cwd, source, scope) => ({ cwd, source, scope })),
  route(IPC.pluginsConnect, "plugins.connect", (id, endpoint, token) => ({ id, endpoint, token })),
  route(IPC.pluginsDisconnect, "plugins.disconnect", (cwd, server, scope) => ({ cwd, server, scope })),
  route(IPC.pluginsEnableServer, "plugins.enableServer", (cwd, server, scope, enabled) => ({ cwd, server, scope, enabled })),
  route(IPC.pluginsLogin, "plugins.login", (cwd, server) => ({ cwd, server })),
  route(IPC.pluginsCancelLogin, "plugins.cancelLogin", () => ({}), true),
  route(IPC.pluginsLogout, "plugins.logout", (cwd, server) => ({ cwd, server })),
  route(IPC.setupStatus, "setup.status"),
  route(IPC.setupInstallPi, "setup.installPi"),
  route(IPC.importScan, "import.scan"),
  route(IPC.importRun, "import.run", (projects) => ({ projects })),
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
