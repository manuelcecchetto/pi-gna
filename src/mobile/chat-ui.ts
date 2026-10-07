// The phone's side of the shared transcript components (renderer/src/lib/chat-ui.tsx): expansion state, the board
// cards a message can name, and the actions that go to the host. Chat links open what the Mac would: a text file or
// image on the File screen, drawn on the phone; another file in a preview tab the chat owns, streamed on the Browser
// screen; a card on the board; a localhost page in the Mac's browser (the phone cannot reach the Mac's localhost); any
// other web page in Safari.
import { createStore, useStore } from "../renderer/src/lib/store";
import type { ChatLinks, ChatUi, ChatUiState } from "../renderer/src/lib/chat-ui";
import { lightboxAt, lightboxStep, type LightboxView } from "../renderer/src/lib/lightbox";
import { drawnOnPhone } from "./file-data";
import { emptyBoard } from "../shared/board";
import { type BrowserTab, isLocalUrl } from "../shared/browser";
import type { Route } from "./nav";
import type { QueueOp } from "../shared/queue";
import type { HostClient } from "./client/host-client";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const lightbox = createStore<LightboxView | undefined>(undefined);
export const useLightbox = (): LightboxView | undefined => useStore(lightbox, (view) => view);
export const toggleExpandAll = (ui: ChatUi): void => ui.store.set((state) => ({ ...state, expandAll: !state.expandAll, expanded: {} }));
export const closeLightbox = (): void => lightbox.set(() => undefined);
/** The lightbox `delta` images on (a swipe); stops at the ends. */
export const stepLightbox = (delta: number): void => lightbox.set((view) => view && lightboxStep(view, delta));

/** The chat on screen, whose folders its links open from; ChatScreen sets it before the transcript's effects run. */
let showing: { handle: string; cwd: string } | undefined;
export const showChat = (chat: { handle: string; cwd: string } | undefined): void => {
  showing = chat;
};

/**
 * The tab once its first page has loaded (the host's browser state says so), or undefined after 10 s or once it is
 * gone. Sizing a tab before that would replace the page with about:blank (BrowserManager.emulate guards a crash).
 */
function loaded(client: HostClient, id: string): Promise<BrowserTab | undefined> {
  const find = () => client.store.get().global.browser?.tabs.find((t) => t.id === id);
  const ready = (tab: BrowserTab | undefined) => !!tab && !tab.loading && !!tab.url && tab.url !== "about:blank";
  if (ready(find())) return Promise.resolve(find());
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      stop();
      const tab = find();
      resolve(ready(tab) ? tab : undefined);
    };
    const timer = setTimeout(finish, 10_000);
    const stop = client.store.subscribe(() => ready(find()) && finish());
  });
}

/**
 * Show a tab a link opened on the Browser screen. A tab without a viewport is laid out at this phone's size: the Mac's
 * Responsive layout is 1280 px wide, a strip of tiny text on a phone.
 */
async function showTab(client: HostClient, push: (route: Route) => void, handle: string, id: string): Promise<void> {
  push({ screen: "browser", handle, tab: id });
  const tab = await loaded(client, id);
  if (!tab || tab.viewport) return;
  // Size and density only: a new User-Agent would reload the page.
  const request = { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight), dpr: Math.min(3, Math.round(window.devicePixelRatio)), source: "user" as const };
  await client.call("browser.viewport", { id, request }).catch(() => undefined);
}

const failed = (what: string, error: unknown) => toast(`${what}: ${error instanceof Error ? error.message : String(error)}`, "error");

/** The file in the Mac's preview tab, streamed on the Browser screen: for what the phone cannot draw. */
export function streamFile(client: HostClient, push: (route: Route) => void, handle: string, path: string, line?: number): void {
  client.call("chat.openFile", { handle, path, line }).then(
    ({ id }) => showTab(client, push, handle, id),
    (error) => failed("Could not open the file", error),
  );
}

/** A file of a chat's folders: drawn on the File screen when the phone can, else streamed (the stream lags on a phone). */
function openChatFile(client: HostClient, push: (route: Route) => void, handle: string, path: string, line?: number): void {
  if (drawnOnPhone(path)) push({ screen: "file", handle, path, line });
  else streamFile(client, push, handle, path, line);
}

function chatLinks(client: HostClient, push: (route: Route) => void): ChatLinks {
  return {
    cwd: () => showing?.cwd,
    resolve: (targets) => (showing ? client.call("chat.resolveLinks", { handle: showing.handle, targets }) : Promise.resolve(targets.map(() => null))),
    image: (target) => (showing ? client.call("chat.linkImage", { handle: showing.handle, target }) : Promise.resolve(null)),
    openFile(path, { line }) {
      if (showing) openChatFile(client, push, showing.handle, path, line);
    },
    openCard: (card) => push({ screen: "page", page: "board", cwd: card.cwd, cardId: card.id }),
  };
}

/** The links of a Markdown file on the File screen: they resolve from the file's folder `dir`, inside the chat's folders. */
export function fileLinks(client: HostClient, push: (route: Route) => void, handle: string, dir: string): ChatLinks {
  return {
    cwd: () => dir,
    resolve: (targets) => client.call("chat.resolveLinks", { handle, targets, from: dir }),
    image: (target) => client.call("chat.linkImage", { handle, target, from: dir }),
    openFile: (path, { line }) => openChatFile(client, push, handle, path, line),
    openCard: (card) => push({ screen: "page", page: "board", cwd: card.cwd, cardId: card.id }),
  };
}

export function createChatUi(client: HostClient, homeDir: string, push: (route: Route) => void): ChatUi {
  const store = createStore<ChatUiState>({
    expandAll: false,
    expanded: {},
    board: { ...emptyBoard(), rev: 0 },
    // Visuals and the wallpaper follow the Mac's settings (syncBoard below).
    settings: { visuals: false, wallpaper: "none", wallpaperLoop: false },
  });
  const syncBoard = () => {
    const { board, settings } = client.store.get().global;
    store.set((state) => {
      const { visuals, wallpaper, wallpaperLoop } = { ...state.settings, ...settings };
      const same = state.settings.visuals === visuals && state.settings.wallpaper === wallpaper && state.settings.wallpaperLoop === wallpaperLoop;
      if (state.board === (board ?? state.board) && same) return state;
      return { ...state, board: board ?? state.board, settings: { visuals, wallpaper, wallpaperLoop } };
    });
  };
  client.store.subscribe(syncBoard);
  syncBoard();

  return {
    store,
    actions: {
      homeDir,
      Sheet,
      // Frames come from the host's /visual path (sandboxed, opaque origin, the desktop's frame CSP).
      visualFrames: { src: (frameId) => `/visual/${frameId}/doc`, tapToRender: true },
      setExpanded: (key, open) => store.set((state) => ({ ...state, expanded: { ...state.expanded, [key]: open } })),
      openLightbox: (src, images) => lightbox.set(() => (src ? lightboxAt(src, images) : undefined)),
      openExternal(url) {
        const chat = showing;
        if (!chat || !/^https?:/i.test(url) || !isLocalUrl(url)) return void window.open(url, "_blank", "noopener,noreferrer");
        client.call("browser.newTab", { url, agent: chat.handle }).then(
          (tab) => (tab ? showTab(client, push, chat.handle, tab.id) : push({ screen: "browser", handle: chat.handle })),
          (error) => failed("Could not open the page", error),
        );
      },
      links: chatLinks(client, push),
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
