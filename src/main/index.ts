import { EventHub } from "./event-hub";
import { responsePreview } from "../shared/push-rules";
import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { app, BrowserWindow, dialog, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, Menu, nativeTheme, powerSaveBlocker, screen, session, shell } from "electron";
import { bugs } from "../../package.json";
import type { AtpHead } from "../shared/atp";
import type { AuthMethod } from "../shared/auth";
import type { BoardOp } from "../shared/board";
import type { BrowserCommand, BrowserLayout } from "../shared/browser";
import type { ViewportRequest } from "../shared/viewport";
import type { GithubFilter, GithubKind } from "../shared/github";
import type { ComputerOp } from "../shared/computer";
import type { LamentOp } from "../shared/laments";
import { HostError, type QueueEdit } from "../shared/host-api";
import { type DialogAnswer, type HostEvent, type HostEventBatch, IPC, type OpenSessionRequest, type Page } from "../shared/ipc";
import type { ExtensionUiResponse, RpcCommand } from "../shared/protocol";
import { emptySettings, type Feature, hidesOnClose, type Settings, type SettingsOp, wantsKeepAwake } from "../shared/settings";
import { effectiveTheme } from "../shared/themes";
import { Atp, librarianPath } from "./atp";
import { AtpRuns } from "./atp-runner";
import { AtpThreads } from "./atp-threads";
import { BrowserAgent, browserRoute } from "./browser/agent";
import { BrowserManager, PARTITION } from "./browser/manager";
import { RemoteBrowser } from "./browser/remote-view";
import { attachContextMenu } from "./context-menu";
import { APP_ORIGIN, registerAppScheme, serveRenderer } from "./app-protocol";
import { serveVisual } from "./visual-protocol";
import { servePreview } from "./browser/preview-protocol";
import { VISUAL_SCHEME, visualFrameToKill } from "./visual-frame";
import { describePaths, IMAGE_EXTENSIONS } from "./attachments";
import { Uploads } from "./uploads";
import { BoardStore } from "./board";
import { CardImages } from "./card-images";
import { AgentBridge } from "./bridge";
import { listFiles } from "./files";
import { Github, GithubStore } from "./github";
import { kanbanRoute } from "./kanban";
import { ComputerAgent, computerRoute } from "./computer/agent";
import { ComputerService, defaultDeps, HELPER_APP } from "./computer/service";
import { ComputerStore } from "./computer/store";
import { LamentStore, lamentRoute } from "./laments";
import { ThemeStore, themeRoute } from "./themes";
import { PiAuth } from "./pi-auth";
import { PiPlugins } from "./plugins";
import { PiSetup } from "./setup";
import { readCompactionSettings, readPiSettings, writePiSettings } from "./pi-settings";
import { onDisk } from "./resources";
import { SettingsStore } from "./settings";
import { UiStateStore } from "./ui-state";
import { cardWorktree } from "./worktree";
import { ChatTasks } from "./chat-tasks";
import { IdempotencyCache } from "./command-layer";
import { DeviceStore } from "./devices";
import { PushService } from "./push-service";
import { RemoteHost } from "./remote";
import { RemoteServer } from "./remote-server";
import { TailscaleCli } from "./tailscale";
import { createHostCore, dispatch, type HostContext, IPC_ROUTES } from "./host-core";
import { debugRpc, log, logToFile } from "./log";
import { SessionHost } from "./session-host";
import { listSessions, sessionsDir } from "./session-index";
import { loadShellEnv } from "./shell-env";
import { Updater } from "./updater";
import { initialWindowState, readWindowState, trackWindowState } from "./window-state";

