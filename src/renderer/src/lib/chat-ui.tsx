// What the transcript, activity, markdown and dialog components need from the app around them. The desktop window
// provides it from its store and `window.studio`; the mobile app provides it from its HostClient (src/mobile), so
// those components stay shared and never import a client's state module.
import { type ComponentType, createContext, type ReactNode, useContext } from "react";
import type { QueueOp } from "../../../shared/queue";
import type { ExtensionUiResponse } from "../../../shared/protocol";
import type { AppState } from "../state/app";
import { type Store, useStore } from "./store";

/** The slice of state the shared components read; the desktop's `AppState` has it as is. */
export type ChatUiState = Pick<AppState, "expandAll" | "expanded" | "board" | "look"> & {
  settings: Pick<AppState["settings"], "visuals" | "wallpaper" | "wallpaperLoop">;
};

/** Where a client's visual frames load from; the desktop has none (its `pigna-visual://` scheme and process kill are built in). */
export interface VisualFrames {
  /** Document URL of one frame (its kit files sit beside it). */
  src(frameId: string): string;
  /** A frame draws only after a tap: a phone does not run every visual in a long transcript at once. */
  tapToRender: boolean;
}

export interface ChatUiActions {
  homeDir: string;
  /** Bottom sheet of the phone; where present, a tool call opens its details in one instead of inline. */
  Sheet?: ComponentType<{ title: string; onClose: () => void; children: ReactNode }>;
  visualFrames?: VisualFrames;
  setExpanded(key: string, open: boolean): void;
  openLightbox(src: string | undefined): void;
  /** Open a card on the board; absent where there is no board view. */
  showBoard?(cwd: string, card: string): void;
  openExternal(url: string): void;
  respondDialog(handle: string, response: ExtensionUiResponse): Promise<void>;
  /** False when the queue no longer holds the text (the run moved on). */
  editQueue(handle: string, op: QueueOp): Promise<boolean>;
}

export interface ChatUi {
  store: Store<ChatUiState>;
  actions: ChatUiActions;
}

const Context = createContext<ChatUi | null>(null);

export function ChatUiProvider({ ui, children }: { ui: ChatUi; children: ReactNode }) {
  return <Context.Provider value={ui}>{children}</Context.Provider>;
}

export function useChatUiHandle(): ChatUi {
  const ui = useContext(Context);
  if (!ui) throw new Error("ChatUiProvider is missing");
  return ui;
}

export function useChatUi<S>(selector: (state: ChatUiState) => S): S {
  return useStore(useChatUiHandle().store, selector);
}

export function useChatActions(): ChatUiActions {
  return useChatUiHandle().actions;
}
