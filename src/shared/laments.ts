// The Lamenting boards: what agents could not do because a tool or capability was missing, unavailable or failing,
// one board per project (laments carry their project's cwd, like cards). Agents file laments through the lament
// tool (resources/lament-extension.ts) at the point of friction; you read them to fix your tooling (yourself, or with
// a Fix chat in a git worktree), then mark them resolved. Main owns the laments and applies every change through
// applyLamentOp, from the renderer and agents alike.

/** How bad the gap was, mildest first; a lament is as bad as its worst report. */
export const SEVERITIES = ["annoying", "costly", "blocking"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY: Record<Severity, { emoji: string; label: string; about: string }> = {
  annoying: { emoji: "😒", label: "Annoying", about: "a workaround cost a few extra steps" },
  costly: { emoji: "😠", label: "Costly", about: "the workaround was slow, manual or brittle" },
  blocking: { emoji: "🤬", label: "Blocking", about: "it could not be done or verified at all" },
};

export const LAMENT_LIMITS = { title: 200, text: 8_000, reports: 30, fixes: 10, branch: 200 } as const;

/** One time an agent hit the gap: what it tried, what was missing and how it worked around it (Markdown). */
export interface LamentReport {
  at: number;
  text: string;
  severity: Severity;
  /** The chat that filed it, to open it from the lament. */
  chat?: { path: string; cwd: string };
}

/** A chat its Fix started (Laments page), which works in the lament's git worktree. */
export interface LamentFix {
  at: number;
  chat: { path: string; cwd: string };
  /** The worktree's branch; none when the project is not in git and the chat works in the project folder. */
  branch?: string;
}

export interface Lament {
  id: string;
  title: string;
  /** The project whose board the lament is on. */
  cwd: string;
  /** Oldest first: the first is the lament as filed, later ones are repeats (the first and the last ones are kept). */
  reports: LamentReport[];
  /** The chats that worked on a fix, oldest first (the latest ten). */
  fixes?: LamentFix[];
  /** When you marked it resolved; a repeat reopens it. */
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Laments {
  version: 1;
  laments: Lament[];
}

export type LamentOp =
  | { type: "file"; id?: string; title: string; text: string; severity: Severity; cwd: string; chat?: { path: string; cwd: string } }
  /** The same gap again: adds the report and reopens the lament. */
  | { type: "repeat"; id: string; text: string; severity: Severity; chat?: { path: string; cwd: string } }
  /** A Fix chat started: you mark the lament resolved once its fix is in. */
  | { type: "fix"; id: string; chat: { path: string; cwd: string }; branch?: string }
  | { type: "resolve"; id: string; resolved: boolean }
  | { type: "remove"; id: string };

/** POST /lament on the agent bridge (resources/lament-extension.ts); the calling chat is known from its token. */
export interface LamentRequest {
  title: string;
  body: string;
  severity: Severity;
  /** Id of a lament on this project's board that this one repeats. */
  repeats?: string;
}

export interface LamentResponse {
  text: string;
  lament: string;
}

export class LamentError extends Error {}

export const emptyLaments = (): Laments => ({ version: 1, laments: [] });

const ID = /^[a-z0-9]{6}$/;

export const isSeverity = (value: unknown): value is Severity => SEVERITIES.includes(value as Severity);

/** The worst of its reports. */
export function lamentSeverity(lament: Lament): Severity {
  return lament.reports.reduce<Severity>((worst, report) => (rank(report.severity) > rank(worst) ? report.severity : worst), "annoying");
}

/** A project's laments, worst first, then the most recent. */
export function projectLaments(laments: Laments, cwd: string, resolved = false): Lament[] {
  return laments.laments
    .filter((lament) => lament.cwd === cwd && Boolean(lament.resolvedAt) === resolved)
    .sort((a, b) => rank(lamentSeverity(b)) - rank(lamentSeverity(a)) || b.updatedAt - a.updatedAt);
}

export function freshLamentId(laments: Laments, random: () => number = Math.random): string {
  const taken = new Set(laments.laments.map((lament) => lament.id));
  for (;;) {
    const id = Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, "0");
    if (!taken.has(id)) return id;
  }
}

/** Apply one change. Ops come from the renderer and from agents, so every field is checked. Throws LamentError. */
export function applyLamentOp(laments: Laments, op: LamentOp, now: number): Laments {
  switch (op?.type) {
    case "file": {
      const id = op.id ?? freshLamentId(laments);
      if (!ID.test(id) || laments.laments.some((lament) => lament.id === id)) throw new LamentError(`invalid lament id ${id}`);
      const lament: Lament = { id, title: title(op.title), cwd: path(op.cwd, "cwd"), reports: [report(op, now)], createdAt: now, updatedAt: now };
      return { ...laments, laments: [...laments.laments, lament] };
    }
    case "repeat": {
      const lament = find(laments, op.id);
      const reports = [...lament.reports, report(op, now)];
      // Keep how it started and the latest evidence.
      const kept = reports.length > LAMENT_LIMITS.reports ? [reports[0] as LamentReport, ...reports.slice(1 - LAMENT_LIMITS.reports)] : reports;
      return update(laments, { ...lament, reports: kept, resolvedAt: undefined, updatedAt: now });
    }
    case "fix": {
      const lament = find(laments, op.id);
      const fix: LamentFix = { at: now, chat: chatRef(op.chat) };
      if (op.branch !== undefined) fix.branch = branch(op.branch);
      // A chat recorded again moves to the end rather than repeating. Not news about the gap, so updatedAt stays.
      const fixes = [...(lament.fixes ?? []).filter((other) => other.chat.path !== fix.chat.path), fix].slice(-LAMENT_LIMITS.fixes);
      return update(laments, { ...lament, fixes });
    }
    case "resolve": {
      const lament = find(laments, op.id);
      if (Boolean(lament.resolvedAt) === Boolean(op.resolved)) return laments;
      return update(laments, { ...lament, resolvedAt: op.resolved ? now : undefined, updatedAt: now });
    }
    case "remove":
      find(laments, op.id);
      return { ...laments, laments: laments.laments.filter((lament) => lament.id !== op.id) };
    default:
      throw new LamentError(`unknown lament op ${String((op as { type?: unknown })?.type)}`);
  }
}

/** Read a laments file, keeping the laments that are well formed. */
export function parseLaments(value: unknown): { laments: Laments; dropped: number } {
  const laments = (value as { laments?: unknown } | null)?.laments;
  if (!Array.isArray(laments)) throw new LamentError("not a laments file");
  const valid = laments.filter(isLament);
  return { laments: { version: 1, laments: valid }, dropped: laments.length - valid.length };
}

function isLament(value: unknown): value is Lament {
  const lament = value as Partial<Lament> | null;
  return (
    typeof lament?.id === "string" &&
    typeof lament.title === "string" &&
    typeof lament.cwd === "string" &&
    Array.isArray(lament.reports) &&
    lament.reports.length > 0 &&
    lament.reports.every((report) => typeof report?.text === "string" && typeof report.at === "number" && isSeverity(report.severity)) &&
    (lament.fixes === undefined || (Array.isArray(lament.fixes) && lament.fixes.every(isFix))) &&
    (lament.resolvedAt === undefined || typeof lament.resolvedAt === "number") &&
    typeof lament.createdAt === "number" &&
    typeof lament.updatedAt === "number"
  );
}

function isFix(value: unknown): value is LamentFix {
  const fix = value as Partial<LamentFix> | null;
  return typeof fix?.at === "number" && typeof fix.chat?.path === "string" && typeof fix.chat.cwd === "string" && (fix.branch === undefined || typeof fix.branch === "string");
}

const rank = (severity: Severity) => SEVERITIES.indexOf(severity);

function report(op: { text: unknown; severity: unknown; chat?: { path: unknown; cwd: unknown } }, now: number): LamentReport {
  if (!isSeverity(op.severity)) throw new LamentError(`unknown severity ${String(op.severity)}; use one of ${SEVERITIES.join(", ")}`);
  const body = text(op.text, "body", LAMENT_LIMITS.text).trim();
  if (!body) throw new LamentError("a lament needs a body: what was missing and how you worked around it");
  const entry: LamentReport = { at: now, text: body, severity: op.severity };
  if (op.chat) entry.chat = chatRef(op.chat);
  return entry;
}

function chatRef(chat: { path: unknown; cwd: unknown } | undefined): { path: string; cwd: string } {
  return { path: path(chat?.path, "chat path"), cwd: path(chat?.cwd, "chat cwd") };
}

/** A branch name like the ones pi-gna makes (pigna/<id>-<words>): letters, digits and . _ - / +, without "..". */
function branch(value: unknown): string {
  if (typeof value !== "string" || value.length > LAMENT_LIMITS.branch || !/^[\w./+-]+$/.test(value) || value.includes("..")) {
    throw new LamentError(`invalid branch ${String(value)}`);
  }
  return value;
}

function find(laments: Laments, id: string): Lament {
  const lament = laments.laments.find((other) => other.id === id);
  if (!lament) throw new LamentError(`no lament ${String(id)}`);
  return lament;
}

function update(laments: Laments, lament: Lament): Laments {
  return { ...laments, laments: laments.laments.map((other) => (other.id === lament.id ? lament : other)) };
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new LamentError(`${field} must be text`);
  if (value.length > max) throw new LamentError(`${field} is too long (${value.length} characters, at most ${max})`);
  return value;
}

function title(value: unknown): string {
  const clean = text(value, "title", LAMENT_LIMITS.title).replace(/\s+/g, " ").trim();
  if (!clean) throw new LamentError("a lament needs a title");
  return clean;
}

function path(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096) throw new LamentError(`${field} must be an absolute path`);
  return value;
}