// The app's name (menus, About, profile and log folders) is package.json's productName.
// Test instances (scripts/cdp.mjs) get their own profile and logs so they never share a browser profile or history
// with the pi-gna you are working in.
if (process.env.PIGNA_USER_DATA) {
  app.setPath("userData", process.env.PIGNA_USER_DATA);
  app.setAppLogsPath(join(process.env.PIGNA_USER_DATA, "logs"));
} else {
  adoptProfile("pi studio", "pi-studio-browser");
}
// The browser pane's cookies would otherwise be encrypted with a key in the login keychain ("pi-gna Safe Storage"),
// and with an ad-hoc signature macOS asks for it again after every update. A fixed key is enough for this profile.
if (process.platform === "darwin") app.commandLine.appendSwitch("use-mock-keychain");
const logFile = join(app.getPath("logs"), "main.log");
mkdirSync(app.getPath("logs"), { recursive: true });
logToFile(logFile);

const devUrl = process.env.ELECTRON_RENDERER_URL;
// Launched from a terminal (bin/pi-gna.mjs, `pi --pigna`), new chats start where you launched it and the
// environment is your shell's. From Finder or the Dock the cwd is / and the environment is launchd's.
const fromTerminal = Boolean(process.env.PIGNA_CWD);
const launchCwd = process.env.PIGNA_CWD || (process.cwd() === "/" ? homedir() : process.cwd());

/**
 * First launch after a rename: copy the profile of the app's previous name (browser cookies and history) into
 * this one. Copied, not moved, so a still-running old build keeps working; Chromium's singleton lock files are
 * left behind, or this instance would think the old one owns the new profile. The profile folder itself already
 * exists by now (Chromium puts Crashpad there before any app code runs), so "Local State" marks a used profile.
 */
function adoptProfile(oldName: string, oldPartition: string): void {
  const profile = app.getPath("userData");
  const old = join(dirname(profile), oldName);
  if (existsSync(join(profile, "Local State")) || !existsSync(join(old, "Local State"))) return;
  cpSync(old, profile, { recursive: true, filter: (path) => !/^(Singleton|DevToolsActivePort|Crashpad)/.test(basename(path)) });
  const partitions = join(profile, "Partitions");
  if (existsSync(join(partitions, oldPartition))) renameSync(join(partitions, oldPartition), join(partitions, PARTITION.replace(/^persist:/, "")));
  console.log(`copied the ${oldName} profile to ${profile}`);
}

