// Pinned and hidden projects and bookmarked turns, kept by the host so every client sees the same (src/shared/ui-state.ts).
// This is the window's copy: changes apply here first, then main checks, saves and pushes them back.
import type { Revved, UiState } from "../../../shared/host-api";
import { applyUiOp, emptyUiState, type UiOp } from "../../../shared/ui-state";
import { createStore } from "./store";

export const uiStore = createStore<Revved<UiState>>({ ...emptyUiState(), rev: 0 });

/** Before the host kept them, this window did (localStorage): hand them over once. */
const LEGACY_KEYS = { pins: "pigna:pinned-projects", bookmarks: "pigna:bookmarks" } as const;

function readLegacy(): { pins?: unknown; bookmarks?: unknown } | undefined {
  const found: { pins?: unknown; bookmarks?: unknown } = {};
  try {
    for (const [field, key] of Object.entries(LEGACY_KEYS)) {
      const saved = localStorage.getItem(key);
      if (saved !== null) found[field as keyof typeof LEGACY_KEYS] = JSON.parse(saved);
    }
  } catch {
    // unreadable: nothing to hand over
  }
  return found.pins === undefined && found.bookmarks === undefined ? undefined : found;
}

function forgetLegacy(): void {
  try {
    for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/** Subscribe to the host's copy, migrate the old localStorage values, and load the current ones. */
export function bootUiState(): void {
  const ui = window.studio.ui;
  const set = (next: Revved<UiState>) => uiStore.set((state) => (next.rev >= state.rev ? next : state));
  ui.onChange(set);
  const legacy = readLegacy();
  const migrated = legacy ? ui.importLegacy(legacy).then(forgetLegacy, () => undefined) : Promise.resolve();
  void migrated.then(() => ui.get()).then(set, () => undefined);
}

/** Apply a change; when main refuses it, take its copy back. */
export function applyUi(op: UiOp): void {
  const before = uiStore.get();
  try {
    const next = applyUiOp(before, op);
    if (next === before) return;
    uiStore.set(() => ({ ...next, rev: before.rev }));
  } catch {
    return;
  }
  window.studio.ui.apply(op).then(
    (confirmed) => uiStore.set((state) => (confirmed.rev >= state.rev ? confirmed : state)),
    () => void window.studio.ui.get().then((current) => uiStore.set(() => current), () => uiStore.set(() => before)),
  );
}
