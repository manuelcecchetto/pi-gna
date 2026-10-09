// How tool calls read in the transcript: a category, a verb and a target. Pure, so the
// collapsed one-liners and the activity summaries stay consistent and testable.
import { parseLocalTarget } from "../../../shared/preview";
import type { ToolCall } from "../../../shared/protocol";

export type ToolCategory = "read" | "edit" | "bash" | "search" | "web" | "browser" | "computer" | "board" | "agent" | "think" | "other";

export interface ToolPresentation {
  category: ToolCategory;
  /** Past tense ("Read"), used once the call finished. */
  verb: string;
  /** Present tense ("Reading"), used while running. */
  activeVerb: string;
  target: string;
  /** Short trailing meta such as a line range or +/- counts. */
  meta?: string;
  /** Files this call touched, for summaries. */
  files?: string[];
  /** The native app a computer_* call drove. */
  app?: string;
}

type Args = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export function relativePath(path: string, cwd: string, home?: string): string {
  if (!path) return path;
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function statMeta(details: unknown): string | undefined {
  const diff = details && typeof details === "object" ? str((details as Args).diff) : "";
  if (!diff) return undefined;
  const { added, removed } = diffStats(diff);
  return `+${added} −${removed}`;
}

export function patchFiles(input: string): string[] {
  const files: string[] = [];
  for (const match of input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) if (match[1]) files.push(match[1].trim());
  return files;
}

const COMPUTER_VERBS: Record<string, [string, string]> = {
  click: ["Clicked", "Clicking"],
  drag: ["Dragged", "Dragging"],
  scroll: ["Scrolled", "Scrolling"],
  press_key: ["Pressed", "Pressing"],
  set_value: ["Set a value", "Setting a value"],
  select_text: ["Selected text", "Selecting text"],
  secondary_action: ["Ran an action", "Running an action"],
  paste: ["Pasted", "Pasting"],
};

/** computer_* tools: "Clicked [42] in TextEdit", "Typed 12 characters in Notes", "Read TextEdit state". */
function presentComputer(action: string, args: Args): ToolPresentation {
  const app = str(args.app);
  const base = { category: "computer" as const, app: app || undefined };
  const inApp = app ? `in ${app}` : undefined;
  const index = num(args.element_index);
  const where = index !== undefined ? `[${index}]` : num(args.x) !== undefined ? `(${args.x}, ${args.y})` : "";
  switch (action) {
    case "list_apps":
      return { ...base, verb: "Listed apps", activeVerb: "Listing apps", target: "" };
    case "get_app_state":
      return { ...base, verb: app ? `Read ${app} state` : "Read app state", activeVerb: app ? `Reading ${app} state` : "Reading app state", target: "" };
    case "type_text": {
      const count = [...str(args.text)].length;
      return { ...base, verb: "Typed", activeVerb: "Typing", target: `${plural(count, "character", "characters")}`, meta: inApp };
    }
    case "drag":
      return { ...base, verb: "Dragged", activeVerb: "Dragging", target: `(${String(args.from_x)}, ${String(args.from_y)}) → (${String(args.to_x)}, ${String(args.to_y)})`, meta: inApp };
    case "press_key":
      return { ...base, verb: "Pressed", activeVerb: "Pressing", target: str(args.key), meta: inApp };
    case "scroll":
      return { ...base, verb: "Scrolled", activeVerb: "Scrolling", target: [str(args.direction), where].filter(Boolean).join(" "), meta: inApp };
    case "secondary_action":
      return { ...base, verb: "Ran an action", activeVerb: "Running an action", target: [str(args.secondary_action), where].filter(Boolean).join(" "), meta: inApp };
    default: {
      const [verb, activeVerb] = COMPUTER_VERBS[action] ?? [action, action];
      return { ...base, verb, activeVerb, target: where, meta: inApp };
    }
  }
}

export function presentTool(name: string, args: Args, cwd: string, details?: unknown, home?: string): ToolPresentation {
  const rel = (path: unknown) => relativePath(str(path), cwd, home);
  if (name.startsWith("computer_")) return presentComputer(name.slice("computer_".length), args);
  switch (name) {
    case "read": {
      const offset = num(args.offset);
      const limit = num(args.limit);
      const meta = offset || limit ? `L${offset ?? 1}${limit ? `–${(offset ?? 1) + limit - 1}` : "+"}` : undefined;
      return { category: "read", verb: "Read", activeVerb: "Reading", target: rel(args.path), meta, files: [str(args.path)] };
    }
    case "edit":
      return { category: "edit", verb: "Edited", activeVerb: "Editing", target: rel(args.path), meta: statMeta(details), files: [str(args.path)] };
    case "write": {
      const lines = str(args.content).split("\n").length;
      return { category: "edit", verb: "Wrote", activeVerb: "Writing", target: rel(args.path), meta: args.content ? `${lines} lines` : undefined, files: [str(args.path)] };
    }
    case "apply_patch": {
      const files = patchFiles(str(args.input));
      const target = files.length ? `${rel(files[0])}${files.length > 1 ? ` +${files.length - 1} more` : ""}` : "patch";
      return { category: "edit", verb: "Patched", activeVerb: "Patching", target, meta: statMeta(details), files };
    }
    case "bash":
      return { category: "bash", verb: "Ran", activeVerb: "Running", target: firstLine(str(args.command)) };
    case "grep":
      return { category: "search", verb: "Searched", activeVerb: "Searching", target: str(args.pattern), meta: args.path ? `in ${rel(args.path)}` : undefined };
    case "find":
      return { category: "search", verb: "Found files", activeVerb: "Finding files", target: str(args.pattern), meta: args.path ? `in ${rel(args.path)}` : undefined };
    case "ls":
      return { category: "search", verb: "Listed", activeVerb: "Listing", target: rel(args.path) || "." };
    case "web_search": {
      const queries = Array.isArray(args.queries) ? (args.queries as unknown[]).map(str) : [str(args.query)];
      return { category: "web", verb: "Searched the web", activeVerb: "Searching the web", target: queries[0] ?? "", meta: queries.length > 1 ? `+${queries.length - 1} queries` : undefined };
    }
    case "fetch_content": {
      const urls = Array.isArray(args.urls) ? (args.urls as unknown[]).map(str) : [str(args.url)];
      return { category: "web", verb: "Fetched", activeVerb: "Fetching", target: urls[0] ?? "", meta: urls.length > 1 ? `+${urls.length - 1} more` : undefined };
    }
    case "browser_open":
      if (parseLocalTarget(str(args.url), cwd)) return { category: "browser", verb: "Previewed", activeVerb: "Previewing", target: rel(str(args.url)) };
      return { category: "browser", verb: "Opened", activeVerb: "Opening", target: str(args.url) };
    case "browser_snapshot":
      return { category: "browser", verb: "Read the page", activeVerb: "Reading the page", target: "" };
    case "browser_click":
      return { category: "browser", verb: "Clicked", activeVerb: "Clicking", target: `[${String(args.ref ?? "")}]` };
    case "browser_type":
      return { category: "browser", verb: "Typed", activeVerb: "Typing", target: firstLine(str(args.text), 60), meta: `into [${String(args.ref ?? "")}]` };
    case "browser_press":
      return { category: "browser", verb: "Pressed", activeVerb: "Pressing", target: str(args.key) };
    case "browser_screenshot":
      return { category: "browser", verb: "Took a screenshot", activeVerb: "Taking a screenshot", target: "" };
    case "browser_evaluate":
      return { category: "browser", verb: "Evaluated", activeVerb: "Evaluating", target: firstLine(str(args.expression), 80) };
    case "browser_viewport": {
      if (args.reset) return { category: "browser", verb: "Reset viewport", activeVerb: "Resetting viewport", target: "" };
      const size = args.width || args.height ? `${String(args.width ?? "auto")}x${String(args.height ?? "auto")}` : "";
      const target = [str(args.preset) || size || str(args.aspect), args.dpr ? `@${String(args.dpr)}x` : ""].filter(Boolean).join(" ");
      return { category: "browser", verb: "Set viewport", activeVerb: "Setting viewport", target };
    }
    case "browser_window": {
      if (args.op === "close") return { category: "browser", verb: "Closed a window", activeVerb: "Closing a window", target: "" };
      if (args.op === "list") return { category: "browser", verb: "Listed windows", activeVerb: "Listing windows", target: "" };
      const size = args.width || args.height ? `${String(args.width ?? "auto")}x${String(args.height ?? "auto")}` : "";
      const target = [str(args.preset) || size || str(args.aspect), args.dpr ? `@${String(args.dpr)}x` : ""].filter(Boolean).join(" ");
      return { category: "browser", verb: "Opened a window", activeVerb: "Opening a window", target };
    }
    case "browser_console":
      return { category: "browser", verb: "Read the console", activeVerb: "Reading the console", target: "" };
    case "threads_list":
      return { category: "agent", verb: "Listed threads", activeVerb: "Listing threads", target: str(args.query) || (args.all ? "every project" : "") };
    case "thread_read":
      return { category: "agent", verb: "Read thread", activeVerb: "Reading thread", target: str(args.thread) };
    case "thread_send":
      return { category: "agent", verb: "Messaged thread", activeVerb: "Messaging thread", target: `${str(args.thread)}: ${firstLine(str(args.message), 80)}` };
    case "kanban_list":
      return { category: "board", verb: "Read the board", activeVerb: "Reading the board", target: str(args.card) || str(args.column) };
    case "kanban_claim":
      return { category: "board", verb: "Took the card", activeVerb: "Taking the card", target: str(args.card) || firstLine(str(args.title), 80) };
    case "kanban_update":
      return {
        category: "board",
        verb: args.column ? "Moved its card" : "Reported on its card",
        activeVerb: args.column ? "Moving its card" : "Reporting on its card",
        target: args.column ? `to ${str(args.column)}` : firstLine(str(args.report), 80),
      };
    case "run":
    case "snapshot":
    case "screenshot":
      return { category: "browser", verb: name === "run" ? "Drove the browser" : `Took a ${name}`, activeVerb: name === "run" ? "Driving the browser" : `Taking a ${name}`, target: "" };
    case "subagent":
    case "workflow": {
      const target = str(args.agent) ? `${str(args.agent)}: ${firstLine(str(args.task), 80)}` : firstLine(str(args.task) || str(args.script), 80);
      return { category: "agent", verb: name === "workflow" ? "Ran a workflow" : "Delegated", activeVerb: name === "workflow" ? "Running a workflow" : "Delegating", target };
    }
    default: {
      const firstString = Object.values(args).find((value) => typeof value === "string") as string | undefined;
      return { category: "other", verb: name, activeVerb: name, target: firstString ? firstLine(firstString, 80) : "" };
    }
  }
}

const presented = new WeakMap<ToolCall, { cwd: string; home?: string; details: unknown; presentation: ToolPresentation }>();

/**
 * presentTool once per call object (the reducer replaces a call when its arguments change): a long
 * loop's rows and summary are not presented again on every frame of the live run.
 */
export function presentCall(call: ToolCall, cwd: string, details?: unknown, home?: string): ToolPresentation {
  const cached = presented.get(call);
  if (cached && cached.cwd === cwd && cached.home === home && cached.details === details) return cached.presentation;
  const presentation = presentTool(call.name, call.arguments, cwd, details, home);
  presented.set(call, { cwd, home, details, presentation });
  return presentation;
}

/**
 * The timeout a call asked for, in ms, read from its arguments: pi exposes no per-tool default
 * (bash runs unbounded unless the model passes `timeout`). 0 means "no cap", so it is undefined.
 */
export function toolTimeoutMs(name: string, args: Args): number | undefined {
  const seconds = num(name === "bash" ? args.timeout : undefined) ?? num(args.timeoutSeconds) ?? num(args.timeout_seconds);
  const ms = seconds !== undefined ? seconds * 1000 : (num(args.timeoutMs) ?? num(args.timeout_ms));
  return ms && ms > 0 ? ms : undefined;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export interface SummaryInput {
  presentation: ToolPresentation;
  failed: boolean;
}

/** "Read 3 files · Ran 2 commands · Edited 1 file", or undefined when there were no tools. */
export function summarizeTools(tools: SummaryInput[]): string | undefined {
  if (!tools.length) return undefined;
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  const counts: Record<string, number> = {};
  const apps = new Set<string>();
  let failed = 0;
  for (const { presentation, failed: isFailed } of tools) {
    if (isFailed) failed++;
    if (presentation.category === "read") for (const f of presentation.files ?? []) readFiles.add(f);
    else if (presentation.category === "edit") for (const f of presentation.files ?? []) editedFiles.add(f);
    else {
      if (presentation.app) apps.add(presentation.app);
      counts[presentation.category] = (counts[presentation.category] ?? 0) + 1;
    }
  }
  const parts: string[] = [];
  if (readFiles.size) parts.push(`Read ${plural(readFiles.size, "file", "files")}`);
  if (counts.search) parts.push(`searched ${plural(counts.search, "time", "times")}`);
  if (counts.bash) parts.push(`ran ${plural(counts.bash, "command", "commands")}`);
  if (editedFiles.size) parts.push(`edited ${plural(editedFiles.size, "file", "files")}`);
  if (counts.web) parts.push(`${plural(counts.web, "web lookup", "web lookups")}`);
  if (counts.browser) parts.push(`${plural(counts.browser, "browser action", "browser actions")}`);
  if (counts.computer) parts.push(`${apps.size ? `used ${[...apps].join(", ")} · ` : ""}${plural(counts.computer, "action", "actions")}`);
  if (counts.board) parts.push(`${plural(counts.board, "board action", "board actions")}`);
  if (counts.agent) parts.push(`${plural(counts.agent, "delegation", "delegations")}`);
  if (counts.other) parts.push(`${plural(counts.other, "tool call", "tool calls")}`);
  if (failed) parts.push(`${failed} failed`);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The app a still-running computer_* call is driving, for the "Using <App>" hint. */
export function liveComputerApp(tools: { name: string; arguments: Record<string, unknown>; running: boolean }[]): string | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool?.running && tool.name.startsWith("computer_")) return str(tool.arguments.app) || "an app";
  }
  return undefined;
}