let window: BrowserWindow | undefined;
let current: Settings = emptySettings();
let keepAwakeId: number | undefined;
/** Set once the app is really quitting, so the window closes instead of hiding. */
let quitting = false;
let browser: BrowserManager | undefined;
let agent: BrowserAgent | undefined;
let remoteBrowser: RemoteBrowser | undefined;
let updater: Updater | undefined;
const bridge = new AgentBridge();
const send = (channel: string, ...args: unknown[]) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
};
// Window-only UI pushes stay direct `send`s (they are the desktop shell, not host state): menu toggles (pageToggle,
// sidebarToggle, paletteToggle, browserToggle), windowFocus, openProject and updateReveal. Everything else goes through the hub.
const hub = new EventHub();
const publish = (event: { kind: string; [key: string]: unknown }) => hub.publish("global", event);
// The desktop window is one hub subscriber, on the same IPC channels and payloads as before the hub.
hub.subscribe({
  topics: "all",
  deliver: (batch) => {
    const topic = batch[0]?.topic ?? "global";
    if (topic.startsWith("chat:")) {
      send(IPC.events, { handle: topic.slice(5), events: batch.map((e) => e.event as HostEvent), seq: batch.at(-1)?.seq } satisfies HostEventBatch);
      return;
    }
    for (const { event } of batch) {
      const e = event as Record<string, any>;
      switch (e.kind) {
        case "attention": send(IPC.attention, { chats: e.chats, removed: e.removed }); break;
        case "settings": send(IPC.settingsChanged, e.settings); break;
        case "ui": send(IPC.uiChanged, e.ui); break;
        case "board": send(IPC.boardChanged, e.board); break;
        case "laments": send(IPC.lamentsChanged, e.laments); break;
        case "themes": send(IPC.themesChanged, e.themes); break;
        case "computer": send(IPC.computerChanged, e.settings); break;
        case "atp.plans": send(IPC.atpPlans, e.plans); break;
        case "atp.held": send(IPC.atpHeld, e.plans); break;
        case "atp.runners": send(IPC.atpRunners, { runners: e.runners, notes: e.notes, orchestrators: e.orchestrators }); break;
        case "atp.threads": send(IPC.atpThreadsChanged, { plan: e.plan, threads: e.threads }); break;
        case "browser": send(IPC.browserState, e.state); break;
        case "browser.reveal": send(IPC.browserReveal, e.chat); break;
        case "browser.annotation": send(IPC.browserAnnotation, { annotation: e.annotation, send: e.send === true }); break;
        case "update": send(IPC.updateState, e.state); break;
        case "devices": send(IPC.devicesChanged, e.devices); break;
        case "remote": send(IPC.remoteChanged, e.status); break;
      }
    }
  },
});
// Remote access (docs/REMOTE.md): paired devices exist from launch; the server and Tailscale wiring come with the host core.
let remoteServer: RemoteServer | undefined;
let remoteHost: RemoteHost | undefined;
// Web Push (REMOTE.md 13a); made once the session host exists, and a device that vanishes takes its subscription along.
let push: PushService | undefined;
let knownDevices = new Set<string>();
const devices = new DeviceStore(
  join(app.getPath("userData"), "remote-devices.json"),
  (list) => {
    // Audit trail (REMOTE.md s.11): who was added or removed, ids only.
    const now = new Set(list.map((device) => device.id));
    for (const id of now) if (!knownDevices.has(id)) log.info("remote", `device paired ${id}`);
    for (const id of knownDevices) if (!now.has(id)) log.info("remote", `device revoked ${id}`);
    knownDevices = now;
    remoteServer?.devicesChanged(list);
    push?.keepDevices(list.map((device) => device.id));
    publish({ kind: "devices", devices: list });
    void remoteHost?.announce();
  },
  (status) => {
    // The pairing code and the approval prompt are for this window only: they never go through the hub.
    send(IPC.pairingChanged, status);
    log.info("remote", `pairing ${status.state}`);
    if (status.state === "pending_approval" && window && !window.isDestroyed()) process.env.PIGNA_BACKGROUND === "1" ? window.showInactive() : window.show();
  },
);
const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"), (next) => {
  publish({ kind: "settings", settings: next });
  applySettings(next);
});
/** The window's lease on the chats it opens (it keeps them until it closes them). */
const DESKTOP = { clientId: "desktop", actor: "desktop" } as const;
const host = new SessionHost((batch) => hub.publishBatch(`chat:${batch.handle}`, batch.events).at(-1)?.seq, bridge, join(app.getPath("userData"), "atp-sessions"), async () => ({
  ...(await settings.get()).features,
  // The Computer Use helper is a macOS app.
  computer: process.platform === "darwin" && (await computerPolicy.get()).enabled,
  visuals: (await settings.get()).visuals,
}), () => current.yolo);
host.onGlobal(publish);
const pushService = new PushService(join(app.getPath("userData"), "remote-push.json"), { viewing: (handle) => host.presence(handle).some((client) => client.viewing), preview: (handle) => responsePreview(host.stateOf(handle)?.items ?? []) });
push = pushService;
hub.subscribe({ topics: ["global"], deliver: (batch) => batch.forEach(({ event }) => pushService.onGlobal(event as { kind: string })) });
const board = new BoardStore(join(app.getPath("userData"), "board.json"), (next) => publish({ kind: "board", board: next }));
const cardImages = new CardImages(join(app.getPath("userData"), "card-images"));
const uploads = new Uploads(join(app.getPath("userData"), "remote-uploads"));
void uploads.prune().catch((error: Error) => log.warn("remote", `could not prune old uploads: ${error.message}`));
bridge.route("/browser", browserRoute(() => agent));
const uiState = new UiStateStore(join(app.getPath("userData"), "ui-state.json"), (next) => publish({ kind: "ui", ui: next }));
const computerPolicy = new ComputerStore(join(app.getPath("userData"), "computer-use.json"), (next) => publish({ kind: "computer", settings: next }));
const laments = new LamentStore(join(app.getPath("userData"), "laments.json"), (next) => publish({ kind: "laments", laments: next }));
bridge.route("/kanban", settings.gate("kanban", kanbanRoute(board, (handle) => host.identify(handle))));
// The helper starts on first use only: the Computer Use page asking for permissions, or a tool.
const computerHelper = new ComputerService(
  defaultDeps(app.isPackaged ? join(process.resourcesPath, "computer-use", HELPER_APP) : join(app.getAppPath(), "build", "computer-use", HELPER_APP), app.getPath("userData")),
);
const computerAgent = new ComputerAgent(
  computerHelper,
  computerPolicy,
  {
    choose: (handle, title, options) => host.requestChoice(handle, title, options),
    chatName: (handle) => host.chatName(handle),
    abort: (handle) => host.command(handle, { type: "abort" }),
  },
  { ownNames: [app.getName(), app.getName().replace(/\.dev$/i, "")] },
);
bridge.route("/computer", computerRoute(() => computerAgent));
host.onRunEnd((handle) => void computerAgent.release(handle));
host.onExit((handle) => browser?.closeTabsOf(handle));
bridge.route("/lament", settings.gate("laments", lamentRoute(laments, (handle) => host.identify(handle))));
const themes = new ThemeStore(join(app.getPath("userData"), "themes.json"), (next) => {
  publish({ kind: "themes", themes: next });
  void applyAppearance();
});
bridge.route("/theme", themeRoute(themes, settings, async (handle) => (await host.identify(handle)).cwd));
/** The project on the window's screen (themes.active): its theme's appearance mode is the app's. */
let activeProject: string | null = null;
const githubSettings = new GithubStore(join(app.getPath("userData"), "github.json"));
const github = new Github(githubSettings);
// The runner and its chats start once the shell environment is known (registerIpc); plans and holds reach it through these.
let atpRuns: AtpRuns | undefined;
const atp = new Atp(
  (plans) => {
    publish({ kind: "atp.plans", plans });
    void atpRuns?.plansChanged(plans);
  },
  (held) => {
    publish({ kind: "atp.held", plans: held });
    atpRuns?.heldChanged();
  },
);
const atpThreads = new AtpThreads(join(app.getPath("userData"), "atp-threads.json"), (plan, threads) => publish({ kind: "atp.threads", plan, threads }));
bridge.route("/atp", settings.gate("atp", atp.route()));
const auth = new PiAuth({ script: onDisk("resources", "pi-auth.mts") });
const plugins = new PiPlugins({
  script: onDisk("resources", "pi-plugins.mts"),
  bundled: onDisk("resources", "plugins", "catalog.json"),
  cache: join(app.getPath("userData"), "plugins-catalog.json"),
  remote: "https://raw.githubusercontent.com/manuelcecchetto/pi-gna/main/resources/plugins/catalog.json",
  onLogin: (update) => send(IPC.pluginsLoginUpdate, update),
});
const setup = new PiSetup({ onLine: (line) => send(IPC.setupLine, line) });

