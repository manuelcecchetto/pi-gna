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
