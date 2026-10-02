import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, Menu, nativeTheme, session, shell } from "electron";
import { bugs, description } from "../../package.json";
import type { BrowserCommand, BrowserLayout } from "../shared/browser";
import { type HostEventBatch, IPC, type OpenSessionRequest } from "../shared/ipc";
import type { ExtensionUiResponse, RpcCommand } from "../shared/protocol";
import { BrowserAgent } from "./browser/agent";
import { AgentBridge } from "./browser/bridge";
import { BrowserManager } from "./browser/manager";
import { APP_ORIGIN, registerAppScheme, serveRenderer } from "./app-protocol";
import { describePaths, IMAGE_EXTENSIONS } from "./attachments";
import { listFiles } from "./files";
import { readCompactionSettings } from "./pi-settings";
import { debugRpc, log, logToFile } from "./log";
import { SessionHost } from "./session-host";
import { listSessions, sessionsDir } from "./session-index";
import { loadShellEnv } from "./shell-env";

// The app's name (menus, About, profile and log folders) is package.json's productName.
// Test instances (scripts/cdp.mjs) get their own profile and logs so they never share a browser profile or history
// with the studio you are working in.
if (process.env.PI_STUDIO_USER_DATA) {
  app.setPath("userData", process.env.PI_STUDIO_USER_DATA);
  app.setAppLogsPath(join(process.env.PI_STUDIO_USER_DATA, "logs"));
}
const logFile = join(app.getPath("logs"), "main.log");
mkdirSync(app.getPath("logs"), { recursive: true });
logToFile(logFile);

const devUrl = process.env.ELECTRON_RENDERER_URL;
// Launched from a terminal (bin/pi-studio.mjs, `pi --studio`), new chats start where you launched it and the
// environment is your shell's. From Finder or the Dock the cwd is / and the environment is launchd's.
const fromTerminal = Boolean(process.env.PI_STUDIO_CWD);
const launchCwd = process.env.PI_STUDIO_CWD || (process.cwd() === "/" ? homedir() : process.cwd());

let window: BrowserWindow | undefined;
let browser: BrowserManager | undefined;
let agent: BrowserAgent | undefined;
const bridge = new AgentBridge(() => agent);
const send = (channel: string, ...args: unknown[]) => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
};
const host = new SessionHost((batch: HostEventBatch) => send(IPC.events, batch), bridge);

function createWindow(): void {
  window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 760,
    minHeight: 520,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#161618" : "#f1f1f0",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      additionalArguments: [`--studio-home=${homedir()}`, `--studio-launch-cwd=${launchCwd}`],
    },
  });
  // PI_STUDIO_BACKGROUND=1 (test instances): show without taking focus, so keystrokes meant for the
  // studio you are working in never land in a test window.
  window.once("ready-to-show", () => {
    log.info("studio", `window ready ${Math.round(process.uptime() * 1000)} ms after launch`);
    if (process.env.PI_STUDIO_BACKGROUND === "1") window?.showInactive();
    else window?.show();
  });
  // The terminal is the log: surface renderer warnings, errors and crashes there too.
  window.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") {
      log[details.level === "error" ? "error" : "warn"]("renderer", `${details.message}  (${details.sourceId.split("/").at(-1)}:${details.lineNumber})`);
    }
  });
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

  browser = new BrowserManager(window, {
    state: (state) => send(IPC.browserState, state),
    reveal: () => send(IPC.browserReveal),
    annotation: (annotation) => send(IPC.browserAnnotation, annotation),
  });
  agent = new BrowserAgent(browser);

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
    else log.warn("studio", `dropped ${channel} from an untrusted sender`);
  });
}

function registerIpc(shellEnv: Promise<void>): void {
  // pi, rg and session listing depend on the login-shell environment (PATH, PI_CODING_AGENT_DIR, API keys).
  handle(IPC.listSessions, async () => (await shellEnv, listSessions()));
  handle(IPC.openSession, async (request: OpenSessionRequest) => (await shellEnv, host.open(request)));
  handle(IPC.closeSession, (handle: string) => host.close(handle));
  handle(IPC.command, (handle: string, command: RpcCommand) => host.command(handle, command));
  on(IPC.respondUi, (handle: string, response: ExtensionUiResponse) => host.respondUi(handle, response));
  handle(IPC.listFiles, async (cwd: string) => (await shellEnv, listFiles(cwd)));
  handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  on(IPC.openExternal, (url: string) => openExternal(url));
  handle(IPC.compactionSettings, async () => (await shellEnv, readCompactionSettings()));
  handle(IPC.windowFocused, () => window?.isFocused() ?? false);
  handle(IPC.describePaths, (paths: string[]) => describePaths(Array.isArray(paths) ? paths : []));
  handle(IPC.pickAttachments, async (kind: "photos" | "files") => {
    const options: Electron.OpenDialogOptions =
      kind === "photos"
        ? { title: "Add photos", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] }
        : { title: "Attach files and folders", properties: ["openFile", "openDirectory", "multiSelections"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : describePaths(result.filePaths);
  });

  on(IPC.browserLayout, (layout: BrowserLayout) => browser?.setLayout(layout));
  on(IPC.browserNewTab, (url?: string) => browser?.createTab(url));
  on(IPC.browserCloseTab, (id: string) => browser?.closeTab(id));
  on(IPC.browserActivate, (id: string) => browser?.activate(id));
  on(IPC.browserNavigate, (id: string, input: string) => browser?.navigate(id, input));
  on(IPC.browserCommand, (id: string, command: BrowserCommand) => browser?.command(id, command));
  on(IPC.browserAnnotate, (enabled: boolean) => browser?.setAnnotating(enabled));
  on(IPC.browserInspect, (id: string) => browser?.inspect(id));
  handle(IPC.browserHistory, () => browser?.getHistory() ?? []);
  handle(IPC.browserGetState, () => browser?.snapshot());
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+Shift+S", click: () => send(IPC.sidebarToggle) },
          { label: "Toggle Browser", accelerator: "CmdOrCtrl+B", click: () => send(IPC.browserToggle) },
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

  let quitting = false;
  app.on("before-quit", (event) => {
    bridge.stop();
    if (quitting || host.size === 0) return;
    event.preventDefault();
    quitting = true;
    log.info("studio", `stopping ${host.size} pi session(s)`);
    void host.closeAll().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  // A second launch on this profile (say `pi --studio` in another project) opens a chat here instead.
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
    log.info("studio", `${app.getName()} ${app.getVersion()}  electron ${process.versions.electron}  sessions ${sessionsDir()}  log ${logFile}`);
    log.info("studio", `launch cwd ${launchCwd}${debugRpc ? "  (RPC debug on)" : "  (PI_STUDIO_DEBUG=1 logs RPC traffic)"}`);
    if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(join(app.getAppPath(), "resources", "icon.png"));
    app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), credits: description });
    // The window only ever asks for clipboard writes (copy buttons); the browser pane's partition has its own handler.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "clipboard-sanitized-write"));
    if (!devUrl) serveRenderer(join(import.meta.dirname, "../renderer"));
    registerIpc(shellEnv);
    await bridge.start();
    createWindow();
  });
}

// One instance per profile: a second one hands its launch directory to the first and quits. Test instances use
// their own PI_STUDIO_USER_DATA profile, so they run beside the app you work in.
if (app.requestSingleInstanceLock({ cwd: process.env.PI_STUDIO_CWD })) init();
else {
  log.info("studio", `already running with this profile${process.env.PI_STUDIO_CWD ? `; opening a new chat in ${process.env.PI_STUDIO_CWD} there` : ""}`);
  app.quit();
}