function createWindow(): void {
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const initial = initialWindowState(
    readWindowState(stateFile),
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  window = new BrowserWindow({
    ...initial.bounds,
    minWidth: 760,
    minHeight: 520,
    show: false,
    // macOS draws its traffic lights into pi-gna's own title band; elsewhere the native frame stays, menu bar on Alt.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 18 } } : { autoHideMenuBar: true }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161618" : "#f1f1f0",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--studio-home=${homedir()}`, `--studio-launch-cwd=${launchCwd}`, `--pigna-build=${__PIGNA_BUILD__}`, `--pigna-version=${app.getVersion()}`],
    },
  });
  // PIGNA_BACKGROUND=1 (test instances): show without taking focus, so keystrokes meant for the
  // pi-gna you are working in never land in a test window.
  window.once("ready-to-show", () => {
    log.info("pigna", `window ready ${Math.round(process.uptime() * 1000)} ms after launch`);
    // maximize() also shows the window, but without focus, so it comes before the show below.
    if (initial.maximized) window?.maximize();
    if (process.env.PIGNA_BACKGROUND === "1") window?.showInactive();
    else window?.show();
  });
  // The terminal is the log: surface renderer warnings, errors and crashes there too.
  window.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") {
      log[details.level === "error" ? "error" : "warn"]("renderer", `${details.message}  (${details.sourceId.split("/").at(-1)}:${details.lineNumber})`);
    }
  });
  // With remote access on, closing hides the window: the app, its chats and the browser pane keep running.
  window.on("close", (event) => {
    if (quitting || !hidesOnClose(current)) return;
    event.preventDefault();
    window?.hide();
  });
  trackWindowState(window, stateFile);
  window.on("focus", () => send(IPC.windowFocus, true));
  window.on("blur", () => send(IPC.windowFocus, false));
  window.webContents.on("render-process-gone", (_event, details) => log.error("renderer", `gone: ${details.reason}`));

  // Model output is untrusted: links never navigate the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window?.webContents.getURL()) {
      event.preventDefault();
      openExternal(url);
    }
  });

  // Inline visual frames (sandboxed iframes) may only ever load their own scheme; any navigation inside them is refused.
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !event.url.startsWith(`${VISUAL_SCHEME}://`)) event.preventDefault();
  });

  browser = new BrowserManager(window, {
    state: (state) => publish({ kind: "browser", state }),
    reveal: (chat) => publish({ kind: "browser.reveal", chat }),
    annotation: (annotation, send) => publish({ kind: "browser.annotation", annotation, send }),
  });
  agent = new BrowserAgent(browser);
  remoteBrowser = new RemoteBrowser(browser);
  attachContextMenu(window.webContents, {
    page: false,
    openTab: (url) => {
      const tab = browser?.createTab(url);
      publish({ kind: "browser.reveal", chat: tab?.agent });
    },
  });

  void window.loadURL(devUrl ?? `${APP_ORIGIN}/index.html`);
}

