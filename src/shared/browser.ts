// Integrated browser: shared between the main process (tabs, agent bridge) and the renderer (pane UI).

import type { TabPreview } from "./preview";
import type { ViewportRequest, ViewportSpec } from "./viewport";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Session handle of the chat that owns this tab: the one that opened it (the agent, or the user in that chat). Each chat shows only its own tabs. */
  agent?: string;
  /** Emulated viewport; absent means Responsive (the view fills the pane). */
  viewport?: ViewportSpec;
  /** Where the tab is shown: the browser pane (default) or a standalone window. */
  surface?: "pane" | "window";
  /** When the agent last drove this tab (ms since epoch); clients show "agent is using this" while it is recent. */
  agentAt?: number;
  /** Set when the tab previews a local file; `url` is then a pigna-file:// address and clients show `preview.path`. */
  preview?: TabPreview;
}

/** How long after its last action a tab still counts as driven by the agent. */
export const AGENT_ACTIVE_MS = 8000;

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
  /** The chat whose tab it was picked in; the comment waits in that chat's composer. */
  chat?: string;
}

export type BrowserCommand = "back" | "forward" | "reload" | "stop";

/** Agent tool calls from the pi extension, routed through the localhost bridge. */
export type AgentAction = (
  | { action: "open"; url: string; newTab?: boolean; cwd?: string }
  | { action: "snapshot" }
  | { action: "click"; ref: number }
  | { action: "type"; ref: number; text: string; submit?: boolean; clear?: boolean }
  | { action: "press"; key: string }
  | { action: "screenshot" }
  | { action: "evaluate"; expression: string }
  | { action: "console"; clear?: boolean }
  | { action: "back" }
  | { action: "state" }
  | { action: "viewport"; set?: ViewportRequest; reset?: boolean }
  | { action: "window"; op: "open" | "close" | "list"; url?: string; set?: ViewportRequest }
) & {
  /** Tab id to act on (from browser_window); default is the session's current tab. */
  tab?: string;
};

export interface AgentResult {
  url: string;
  title: string;
  text?: string;
  /** base64 JPEG for screenshots */
  image?: string;
  /** Id of the tab the result is about; pass it as `tab` to address a window. */
  tab?: string;
  /** Emulated viewport of the tab; absent when none is active. */
  viewport?: ViewportSpec;
}

/** 'Viewport: 393x852 @3x, mobile, iPhone 15 (set by you)'. */
export function viewportLine(spec: ViewportSpec): string {
  const parts = [`${spec.width}x${spec.height} @${spec.dpr}x`];
  if (spec.mobile) parts.push("mobile");
  parts.push(spec.label);
  return `Viewport: ${parts.join(", ")} (set by ${spec.source === "agent" ? "you" : "the user"})`;
}

/** browser_viewport tool arguments -> bridge action; reset wins over set. */
export function viewportAction(params: { reset?: boolean } & ViewportRequest): AgentAction {
  if (params.reset) return { action: "viewport", reset: true };
  const { reset: _reset, source: _source, ...set } = params;
  const defined = Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined));
  return Object.keys(defined).length ? { action: "viewport", set: defined } : { action: "viewport" };
}

/** Size to scale a screenshot to so its long edge fits `max`; undefined when it already fits. */
export function screenshotSize(width: number, height: number, max: number): { width: number; height: number } | undefined {
  const long = Math.max(width, height);
  if (long <= max) return undefined;
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
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
