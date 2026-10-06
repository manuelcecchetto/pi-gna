// The browser comments this phone made, kept until its next prompt takes them (`chat.send` with `annotations`). They
// are per page (per phone) on purpose: they ride with this phone's prompt, not the Mac's.
import { useSyncExternalStore } from "react";
import type { Annotation } from "../shared/browser";

let list: Annotation[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const annotations = {
  get: () => list,
  add(annotation: Annotation) {
    list = [...list, annotation];
    emit();
  },
  remove(id: string) {
    list = list.filter((a) => a.id !== id);
    emit();
  },
  /** After a send took these: others added meanwhile stay. */
  drop(sent: Annotation[]) {
    const ids = new Set(sent.map((a) => a.id));
    list = list.filter((a) => !ids.has(a.id));
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const useAnnotations = () => useSyncExternalStore(annotations.subscribe, annotations.get);

type ChatSend = (method: "chat.send", args: { handle: string; text: string; mode: "send"; annotations: Annotation[] }) => Promise<{ accepted: boolean; error?: string }>;

/**
 * Send in the comment sheet: every waiting comment goes to `handle` now, as a prompt of its own (the host steers a
 * running chat). They leave the list only once pi took them; otherwise they wait for the next message as usual.
 */
export async function sendAnnotations(call: ChatSend, handle: string): Promise<{ accepted: boolean; error?: string }> {
  const sent = annotations.get();
  if (!sent.length) return { accepted: false, error: "No comments to send" };
  const result = await call("chat.send", { handle, text: "", mode: "send", annotations: sent });
  if (result.accepted) annotations.drop(sent);
  return result;
}