function openExternal(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

/** IPC is only accepted from the app window's own page (Electron security checklist #17). */
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return event.sender === window?.webContents && (url.startsWith(`${APP_ORIGIN}/`) || (devUrl !== undefined && url.startsWith(devUrl)));
}

function handle<A extends unknown[]>(channel: string, listener: (...args: A) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error(`untrusted sender for ${channel}`);
    return listener(...(args as A));
  });
}

function on<A extends unknown[]>(channel: string, listener: (...args: A) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (trusted(event)) listener(...(args as A));
    else log.warn("pigna", `dropped ${channel} from an untrusted sender`);
  });
}

/** The desktop window's side of the host methods: effects that belong to the caller happen on this Mac. */
const desktopContext: HostContext = {
  client: "desktop",
  clientId: DESKTOP.clientId,
  openExternal,
  authUpdate: (update) => send(IPC.authUpdate, update),
};

/** The remote server's per-caller context: a phone's links open on the phone, and its login progress goes to its own stream only. */
const remoteContext = (device: { id: string }, clientId: string): HostContext => ({
  client: { device: device.id },
  clientId,
  openExternal: () => undefined,
  authUpdate: (update) => void remoteServer?.notify(clientId, device.id, { kind: "providers.login", update }),
});

function registerIpc(shellEnv: Promise<void>): void {
  const tasks = new ChatTasks({ host, board, laments, settings, cardImages, worktree: (project, task) => cardWorktree(project, task), shellEnv });
  atpRuns = new AtpRuns({ host, tasks, atp, threads: atpThreads, settings, librarian: librarianPath(), shellEnv, publish: (state) => publish({ kind: "atp.runners", ...state }) });
  // Nothing listens until remote access is turned on in Settings (RemoteHost.sync, from applySettings).
  remoteServer = new RemoteServer({
    devices,
    hub,
    cache: new IdempotencyCache(hub.bootId),
    call: (ctx, name, args) => dispatch(core, ctx, name, args),
    scopeOf: (name) => (Object.hasOwn(core, name) ? core[name]?.scope : undefined),
    context: remoteContext,
    allowedHosts: () => remoteHost?.allowedHosts() ?? [],
    browserView: (tab, viewer, onFrame) => remoteBrowser?.open(tab, viewer, onFrame),
    upload: (device, name, type, body, declared) => uploads.put(device.id, name, type, body, declared),
    buildId: __PIGNA_BUILD__,
    staticDir: join(import.meta.dirname, "../mobile"),
    visualDir: onDisk("resources", "visual"),
    log: (line) => log.info("remote", line),
  });
  remoteHost = new RemoteHost({
    server: remoteServer,
    tailscale: new TailscaleCli(),
    settings,
    devices,
    publish: (status) => publish({ kind: "remote", status }),
    awake: () => keepAwakeId !== undefined,
    // Local testing without Tailscale: PIGNA_REMOTE_LOOPBACK=1 also accepts Host: 127.0.0.1:<port>.
    loopback: process.env.PIGNA_REMOTE_LOOPBACK === "1",
    log: (line) => log.info("remote", line),
  });
  const core = createHostCore({
    shellEnv,
    devices,
    push: pushService,
    uploads,
    remote: remoteHost,
    host,
    tasks,
    board,
    cardImages,
    settings,
    uiState,
    computerPolicy,
    computerHelper,
    computerAgent,
    laments,
    themes,
    activeProject: (project) => {
      activeProject = project;
      void applyAppearance();
    },
    github,
    atp,
    atpRuns,
    atpThreads,
    auth,
    plugins,
    setup,
    browser: () => browser,
    remoteBrowser: () => remoteBrowser,
    updater: () => updater,
    app: { homeDir: homedir(), launchCwd, version: app.getVersion(), buildId: __PIGNA_BUILD__ },
    native: {
      pickFolder: async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      pickAttachments: async (kind) => {
        const options: Electron.OpenDialogOptions =
          kind === "photos"
            ? { title: "Add photos", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] }
            : { title: "Attach files and folders", properties: ["openFile", "openDirectory", "multiSelections"] };
        const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return result.canceled ? [] : describePaths(result.filePaths);
      },
      showItemInFolder: (path) => shell.showItemInFolder(path),
      windowFocused: () => window?.isFocused() ?? false,
      focusBrowserWindow: (id) => browser?.focusWindow(id),
      killVisual: (frameId) => {
        const frames = window?.webContents.mainFrame.framesInSubtree ?? [];
        const pid = visualFrameToKill(frames, frameId, window?.webContents.getOSProcessId() ?? 0);
        if (pid !== undefined) process.kill(pid, "SIGKILL");
      },
    },
  });
  for (const { channel, method, args, send: fireAndForget } of IPC_ROUTES) {
    if (fireAndForget) {
      on(channel, (...positional: unknown[]) => {
        try {
          void Promise.resolve(dispatch(core, desktopContext, method, args(...positional))).catch((error: Error) => log.warn("pigna", `${channel}: ${error.message}`));
        } catch (error) {
          log.warn("pigna", `${channel}: ${(error as Error).message}`);
        }
      });
    } else handle(channel, (...positional: unknown[]) => dispatch(core, desktopContext, method, args(...positional)));
  }
}

