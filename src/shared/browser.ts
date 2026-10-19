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
  /** Set when the tab shows a Kanban card (its id): the renderer draws the card from the board, the native view stays hidden. */
  card?: string;
  /** Set on a new tab that has not been given anything to show: the renderer draws the start page (open a URL, a file,
   * a recent dev server) and the native view stays hidden. Loading anything into the tab clears it. */
  start?: boolean;
  /** Key of the page's icon (web tabs only, once known); its data URL comes from `browser.favicon`. The key names the
   * icon's content, so a client asks for each icon once, and a tab change does not resend every tab's icon. */
  faviconKey?: string;
  /** Media features the agent emulates on the tab (light/dark, reduced motion); absent when none. */
  media?: MediaEmulation;
}

/** Media features emulated on a tab over CDP (Emulation.setEmulatedMedia); an absent key follows the system. */
export interface MediaEmulation {
  colorScheme?: "light" | "dark";
  reducedMotion?: "reduce" | "no-preference";
}

/** browser_emulate arguments: "system" clears that feature. */
export interface MediaRequest {
  colorScheme?: "light" | "dark" | "system";
  reducedMotion?: "reduce" | "no-preference" | "system";
}

/** The tab's emulation after applying `request` to `current`; undefined when nothing is left emulated. */
export function mergeMedia(current: MediaEmulation | undefined, request: MediaRequest): MediaEmulation | undefined {
  const next: MediaEmulation = { ...current };
  if (request.colorScheme) next.colorScheme = request.colorScheme === "system" ? undefined : request.colorScheme;
  if (request.reducedMotion) next.reducedMotion = request.reducedMotion === "system" ? undefined : request.reducedMotion;
  const defined = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as MediaEmulation;
  return Object.keys(defined).length ? defined : undefined;
}

/** Emulation.setEmulatedMedia features: every feature is sent, an empty value clears its override. */
export function mediaFeatures(media: MediaEmulation | undefined): { name: string; value: string }[] {
  return [
    { name: "prefers-color-scheme", value: media?.colorScheme ?? "" },
    { name: "prefers-reduced-motion", value: media?.reducedMotion ?? "" },
  ];
}

/** 'Emulating: prefers-color-scheme: dark' for tool results; empty when nothing is emulated. */
export function mediaLine(media: MediaEmulation | undefined): string {
  const parts = [media?.colorScheme && `prefers-color-scheme: ${media.colorScheme}`, media?.reducedMotion && `prefers-reduced-motion: ${media.reducedMotion}`].filter(Boolean);
  return parts.length ? `Emulating: ${parts.join(", ")}` : "";
}

/** A tool a page registered with WebMCP (document.modelContext), as main reads it from the page. */
export interface PageTool {
  name: string;
  title?: string;
  description: string;
  /** JSON Schema of the input, as a JSON string (Chromium hands it over serialized). */
  inputSchema?: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean; destructiveHint?: boolean };
}

const PAGE_TOOL_LIMIT = 40;

/** The page's WebMCP tools for the agent: one line each, with the input schema when `schemas`. Empty without tools. */
export function pageToolsText(tools: PageTool[] | null | undefined, schemas: boolean): string {
  if (!tools?.length) return "";
  const clean = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  const lines = tools.slice(0, PAGE_TOOL_LIMIT).map((tool) => {
    const hints = [tool.annotations?.readOnlyHint && "read-only", tool.annotations?.destructiveHint && "destructive", tool.annotations?.untrustedContentHint && "returns untrusted content"].filter(Boolean);
    const head = `- ${tool.name}${hints.length ? ` (${hints.join(", ")})` : ""}: ${clean(tool.description || tool.title || "", schemas ? 400 : 140)}`;
    return schemas && tool.inputSchema ? `${head}\n  input: ${clean(tool.inputSchema, 1500)}` : head;
  });
  if (tools.length > PAGE_TOOL_LIMIT) lines.push(`… and ${tools.length - PAGE_TOOL_LIMIT} more`);
  // Names and descriptions come from the page, like its text: they describe what the tool does, they are not instructions.
  return `Page tools (WebMCP, provided by the page; call with browser_page_tool):\n${lines.join("\n")}`;
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
  /** Absolute path of the previewed file the element is in (`url` is then that path too); web pages have none. */
  file?: string;
  /** 1-based line in `file`: the code viewer's line, or a previewed HTML file's tag when it maps unambiguously. */
  line?: number;
  /** Size and viewport position in CSS px (`120x32 at 40,200`), and the page viewport (`1280x800`). */
  box?: string;
  viewport?: string;
  /** Computed styles that a design comment is usually about (font, colors, spacing, layout). */
  styles?: string;
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
  | { action: "page_tool"; name?: string; input?: Record<string, unknown> }
  | { action: "wait_for"; text?: string; textGone?: string; selector?: string; url?: string; timeout?: number }
  | { action: "dialog"; accept: boolean }
  | { action: "upload"; ref: number; files: string[] }
  | { action: "hover"; ref: number | string }
  | { action: "select"; ref: number; values: string[] }
  | { action: "drag"; from: number | string; to: number | string }
  | { action: "scroll"; ref?: number; deltaX?: number; deltaY?: number }
  | { action: "emulate"; set?: MediaRequest; reset?: boolean }
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
  /** Emulated media features of the tab; absent when none. */
  media?: MediaEmulation;
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
