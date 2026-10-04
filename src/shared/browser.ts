// Integrated browser: shared between the main process (tabs, agent bridge) and the renderer (pane UI).

import type { ViewportSpec } from "./viewport";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Session handle of the agent that opened or last drove this tab. */
  agent?: string;
  /** Emulated viewport; absent means Responsive (the view fills the pane). */
  viewport?: ViewportSpec;
  /** Where the tab is shown: the browser pane (default) or a standalone window. */
  surface?: "pane" | "window";
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeId?: string;
  annotating: boolean;
}

/** Where the renderer wants the active tab drawn, in CSS pixels of the app window. */
export interface BrowserLayout {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface HistoryEntry {
  url: string;
  title: string;
  at: number;
}

/** A comment the user pinned on a page element; attached to the next prompt. */
export interface Annotation {
  id: string;
  url: string;
  title: string;
  selector: string;
  /** Short role/name description such as `button "Sign in"`. */
  label: string;
  html: string;
  comment: string;
  /** JPEG crop of the element, base64. */
  image?: string;
}

export type BrowserCommand = "back" | "forward" | "reload" | "stop";

/** Agent tool calls from the pi extension, routed through the localhost bridge. */
export type AgentAction =
  | { action: "open"; url: string; newTab?: boolean }
  | { action: "snapshot" }
  | { action: "click"; ref: number }
  | { action: "type"; ref: number; text: string; submit?: boolean; clear?: boolean }
  | { action: "press"; key: string }
  | { action: "screenshot" }
  | { action: "evaluate"; expression: string }
  | { action: "console"; clear?: boolean }
  | { action: "back" }
  | { action: "state" };

export interface AgentResult {
  url: string;
  title: string;
  text?: string;
  /** base64 JPEG for screenshots */
  image?: string;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?(\/.*)?$/i;

/** Address-bar input -> URL: keeps URLs, adds http:// for local hosts and https:// for domains, else searches. */
export function normalizeAddress(input: string): string {
  const text = input.trim();
  if (!text) return "about:blank";
  if (LOCAL_HOST.test(text)) return `http://${text}`;
  if (/^(https?|file|about):/i.test(text)) return text;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text) || /^[^\s/]+:\d+(\/\S*)?$/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/** Origins pi may visit without asking: loopback and *.localhost dev servers, plus local files. */
export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:" || parsed.protocol === "about:") return true;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch {
    return false;
  }
}
