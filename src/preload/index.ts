import { contextBridge, ipcRenderer } from "electron";
import { type HostEventBatch, IPC, type StudioApi } from "../shared/ipc";

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
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  onEvents(listener) {
    const handler = (_event: unknown, batch: HostEventBatch) => listener(batch);
    ipcRenderer.on(IPC.events, handler);
    return () => ipcRenderer.off(IPC.events, handler);
  },
};

contextBridge.exposeInMainWorld("studio", api);
