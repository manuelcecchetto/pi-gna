import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import type { Board } from "../shared/board";
import type { AtpProjectPlans } from "../shared/atp";
import type { LoginUpdate } from "../shared/auth";
import type { Annotation, BrowserState } from "../shared/browser";
import type { ComputerSettings } from "../shared/computer";
import type { Laments } from "../shared/laments";
import type { Themes } from "../shared/themes";
import type { McpLoginUpdate } from "../shared/plugins";
import type { Settings, SettingsSection } from "../shared/settings";
import type { AtpPlanThreads, AtpRunnerState, DeviceInfo, PairingStatus, RemoteStatus, Revved, UiState } from "../shared/host-api";
import { type HostEventBatch, IPC, type Page, type StudioApi, type UpdateState } from "../shared/ipc";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const api: StudioApi = {
  homeDir: arg("studio-home"),
  launchCwd: arg("studio-launch-cwd"),
  stale: arg("pigna-build") !== __PIGNA_BUILD__,
  version: arg("pigna-version"),
  runtime: { electron: process.versions.electron ?? "", chrome: process.versions.chrome ?? "", node: process.versions.node },
  zoomFactor: () => webFrame.getZoomFactor(),
  relaunch: () => ipcRenderer.invoke(IPC.relaunch),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  onSessionIndexed: (listener) => subscribe(IPC.sessionIndexed, listener),
  openSession: (request) => ipcRenderer.invoke(IPC.openSession, request),
  closeSession: (handle) => ipcRenderer.invoke(IPC.closeSession, handle),
  command: (handle, command) => ipcRenderer.invoke(IPC.command, handle, command),
  detachSession: (handle) => ipcRenderer.invoke(IPC.detachSession, handle),
  attachSession: (handle) => ipcRenderer.invoke(IPC.attachSession, handle),
  pageSession: (handle, before, turns, offset) => ipcRenderer.invoke(IPC.pageSession, handle, before, turns, offset),
  viewing: (handle, viewing) => ipcRenderer.send(IPC.viewing, handle, viewing),
  shown: (handle, shown) => ipcRenderer.send(IPC.shown, handle, shown),
  liveChats: () => ipcRenderer.invoke(IPC.liveChats),
  onAttention: (listener) => subscribe(IPC.attention, listener),
  interrupt: (handle) => ipcRenderer.invoke(IPC.interrupt, handle),
  editQueue: (handle, op) => ipcRenderer.invoke(IPC.editQueue, handle, op),
  respondDialog: (handle, response) => ipcRenderer.invoke(IPC.respondDialog, handle, response),
  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pickAttachments: (kind) => ipcRenderer.invoke(IPC.pickAttachments, kind),
  describePaths: (paths) => ipcRenderer.invoke(IPC.describePaths, paths),
  compactionSettings: () => ipcRenderer.invoke(IPC.compactionSettings),
  startTask: (target) => ipcRenderer.invoke(IPC.startTask, target),
  addCard: (cwd, column, description, attachments) => ipcRenderer.invoke(IPC.addCard, cwd, column, description, attachments),
  windowFocused: () => ipcRenderer.invoke(IPC.windowFocused),
  onWindowFocus: (listener) => subscribe<boolean>(IPC.windowFocus, listener),
  onSidebarToggle: (listener) => subscribe<void>(IPC.sidebarToggle, listener),
  onPaletteToggle: (listener) => subscribe<void>(IPC.paletteToggle, listener),
  onPageToggle: (listener) => {
    const handler = (_event: unknown, page: Page, section?: SettingsSection) => listener(page, section);
    ipcRenderer.on(IPC.pageToggle, handler);
    return () => ipcRenderer.off(IPC.pageToggle, handler);
  },
  onOpenProject: (listener) => subscribe<string>(IPC.openProject, listener),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  killVisual: (frameId) => ipcRenderer.send(IPC.visualKill, frameId),
  onEvents: (listener) => subscribe<HostEventBatch>(IPC.events, listener),
  browser: {
    layout: (layout) => ipcRenderer.send(IPC.browserLayout, layout),
    still: () => ipcRenderer.invoke(IPC.browserStill),
    focus: (chat) => ipcRenderer.send(IPC.browserFocus, chat),
    newTab: (url) => ipcRenderer.send(IPC.browserNewTab, url),
    closeTab: (id) => ipcRenderer.send(IPC.browserCloseTab, id),
    activate: (id) => ipcRenderer.send(IPC.browserActivate, id),
    navigate: (id, input) => ipcRenderer.send(IPC.browserNavigate, id, input),
    command: (id, command) => ipcRenderer.send(IPC.browserCommand, id, command),
    annotate: (on) => ipcRenderer.send(IPC.browserAnnotate, on),
    inspect: (id) => ipcRenderer.send(IPC.browserInspect, id),
    viewport: (id, request) => ipcRenderer.invoke(IPC.browserViewport, id, request),
    popOut: (id) => ipcRenderer.invoke(IPC.browserPopOut, id),
    returnToPane: (id) => ipcRenderer.invoke(IPC.browserReturn, id),
    preview: (path, options) => ipcRenderer.invoke(IPC.browserPreview, path, options),
    resolvePreviewTargets: (cwd, targets) => ipcRenderer.invoke(IPC.browserResolveTargets, cwd, targets),
    readPreviewImage: (cwd, target) => ipcRenderer.invoke(IPC.browserReadImage, cwd, target),
    siteIcon: (url) => ipcRenderer.invoke(IPC.browserSiteIcon, url),
    previewMode: (id, mode) => ipcRenderer.invoke(IPC.browserPreviewMode, id, mode),
    card: (card) => ipcRenderer.invoke(IPC.browserCard, card),
    previewReveal: (id) => ipcRenderer.invoke(IPC.browserPreviewReveal, id),
    previewOpen: (id) => ipcRenderer.invoke(IPC.browserPreviewOpen, id),
    history: () => ipcRenderer.invoke(IPC.browserHistory),
    favicon: (key) => ipcRenderer.invoke(IPC.browserFavicon, key),
    state: () => ipcRenderer.invoke(IPC.browserGetState),
    onState: (listener) => subscribe<BrowserState>(IPC.browserState, listener),
    onReveal: (listener) => subscribe<string | undefined>(IPC.browserReveal, listener),
    onAnnotation: (listener) => subscribe<{ annotation: Annotation; send: boolean }>(IPC.browserAnnotation, ({ annotation, send }) => listener(annotation, send)),
    onToggle: (listener) => subscribe<void>(IPC.browserToggle, listener),
  },
  board: {
    get: () => ipcRenderer.invoke(IPC.boardGet),
    apply: (op, baseRev) => ipcRenderer.invoke(IPC.boardApply, op, baseRev),
    onChange: (listener) => subscribe<Revved<Board>>(IPC.boardChanged, listener),
    saveImage: (card, image) => ipcRenderer.invoke(IPC.boardSaveImage, card, image),
  },
  github: {
    project: (cwd, refresh) => ipcRenderer.invoke(IPC.githubProject, cwd, refresh),
    choose: (cwd, login) => ipcRenderer.invoke(IPC.githubChoose, cwd, login),
    list: (cwd, kind, filter) => ipcRenderer.invoke(IPC.githubList, cwd, kind, filter),
    lookup: (cwd, input) => ipcRenderer.invoke(IPC.githubLookup, cwd, input),
  },
  atp: {
    watch: (cwd) => ipcRenderer.invoke(IPC.atpWatch, cwd),
    onPlans: (listener) => subscribe<AtpProjectPlans>(IPC.atpPlans, listener),
    read: (plan) => ipcRenderer.invoke(IPC.atpRead, plan),
    state: () => ipcRenderer.invoke(IPC.atpState),
    onRunners: (listener) => subscribe<AtpRunnerState>(IPC.atpRunners, listener),
    onHeld: (listener) => subscribe<string[]>(IPC.atpHeld, listener),
    start: (plan, cwd) => ipcRenderer.invoke(IPC.atpStart, plan, cwd),
    stop: (plan) => ipcRenderer.invoke(IPC.atpStop, plan),
    releaseInterrupted: (plan, node) => ipcRenderer.invoke(IPC.atpReleaseInterrupted, plan, node),
    liftHold: (plan) => ipcRenderer.invoke(IPC.atpLiftHold, plan),
    threads: (plan) => ipcRenderer.invoke(IPC.atpThreads, plan),
    onThreads: (listener) => subscribe<{ plan: string; threads: AtpPlanThreads }>(IPC.atpThreadsChanged, listener),
    orchestrator: (cwd, target) => ipcRenderer.invoke(IPC.atpOrchestrator, cwd, target),
    releaseOrchestrators: () => ipcRenderer.invoke(IPC.atpReleaseOrchestrators),
    discardDraft: (draft) => ipcRenderer.invoke(IPC.atpDiscardDraft, draft),
    importThreads: (threads) => ipcRenderer.invoke(IPC.atpImportThreads, threads),
  },
  laments: {
    get: () => ipcRenderer.invoke(IPC.lamentsGet),
    apply: (op, baseRev) => ipcRenderer.invoke(IPC.lamentsApply, op, baseRev),
    onChange: (listener) => subscribe<Revved<Laments>>(IPC.lamentsChanged, listener),
  },
  themes: {
    get: () => ipcRenderer.invoke(IPC.themesGet),
    apply: (op, baseRev) => ipcRenderer.invoke(IPC.themesApply, op, baseRev),
    onChange: (listener) => subscribe<Revved<Themes>>(IPC.themesChanged, listener),
    image: (project, kind) => ipcRenderer.invoke(IPC.themesImage, project, kind),
    active: (project) => ipcRenderer.send(IPC.themesActive, project),
  },
  computer: {
    get: () => ipcRenderer.invoke(IPC.computerGet),
    apply: (op, baseRev) => ipcRenderer.invoke(IPC.computerApply, op, baseRev),
    onChange: (listener) => subscribe<Revved<ComputerSettings>>(IPC.computerChanged, listener),
    permissions: () => ipcRenderer.invoke(IPC.computerPermissions),
    requestPermissions: (pane) => ipcRenderer.invoke(IPC.computerRequest, pane),
    openSettings: (pane) => ipcRenderer.invoke(IPC.computerOpenSettings, pane),
  },
  ui: {
    get: () => ipcRenderer.invoke(IPC.uiGet),
    apply: (op, baseRev) => ipcRenderer.invoke(IPC.uiApply, op, baseRev),
    onChange: (listener) => subscribe<Revved<UiState>>(IPC.uiChanged, listener),
    importLegacy: (ui) => ipcRenderer.invoke(IPC.uiImportLegacy, ui),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    apply: (op, baseRev) => ipcRenderer.invoke(IPC.settingsApply, op, baseRev),
    onChange: (listener) => subscribe<Revved<Settings>>(IPC.settingsChanged, listener),
    pi: () => ipcRenderer.invoke(IPC.piSettingsGet),
    setPi: (patch) => ipcRenderer.invoke(IPC.piSettingsApply, patch),
    revealPi: () => ipcRenderer.invoke(IPC.piSettingsReveal),
  },
  auth: {
    list: () => ipcRenderer.invoke(IPC.authList),
    login: (provider, method) => ipcRenderer.invoke(IPC.authLogin, provider, method),
    onUpdate: (listener) => subscribe<LoginUpdate>(IPC.authUpdate, listener),
    answer: (n, value) => ipcRenderer.send(IPC.authAnswer, n, value),
    cancel: () => ipcRenderer.send(IPC.authCancel),
    logout: (provider) => ipcRenderer.invoke(IPC.authLogout, provider),
  },
  plugins: {
    catalog: () => ipcRenderer.invoke(IPC.pluginsCatalog),
    state: (cwd) => ipcRenderer.invoke(IPC.pluginsState, cwd),
    status: (cwd) => ipcRenderer.invoke(IPC.pluginsStatus, cwd),
    toggle: (cwd, toggle) => ipcRenderer.invoke(IPC.pluginsToggle, cwd, toggle),
    togglePackage: (cwd, toggle) => ipcRenderer.invoke(IPC.pluginsTogglePackage, cwd, toggle),
    install: (id) => ipcRenderer.invoke(IPC.pluginsInstall, id),
    remove: (cwd, source, scope) => ipcRenderer.invoke(IPC.pluginsRemove, cwd, source, scope),
    connect: (id, endpoint, token) => ipcRenderer.invoke(IPC.pluginsConnect, id, endpoint, token),
    disconnect: (cwd, server, scope) => ipcRenderer.invoke(IPC.pluginsDisconnect, cwd, server, scope),
    enableServer: (cwd, server, scope, enabled) => ipcRenderer.invoke(IPC.pluginsEnableServer, cwd, server, scope, enabled),
    login: (cwd, server) => ipcRenderer.invoke(IPC.pluginsLogin, cwd, server),
    onLogin: (listener) => subscribe<McpLoginUpdate>(IPC.pluginsLoginUpdate, listener),
    cancelLogin: () => ipcRenderer.send(IPC.pluginsCancelLogin),
    logout: (cwd, server) => ipcRenderer.invoke(IPC.pluginsLogout, cwd, server),
  },
  setup: {
    status: () => ipcRenderer.invoke(IPC.setupStatus),
    installPi: () => ipcRenderer.invoke(IPC.setupInstallPi),
    onLine: (listener) => subscribe<string>(IPC.setupLine, listener),
  },
  update: {
    state: () => ipcRenderer.invoke(IPC.updateGet),
    onState: (listener) => subscribe<UpdateState>(IPC.updateState, listener),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    onReveal: (listener) => subscribe<void>(IPC.updateReveal, listener),
  },
  remote: {
    get: () => ipcRenderer.invoke(IPC.remoteGet),
    onChange: (listener) => subscribe<RemoteStatus>(IPC.remoteChanged, listener),
    enable: (port) => ipcRenderer.invoke(IPC.remoteEnable, port),
    disable: () => ipcRenderer.invoke(IPC.remoteDisable),
    serve: () => ipcRenderer.invoke(IPC.remoteServe),
    unserve: () => ipcRenderer.invoke(IPC.remoteUnserve),
    devices: () => ipcRenderer.invoke(IPC.devicesList),
    onDevices: (listener) => subscribe<DeviceInfo[]>(IPC.devicesChanged, listener),
    revoke: (id) => ipcRenderer.invoke(IPC.devicesRevoke, id),
    revokeAll: () => ipcRenderer.invoke(IPC.devicesRevokeAll),
    pairStart: () => ipcRenderer.invoke(IPC.pairStart),
    pairing: () => ipcRenderer.invoke(IPC.pairing),
    pairDecide: (request, allow) => ipcRenderer.invoke(IPC.pairDecide, request, allow),
    onPairing: (listener) => subscribe<PairingStatus>(IPC.pairingChanged, listener),
  },
};

contextBridge.exposeInMainWorld("studio", api);
