// What the running inline visuals share: one message listener, one watchdog and one theme listener for all their frames,
// installed while at least one frame runs.
import { THEME_EVENT } from "./theme";

/** A frame that sent nothing, not even its heartbeat, for this long is hung. */
export const WATCHDOG_MS = 8000;
const CHECK_MS = 1000;

export type FrameMessage = { type?: string; px?: unknown; href?: unknown; message?: unknown };

const TOKEN_NAMES = ["--theme-mode", "--app-font-size", "--canvas", "--panel", "--sunken", "--raised", "--fg", "--muted", "--faint", "--accent", "--accent-soft", "--secondary", "--highlight", "--ok", "--bad", "--warn", "--line"];
/** The first categorical colors, which a custom theme sets to its primary, secondary and accent: always sent, empty when
 * the theme leaves them, so the frame falls back to the kit's own. */
const PALETTE_NAMES = ["--c1", "--c2", "--c3"];

/** The app's theme tokens a frame draws with. */
export function readTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  for (const name of ["--font-sans", "--font-mono"]) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  for (const name of PALETTE_NAMES) tokens[name] = style.getPropertyValue(name).trim();
  return tokens;
}

export interface FrameHandlers {
  /** A message from the frame (an object); any message counts as a sign of life. */
  onMessage(data: FrameMessage): void;
  /** Nothing came for WATCHDOG_MS; called once. */
  onHung(): void;
  post(message: unknown): void;
}

interface Link extends FrameHandlers {
  beat: number;
  hung: boolean;
}

const links = new Map<MessageEventSource, Link>();
let watchdog: ReturnType<typeof setInterval> | undefined;
let media: MediaQueryList | undefined;

function onMessage(event: MessageEvent): void {
  const link = event.source ? links.get(event.source) : undefined;
  const data = event.data as FrameMessage | null;
  if (!link || !data || typeof data !== "object") return;
  link.beat = Date.now();
  link.onMessage(data);
}

function onTheme(): void {
  const tokens = readTokens();
  for (const link of links.values()) link.post({ type: "tokens", tokens });
}

function check(): void {
  const now = Date.now();
  for (const link of links.values()) {
    if (link.hung || now - link.beat <= WATCHDOG_MS) continue;
    link.hung = true;
    link.onHung();
  }
}

/** Routes the messages of the frame whose window is `view` to `handlers` and watches its heartbeat, until unlinked. */
export function linkFrame(view: MessageEventSource, handlers: FrameHandlers): { beat(): void; unlink(): void } {
  if (!links.size) {
    window.addEventListener("message", onMessage);
    window.addEventListener(THEME_EVENT, onTheme);
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", onTheme);
    watchdog = setInterval(check, CHECK_MS);
  }
  const link: Link = { ...handlers, beat: Date.now(), hung: false };
  links.set(view, link);
  return {
    beat: () => {
      link.beat = Date.now();
    },
    unlink: () => {
      if (links.get(view) !== link) return;
      links.delete(view);
      if (links.size) return;
      window.removeEventListener("message", onMessage);
      window.removeEventListener(THEME_EVENT, onTheme);
      media?.removeEventListener("change", onTheme);
      media = undefined;
      clearInterval(watchdog);
      watchdog = undefined;
    },
  };
}
