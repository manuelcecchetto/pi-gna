// The desktop's view of chats' subagents (src/shared/subagents.ts): each chat's list from its files, fetched when a list
// shows it and again when its live agents start or settle, merged with what the chat's pi reports live; the subagent
// view (Subview, components/SubagentPane.tsx); and stopping or steering an agent through the chat's `/subagent`.
import { useEffect, useMemo } from "react";
import { isActive, liveSubagents, mergeSubagents, type Subagent, subagentCommand } from "../../../shared/subagents";
import { createStore, useStore } from "../lib/store";
import { command, store, toast } from "./app";

/** Each chat's subagents from its files, by session file. */
const lists = createStore<Record<string, Subagent[]>>({});
const loading = new Map<string, Promise<void>>();

/** Read a chat's subagents from its files again (one read at a time per chat). */
export function loadSubagents(chat: string): Promise<void> {
  const pending = loading.get(chat);
  if (pending) return pending;
  const read = window.studio
    .listSubagents(chat)
    .then((list) => lists.set((all) => ({ ...all, [chat]: list })))
    .catch(() => undefined)
    .finally(() => loading.delete(chat));
  loading.set(chat, read);
  return read;
}

/** The ids and statuses of the live agents: what changes when one starts or settles, not as it works. */
const liveKey = (live: Subagent[]) => live.map((agent) => `${agent.id}:${agent.status}:${agent.file ?? ""}`).join(",");

/**
 * A chat's subagents, newest first: its files' list (read when `want` and whenever its live agents start or settle)
 * merged with the live report `live` (the chat's `pigna-subagents` status). `chat` is its session file.
 */
export function useSubagents(chat: string | undefined, live: string | undefined, want = true): Subagent[] {
  const disk = useStore(lists, (all) => (chat ? all[chat] : undefined));
  const reported = useMemo(() => liveSubagents(live), [live]);
  const key = liveKey(reported);
  useEffect(() => {
    if (want && chat) void loadSubagents(chat);
  }, [want, chat, key]);
  return useMemo(() => mergeSubagents(disk ?? [], reported), [disk, reported]);
}

/** The open chat (its handle) that has this session file, if one runs. */
export function liveHandleOf(chat: string): string | undefined {
  return Object.values(store.get().sessions).find((session) => session.sessionPath === chat && session.phase !== "exited")?.handle;
}

/** Show a subagent's transcript in place of the chat. */
export function openSubagent(chat: string, agent: Subagent, cwd: string, title: string): void {
  store.set((state) => ({ ...state, page: undefined, subview: { chat, agent: agent.id, cwd, title } }));
}

export function closeSubagent(): void {
  store.set((state) => ({ ...state, subview: undefined }));
}

/** Stop a running subagent of the open chat `handle`. */
export async function stopSubagent(handle: string, agent: Subagent): Promise<void> {
  if (!isActive(agent.status)) return;
  const response = await command(handle, { type: "prompt", message: subagentCommand(store.get().commands[handle], "stop", agent.id) });
  if (!response.success) toast(`Could not stop the subagent: ${response.error ?? "unknown error"}`, "error");
}

/** Send a running subagent a message it reads after its current tool call (pi-subagents' steer). */
export async function steerSubagent(handle: string, agent: Subagent, message: string): Promise<boolean> {
  const text = message.trim();
  if (!text || !isActive(agent.status)) return false;
  const response = await command(handle, { type: "prompt", message: subagentCommand(store.get().commands[handle], "steer", agent.id, text) });
  if (!response.success) toast(`Could not steer the subagent: ${response.error ?? "unknown error"}`, "error");
  return response.success;
}
