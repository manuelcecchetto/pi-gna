// The phone's side of the shared transcript components (renderer/src/lib/chat-ui.tsx): expansion state, the board
// cards a message can name, and the actions that go to the host.
import { createStore, useStore } from "../renderer/src/lib/store";
import type { ChatUi, ChatUiState } from "../renderer/src/lib/chat-ui";
import { emptyBoard } from "../shared/board";
import type { QueueOp } from "../shared/queue";
import type { HostClient } from "./client/host-client";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const lightbox = createStore<string | undefined>(undefined);
export const useLightbox = (): string | undefined => useStore(lightbox, (src) => src);
export const toggleExpandAll = (ui: ChatUi): void => ui.store.set((state) => ({ ...state, expandAll: !state.expandAll, expanded: {} }));
export const closeLightbox = (): void => lightbox.set(() => undefined);

export function createChatUi(client: HostClient, homeDir: string): ChatUi {
  const store = createStore<ChatUiState>({
    expandAll: false,
    expanded: {},
    board: { ...emptyBoard(), rev: 0 },
    // No wallpaper on the phone; visuals follow the Mac's setting.
    settings: { visuals: false, wallpaper: "none", wallpaperLoop: false },
  });
  const syncBoard = () => {
    const { board, settings } = client.store.get().global;
    store.set((state) => {
      const visuals = settings?.visuals ?? state.settings.visuals;
      if (state.board === (board ?? state.board) && state.settings.visuals === visuals) return state;
      return { ...state, board: board ?? state.board, settings: { ...state.settings, visuals } };
    });
  };
  client.store.subscribe(syncBoard);
  syncBoard();

  const failed = (what: string, error: unknown) => toast(`${what}: ${error instanceof Error ? error.message : String(error)}`, "error");
  return {
    store,
    actions: {
      homeDir,
      Sheet,
      // Frames come from the host's /visual path (sandboxed, opaque origin, the desktop's frame CSP).
      visualFrames: { src: (frameId) => `/visual/${frameId}/doc`, tapToRender: true },
      setExpanded: (key, open) => store.set((state) => ({ ...state, expanded: { ...state.expanded, [key]: open } })),
      openLightbox: (src) => lightbox.set(() => src),
      openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
      async respondDialog(handle, response) {
        try {
          const answer = await client.call("chat.respondDialog", { handle, response });
          // The card goes by the host's dialog_resolved event, whoever answered.
          if (answer.ok) return;
          if (answer.code === "already_answered") toast("Already answered on another device");
          else if (answer.code !== "not_found") toast(`Could not answer: ${answer.message}`, "error");
        } catch (error) {
          failed("Could not answer", error);
        }
      },
      async editQueue(handle, op: QueueOp) {
        try {
          return await client.call("chat.editQueue", { handle, op });
        } catch (error) {
          failed("Could not change the queue", error);
          return false;
        }
      },
    },
  };
}