/** pi-gna > Check for Updates…: show what GitHub has, also in a checkout (which updates with git, though). */
async function checkForUpdates(): Promise<void> {
  const box = (options: Electron.MessageBoxOptions) => (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  try {
    // Releases carry macOS dmgs only; the Windows beta is a prerelease, updated by hand (docs/WINDOWS.md).
    if (!updater || process.platform !== "darwin") {
      await shell.openExternal(`https://github.com/manuelcecchetto/pi-gna/releases`);
      return;
    }
    const state = await updater.check();
    if (state.phase !== "idle") send(IPC.updateReveal);
    else await box({ message: `${app.getName()} is up to date`, detail: `${app.getVersion()} is the newest version.` });
  } catch (error) {
    await box({ type: "warning", message: "Could not check for updates", detail: (error as Error).message });
  }
}

/** The window follows its appearance setting; the menu shows only the pages of features that are on. Remote access
 * adds the host lifecycle: closing hides the window, the Mac may be kept awake, and pi-gna may open at login. */
function applySettings(next: Settings): void {
  current = next;
  void applyAppearance();
  buildMenu(next.features);
  syncKeepAwake();
  void remoteHost?.sync();
  // Test instances (PIGNA_USER_DATA) never register as login items: that would start them on the real profile's login.
  if (process.platform === "darwin" && !process.env.PIGNA_USER_DATA && app.getLoginItemSettings().openAtLogin !== next.openAtLogin) app.setLoginItemSettings({ openAtLogin: next.openAtLogin });
}

/** Light, dark or the system's: the project on screen's theme, else the setting. Native too, so the window's
 * prefers-color-scheme, its menus and the browser pane's pages follow it. */
async function applyAppearance(): Promise<void> {
  nativeTheme.themeSource = effectiveTheme(await themes.get(), current, activeProject ?? undefined).base;
}

/** Holds a power-save blocker (no idle sleep; the display may still sleep) exactly while the keep-awake setting wants
 * it. It cannot keep a closed MacBook lid awake: macOS sleeps then unless on power with an external display. */
function syncKeepAwake(): void {
  const wanted = wantsKeepAwake(current, host.running > 0);
  if (wanted && keepAwakeId === undefined) {
    keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
    void remoteHost?.announce();
    log.info("pigna", `keep-awake on (${current.remote.keepAwake}, ${host.running} chat(s) running)`);
  } else if (!wanted && keepAwakeId !== undefined) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = undefined;
    void remoteHost?.announce();
    log.info("pigna", `keep-awake off (${current.remote.enabled ? current.remote.keepAwake : "remote access off"}, ${host.running} chat(s) running)`);
  }
}

