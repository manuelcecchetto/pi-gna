// Importing Codex and Claude Code chats into pi's session store (Settings > Import chats). Main reads the other
// agents' transcripts and writes pi session files; these are the shapes the page and the host methods share.

export type ImportSource = "codex" | "claude";

export const IMPORT_SOURCES: readonly ImportSource[] = ["codex", "claude"];

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = { codex: "Codex", claude: "Claude Code" };

/** One agent's history on this Mac. */
export interface ImportSourceScan {
  source: ImportSource;
  /** Where its transcripts live (~/.codex/sessions, ~/.claude/projects, or their env overrides). */
  root: string;
  /** The folder exists. */
  found: boolean;
  /** Chats a person started there, which can be imported. */
  chats: number;
  /** Transcripts left out: subagents, scripted runs, and Claude Code sessions driven by pi itself (claude-bridge). */
  skipped: number;
}

/** The chats of one project folder, by what an import would do with them. */
export interface ImportProject {
  cwd: string;
  /** A throwaway folder (temp, Codex's per-chat scratch folders): left out unless chosen. */
  scratch: boolean;
  /** The folder no longer exists; its chats still import and list under it. */
  missing: boolean;
  chats: Record<ImportSource, number>;
  /** Never imported. */
  fresh: number;
  /** Imported before, and the source chat went on since: imported again. */
  changed: number;
  /** Imported and unchanged, or continued in pi since (then left as it is). */
  current: number;
  /** The newest chat's last activity (ms). */
  updatedAt: number;
}

export interface ImportScan {
  sources: ImportSourceScan[];
  projects: ImportProject[];
}

export interface ImportProgress {
  done: number;
  total: number;
}

export interface ImportResult {
  imported: number;
  updated: number;
  unchanged: number;
  /** Continued in pi since they were imported: never overwritten. */
  kept: number;
  failed: { file: string; error: string }[];
}

/** The custom entry an imported session carries (pi never sends custom entries to the model). */
export const IMPORT_ENTRY_TYPE = "pigna.import";

export interface ImportMarker {
  source: ImportSource;
  /** The source's own chat id. */
  id: string;
  file: string;
  /** The source file's size and mtime when it was imported; the session file's mtime is set to the same time. */
  size: number;
  mtimeMs: number;
}
