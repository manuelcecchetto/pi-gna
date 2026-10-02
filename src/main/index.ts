import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import type { BrowserCommand, BrowserLayout } from "../shared/browser";
import { type HostEventBatch, IPC, type OpenSessionRequest } from "../shared/ipc";
import type { ExtensionUiResponse, RpcCommand } from "../shared/protocol";
import { BrowserAgent } from "./browser/agent";
import { AgentBridge } from "./browser/bridge";
import { BrowserManager } from "./browser/manager";
import { describePaths, IMAGE_EXTENSIONS } from "./attachments";
import { listFiles } from "./files";
import { readCompactionSettings } from "./pi-settings";
import { debugRpc, log } from "./log";
import { SessionHost } from "./session-host";
import { listSessions, sessionsDir } from "./session-index";

app.setName("pi studio");
// Test instances (scripts/cdp.mjs) get their own profile so they never share a browser profile or history
// with the studio you are working in.
if (process.env.PI_STUDIO_USER_DATA) app.setPath("userData", process.env.PI_STUDIO_USER_DATA);
const launchCwd = process.env.PI_STUDIO_CWD || process.cwd();

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
  window.once("ready-to-show", () => (process.env.PI_STUDIO_BACKGROUND === "1" ? window?.showInactive() : window?.show()));
  // The terminal is the log: surface renderer warnings, errors and crashes there too.
  window.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") {
      log[details.level === "error" ? "error" : "warn"]("renderer", `${details.message}  (${details.sourceId.split("/").at(-1)}:${details.lineNumber})`);
    }
  });
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

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function openExternal(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function registerIpc(): void {
  ipcMain.handle(IPC.listSessions, () => listSessions());
  ipcMain.handle(IPC.openSession, (_event, request: OpenSessionRequest) => host.open(request));
  ipcMain.handle(IPC.closeSession, (_event, handle: string) => host.close(handle));
  ipcMain.handle(IPC.command, (_event, handle: string, command: RpcCommand) => host.command(handle, command));
  ipcMain.on(IPC.respondUi, (_event, handle: string, response: ExtensionUiResponse) => host.respondUi(handle, response));
  ipcMain.handle(IPC.listFiles, (_event, cwd: string) => listFiles(cwd));
  ipcMain.handle(IPC.pickFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.on(IPC.openExternal, (_event, url: string) => openExternal(url));
  ipcMain.handle(IPC.compactionSettings, () => readCompactionSettings());
  ipcMain.handle(IPC.describePaths, (_event, paths: string[]) => describePaths(Array.isArray(paths) ? paths : []));
  ipcMain.handle(IPC.pickAttachments, async (_event, kind: "photos" | "files") => {
    const options: Electron.OpenDialogOptions =
      kind === "photos"
        ? { title: "Add photos", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] }
        : { title: "Attach files and folders", properties: ["openFile", "openDirectory", "multiSelections"] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : describePaths(result.filePaths);
  });

  ipcMain.on(IPC.browserLayout, (_event, layout: BrowserLayout) => browser?.setLayout(layout));
  ipcMain.on(IPC.browserNewTab, (_event, url?: string) => browser?.createTab(url));
  ipcMain.on(IPC.browserCloseTab, (_event, id: string) => browser?.closeTab(id));
  ipcMain.on(IPC.browserActivate, (_event, id: string) => browser?.activate(id));
  ipcMain.on(IPC.browserNavigate, (_event, id: string, input: string) => browser?.navigate(id, input));
  ipcMain.on(IPC.browserCommand, (_event, id: string, command: BrowserCommand) => browser?.command(id, command));
  ipcMain.on(IPC.browserAnnotate, (_event, on: boolean) => browser?.setAnnotating(on));
  ipcMain.on(IPC.browserInspect, (_event, id: string) => browser?.inspect(id));
  ipcMain.handle(IPC.browserHistory, () => browser?.getHistory() ?? []);
  ipcMain.handle(IPC.browserGetState, () => browser?.snapshot());
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
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
    ]),
  );
}

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

void app.whenReady().then(async () => {
  log.info("studio", `pi studio ${app.getVersion()}  electron ${process.versions.electron}  sessions ${sessionsDir()}`);
  log.info("studio", `launch cwd ${launchCwd}${debugRpc ? "  (RPC debug on)" : "  (PI_STUDIO_DEBUG=1 logs RPC traffic)"}`);
  const icon = join(app.getAppPath(), "resources", "icon.png");
  if (process.platform === "darwin") app.dock?.setIcon(icon);
  buildMenu();
  registerIpc();
  await bridge.start();
  createWindow();
});