/** Quit asks first when remote access is on and something would be cut off. Paired devices will count too once pairing exists. */
function confirmQuit(): boolean {
  const running = host.running;
  if (!hidesOnClose(current) || running === 0) return true;
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Quit pi-gna?",
    detail: `${running} chat${running === 1 ? " is" : "s are"} still running, and remote access stops. Close the window instead to keep serving.`,
  });
  return choice === 0;
}

function buildMenu(features: Record<Feature, boolean> = emptySettings().features): void {
  const page = (feature: Feature, label: string, accelerator: string, page: Page): Electron.MenuItemConstructorOptions[] =>
    features[feature] ? [{ label, accelerator, click: () => send(IPC.pageToggle, page) }] : [];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        // Not role "appMenu", whose own submenu would replace this one.
        label: app.name,
        submenu: [
          // Settings > About, not the native panel: the version, links, license and credits in one place.
          { label: `About ${app.name}`, click: () => send(IPC.pageToggle, "settings", "about") },
          { label: "Check for Updates…", click: () => void checkForUpdates() },
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send(IPC.pageToggle, "settings") },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          // A menu accelerator, not a renderer keydown: it also works while the browser's web view has focus.
          { label: "Search…", accelerator: "CmdOrCtrl+K", click: () => send(IPC.paletteToggle) },
          { type: "separator" },
          { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+Shift+S", click: () => send(IPC.sidebarToggle) },
          { label: "Toggle Browser", accelerator: "CmdOrCtrl+B", click: () => send(IPC.browserToggle) },
          ...page("kanban", "Kanban", "CmdOrCtrl+Shift+K", "kanban"),
          ...page("laments", "Laments", "CmdOrCtrl+Shift+L", "laments"),
          ...page("github", "GitHub", "CmdOrCtrl+Shift+G", "github"),
          ...page("atp", "ATP", "CmdOrCtrl+Shift+A", "atp"),
          { label: "Computer Use", accelerator: "CmdOrCtrl+Shift+U", click: () => send(IPC.pageToggle, "settings", "computer") },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: "Show Logs", click: () => void shell.openPath(logFile) },
          { type: "separator" },
          { label: "pi Documentation", click: () => openExternal("https://pi.dev") },
          { label: "Report an Issue", click: () => openExternal(bugs.url) },
        ],
      },
    ]),
  );
}

