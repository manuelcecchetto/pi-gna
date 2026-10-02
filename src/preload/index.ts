import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Annotation, BrowserState } from "../shared/browser";
import { type HostEventBatch, IPC, type StudioApi } from "../shared/ipc";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const api: StudioApi = {
  homeDir: arg("studio-home"),
  launchCwd: arg("studio-launch-cwd"),
  listSessions: () => ipcRenderer.invoke(IPC.listSessions),
  openSession: (request) => ipcRenderer.invoke(IPC.openSession, request),
  closeSession: (handle) => ipcRenderer.invoke(IPC.closeSession, handle),
  command: (handle, command) => ipcRenderer.invoke(IPC.command, handle, command),
  respondUi: (handle, response) => ipcRenderer.send(IPC.respondUi, handle, response),
  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  pickAttachments: (kind) => ipcRenderer.invoke(IPC.pickAttachments, kind),
  describePaths: (paths) => ipcRenderer.invoke(IPC.describePaths, paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
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
    history: () => ipcRenderer.invoke(IPC.browserHistory),
    state: () => ipcRenderer.invoke(IPC.browserGetState),
    onState: (listener) => subscribe<BrowserState>(IPC.browserState, listener),
    onReveal: (listener) => subscribe<void>(IPC.browserReveal, listener),
    onAnnotation: (listener) => subscribe<Annotation>(IPC.browserAnnotation, listener),
    onToggle: (listener) => subscribe<void>(IPC.browserToggle, listener),
  },
};

contextBridge.exposeInMainWorld("studio", api);
