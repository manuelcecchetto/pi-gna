import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Board } from "../shared/board";
import type { AtpProjectPlans } from "../shared/atp";
import type { LoginUpdate } from "../shared/auth";
import type { Annotation, BrowserState } from "../shared/browser";
import type { ComputerSettings } from "../shared/computer";
import type { Laments } from "../shared/laments";
import type { Settings, SettingsSection } from "../shared/settings";
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
  relaunch: () => ipcRenderer.invoke(IPC.relaunch),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  openSession: (request) => ipcRenderer.invoke(IPC.openSession, request),
  closeSession: (handle) => ipcRenderer.invoke(IPC.closeSession, handle),
  command: (handle, command) => ipcRenderer.invoke(IPC.command, handle, command),
  respondUi: (handle, response) => ipcRenderer.send(IPC.respondUi, handle, response),
  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pickAttachments: (kind) => ipcRenderer.invoke(IPC.pickAttachments, kind),
  describePaths: (paths) => ipcRenderer.invoke(IPC.describePaths, paths),
  compactionSettings: () => ipcRenderer.invoke(IPC.compactionSettings),
  cardWorktree: (card) => ipcRenderer.invoke(IPC.cardWorktree, card),
  lamentWorktree: (lament) => ipcRenderer.invoke(IPC.lamentWorktree, lament),
  windowFocused: () => ipcRenderer.invoke(IPC.windowFocused),
  onWindowFocus: (listener) => subscribe<boolean>(IPC.windowFocus, listener),
  onSidebarToggle: (listener) => subscribe<void>(IPC.sidebarToggle, listener),
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
    history: () => ipcRenderer.invoke(IPC.browserHistory),
    state: () => ipcRenderer.invoke(IPC.browserGetState),
    onState: (listener) => subscribe<BrowserState>(IPC.browserState, listener),
    onReveal: (listener) => subscribe<void>(IPC.browserReveal, listener),
    onAnnotation: (listener) => subscribe<Annotation>(IPC.browserAnnotation, listener),
    onToggle: (listener) => subscribe<void>(IPC.browserToggle, listener),
  },
  board: {
    get: () => ipcRenderer.invoke(IPC.boardGet),
    apply: (op) => ipcRenderer.invoke(IPC.boardApply, op),
    onChange: (listener) => subscribe<Board>(IPC.boardChanged, listener),
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
    activate: (plan) => ipcRenderer.invoke(IPC.atpActivate, plan),
    claim: (plan, agent) => ipcRenderer.invoke(IPC.atpClaim, plan, agent),
    release: (plan, node, agent, reason) => ipcRenderer.invoke(IPC.atpRelease, plan, node, agent, reason),
    head: (cwd) => ipcRenderer.invoke(IPC.atpHead, cwd),
    commit: (cwd, node, title, before) => ipcRenderer.invoke(IPC.atpCommit, cwd, node, title, before),
    held: () => ipcRenderer.invoke(IPC.atpGetHeld),
    onHeld: (listener) => subscribe<string[]>(IPC.atpHeld, listener),
    setHeld: (plan, held) => ipcRenderer.invoke(IPC.atpSetHeld, plan, held),
    info: () => ipcRenderer.invoke(IPC.atpInfo),
  },
  laments: {
    get: () => ipcRenderer.invoke(IPC.lamentsGet),
    apply: (op) => ipcRenderer.invoke(IPC.lamentsApply, op),
    onChange: (listener) => subscribe<Laments>(IPC.lamentsChanged, listener),
  },
  computer: {
    get: () => ipcRenderer.invoke(IPC.computerGet),
    apply: (op) => ipcRenderer.invoke(IPC.computerApply, op),
    onChange: (listener) => subscribe<ComputerSettings>(IPC.computerChanged, listener),
    permissions: () => ipcRenderer.invoke(IPC.computerPermissions),
    requestPermissions: (pane) => ipcRenderer.invoke(IPC.computerRequest, pane),
    openSettings: (pane) => ipcRenderer.invoke(IPC.computerOpenSettings, pane),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    apply: (op) => ipcRenderer.invoke(IPC.settingsApply, op),
    onChange: (listener) => subscribe<Settings>(IPC.settingsChanged, listener),
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
  update: {
    state: () => ipcRenderer.invoke(IPC.updateGet),
    onState: (listener) => subscribe<UpdateState>(IPC.updateState, listener),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    onReveal: (listener) => subscribe<void>(IPC.updateReveal, listener),
  },
};

contextBridge.exposeInMainWorld("studio", api);