function init(): void {
  registerAppScheme();
  // Set before ready so Electron never builds its default menu (performance checklist).
  buildMenu();
  const shellEnv = app.isPackaged && !fromTerminal ? loadShellEnv() : Promise.resolve();

  updater = new Updater(logFile, (state) => publish({ kind: "update", state }));
  // After the windows closed and every pi child stopped: a staged update replaces this app once it exits.
  app.on("will-quit", () => {
    setup.dispose();
    updater?.installOnQuit();
  });

  let forced = false;
  app.on("before-quit", (event) => {
    if (!quitting && !forced && !confirmQuit()) {
      event.preventDefault();
      return;
    }
    bridge.stop();
    auth.close();
    plugins.close();
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (keepAwakeId !== undefined) powerSaveBlocker.stop(keepAwakeId);
    if (host.size) log.info("pigna", `stopping ${host.size} pi session(s)`);
    // Phones learn the Mac is quitting (best effort, bounded) while the network is still up.
    const quitPush = push && current.remote.enabled ? Promise.race([push.notifyQuit(), new Promise((resolve) => setTimeout(resolve, 3000))]) : undefined;
    void Promise.allSettled([quitPush, remoteHost?.stop(), host.closeAll(), devices.flushed(), board.flushed(), laments.flushed(), themes.flushed(), computerPolicy.flushed(), settings.flushed(), uiState.flushed(), githubSettings.flushed(), computerAgent.releaseAll().finally(() => computerHelper.stop())]).finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (!hidesOnClose(current)) app.quit();
  });
  // Dock click while the window is hidden (remote access on) shows it again.
  app.on("activate", () => {
    if (!window || window.isDestroyed()) createWindow();
    else window.show();
  });
  host.onRunningChange(syncKeepAwake);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      forced = true;
      app.quit();
    });
  // A second launch on this profile (say `pi --pigna` in another project) opens a chat here instead.
  app.on("second-instance", (_event, _argv, _cwd, data) => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    const cwd = (data as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === "string") send(IPC.openProject, cwd);
  });
  // No <webview> tags anywhere (security checklist #12); the browser pane uses WebContentsView.
  app.on("web-contents-created", (_event, contents) => contents.on("will-attach-webview", (event) => event.preventDefault()));

  void app.whenReady().then(async () => {
    log.info("pigna", `${app.getName()} ${app.getVersion()} build ${__PIGNA_BUILD__}  electron ${process.versions.electron}  sessions ${sessionsDir()}  log ${logFile}`);
    log.info("pigna", `launch cwd ${launchCwd}${debugRpc ? "  (RPC debug on)" : "  (PIGNA_DEBUG=1 logs RPC traffic)"}`);
    if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(join(app.getAppPath(), "resources", "icon.png"));
    // The window only ever asks for clipboard writes (copy buttons); the browser pane's partition has its own handler.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
    serveVisual();
    servePreview(join(import.meta.dirname, "../preview"));
    if (!devUrl) serveRenderer(join(import.meta.dirname, "../renderer"));
    registerIpc(shellEnv);
    // Before the window, so it opens in its appearance (and with its background color).
    applySettings(await settings.get());
    await bridge.start();
    createWindow();
    if (process.platform === "darwin") updater?.start();
  });
}

// One instance per profile: a second one hands its launch directory to the first and quits. Test instances use
// their own PIGNA_USER_DATA profile, so they run beside the app you work in.
if (app.requestSingleInstanceLock({ cwd: process.env.PIGNA_CWD })) init();
else {
  log.info("pigna", `already running with this profile${process.env.PIGNA_CWD ? `; opening a new chat in ${process.env.PIGNA_CWD} there` : ""}`);
  app.quit();
}
