// How tool calls read in the transcript: a category, a verb and a target. Pure, so the
// collapsed one-liners and the activity summaries stay consistent and testable.

export type ToolCategory = "read" | "edit" | "bash" | "search" | "web" | "browser" | "agent" | "think" | "other";

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

export function presentTool(name: string, args: Args, cwd: string, details?: unknown, home?: string): ToolPresentation {
  const rel = (path: unknown) => relativePath(str(path), cwd, home);
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
    case "browser_console":
      return { category: "browser", verb: "Read the console", activeVerb: "Reading the console", target: "" };
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
  let failed = 0;
  for (const { presentation, failed: isFailed } of tools) {
    if (isFailed) failed++;
    if (presentation.category === "read") for (const f of presentation.files ?? []) readFiles.add(f);
    else if (presentation.category === "edit") for (const f of presentation.files ?? []) editedFiles.add(f);
    else counts[presentation.category] = (counts[presentation.category] ?? 0) + 1;
  }
  const parts: string[] = [];
  if (readFiles.size) parts.push(`Read ${plural(readFiles.size, "file", "files")}`);
  if (counts.search) parts.push(`searched ${plural(counts.search, "time", "times")}`);
  if (counts.bash) parts.push(`ran ${plural(counts.bash, "command", "commands")}`);
  if (editedFiles.size) parts.push(`edited ${plural(editedFiles.size, "file", "files")}`);
  if (counts.web) parts.push(`${plural(counts.web, "web lookup", "web lookups")}`);
  if (counts.browser) parts.push(`${plural(counts.browser, "browser action", "browser actions")}`);
  if (counts.agent) parts.push(`${plural(counts.agent, "delegation", "delegations")}`);
  if (counts.other) parts.push(`${plural(counts.other, "tool call", "tool calls")}`);
  if (failed) parts.push(`${failed} failed`);
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
