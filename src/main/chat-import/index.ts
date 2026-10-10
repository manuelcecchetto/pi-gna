// Settings > Import chats: lists the chats a person had with Codex and Claude Code on this Mac, by project, and writes
// the chosen projects' chats into pi's session store, where the sidebar lists them like any pi chat.
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ImportProgress, ImportProject, ImportResult, ImportScan, ImportSource } from "../../shared/chat-import";
import { log } from "../log";
import { claudeProjects, listClaude, readClaude } from "./claude";
import { codexHome, listCodex, readCodex } from "./codex";
import { forEachLimit, NotAPersonsChat, type SourceChat } from "./common";
import { importedSessionPath, importState, type ImportState, writeImportedSession } from "./session";

export interface ChatImportOptions {
  /** pi's sessions folder, read when a scan or an import starts (PI_CODING_AGENT_DIR may come from the login shell). */
  sessionsDir(): string;
  codexHome?: () => string;
  claudeProjects?: () => string;
  home?: string;
  /** Each finished chat of a run (the Settings page's progress bar). */
  progress?: (update: ImportProgress) => void;
  /** Where the chats that held nothing to import are remembered (userData/chat-import.json), so they never list as new. */
  emptyFile?: string;
}

/** Source file -> the size and mtime it had when it was read and held nothing to import. */
type Empties = Record<string, { size: number; mtimeMs: number }>;

interface Planned {
  chat: SourceChat;
  path: string;
  state: ImportState;
}

const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

export class ChatImporter {
  private running: Promise<ImportResult> | undefined;
  private empties: Empties | undefined;

  constructor(private readonly options: ChatImportOptions) {}

  /** Temp folders, and the folder Codex makes for a chat started outside a project (~/Documents/Codex/<date>/<slug>). */
  isScratch(cwd: string): boolean {
    const home = this.options.home ?? homedir();
    const temps = new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]);
    for (const temp of [...temps]) {
      try {
        temps.add(realpathSync(temp));
      } catch {
        // not on this system
      }
    }
    return [...temps].some((temp) => within(cwd, temp)) || within(cwd, join(home, "Documents", "Codex"));
  }

  private async loadEmpties(): Promise<Empties> {
    if (this.empties) return this.empties;
    let empties: Empties = {};
    if (this.options.emptyFile) {
      try {
        const parsed = JSON.parse(await readFile(this.options.emptyFile, "utf8"));
        if (parsed && typeof parsed.empty === "object") empties = parsed.empty as Empties;
      } catch {
        // none yet
      }
    }
    this.empties = empties;
    return empties;
  }

  private async saveEmpties(empties: Empties): Promise<void> {
    const file = this.options.emptyFile;
    if (!file) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, empty: empties }));
      await rename(`${file}.tmp`, file);
    } catch (error) {
      log.warn("import", `save ${file}: ${(error as Error).message}`);
    }
  }

  private async plan(): Promise<{ sources: ImportScan["sources"]; planned: Planned[] }> {
    const sessionsDir = this.options.sessionsDir();
    const empties = await this.loadEmpties();
    const [codex, claude] = await Promise.all([listCodex((this.options.codexHome ?? codexHome)()), listClaude((this.options.claudeProjects ?? claudeProjects)())]);
    const planned: Planned[] = [];
    await forEachLimit([...codex.chats, ...claude.chats], 32, async (chat) => {
      const path = importedSessionPath(sessionsDir, chat);
      const empty = empties[chat.file];
      const state = empty && empty.size === chat.size && empty.mtimeMs === chat.mtimeMs ? "current" : await importState(path, chat);
      planned.push({ chat, path, state });
    });
    const sources: ImportScan["sources"] = [
      { source: "codex", root: codex.root, found: codex.found, chats: codex.chats.length, skipped: codex.skipped },
      { source: "claude", root: claude.root, found: claude.found, chats: claude.chats.length, skipped: claude.skipped },
    ];
    return { sources, planned };
  }

  async scan(): Promise<ImportScan> {
    const { sources, planned } = await this.plan();
    const projects = new Map<string, ImportProject>();
    for (const { chat, state } of planned) {
      const project = projects.get(chat.cwd) ?? {
        cwd: chat.cwd,
        scratch: this.isScratch(chat.cwd),
        missing: !existsSync(chat.cwd),
        chats: { codex: 0, claude: 0 } satisfies Record<ImportSource, number>,
        fresh: 0,
        changed: 0,
        current: 0,
        updatedAt: 0,
      };
      project.chats[chat.source]++;
      if (state === "fresh") project.fresh++;
      else if (state === "changed") project.changed++;
      else project.current++;
      project.updatedAt = Math.max(project.updatedAt, chat.mtimeMs);
      projects.set(chat.cwd, project);
    }
    return { sources, projects: [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  /** Imports the chats of `projects` (cwds from a scan); one import at a time. */
  run(projects: string[], progress: (update: ImportProgress) => void = this.options.progress ?? (() => undefined)): Promise<ImportResult> {
    if (this.running) return Promise.reject(new Error("An import is already running"));
    const run = this.importChats(new Set(projects), progress).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async importChats(projects: Set<string>, progress: (update: ImportProgress) => void): Promise<ImportResult> {
    const { planned } = await this.plan();
    const empties = await this.loadEmpties();
    const chosen = planned.filter((item) => projects.has(item.chat.cwd));
    const result: ImportResult = { imported: 0, updated: 0, unchanged: 0, kept: 0, failed: [] };
    const work = chosen.filter((item) => {
      if (item.state === "current") result.unchanged++;
      else if (item.state === "continued") result.kept++;
      return item.state === "fresh" || item.state === "changed";
    });
    // Biggest first, so one huge rollout does not run alone at the end.
    work.sort((a, b) => b.chat.size - a.chat.size);
    let done = 0;
    progress({ done, total: work.length });
    const started = Date.now();
    await forEachLimit(work, 4, async ({ chat, path, state }) => {
      try {
        const entries = chat.source === "codex" ? await readCodex(chat) : await readClaude(chat);
        if (entries.some((entry) => entry.kind === "message" && entry.message.role === "user")) {
          await writeImportedSession(path, chat, entries);
          if (state === "fresh") result.imported++;
          else result.updated++;
        } else {
          empties[chat.file] = { size: chat.size, mtimeMs: chat.mtimeMs };
          result.unchanged++;
        }
      } catch (error) {
        if (error instanceof NotAPersonsChat) {
          empties[chat.file] = { size: chat.size, mtimeMs: chat.mtimeMs };
          result.unchanged++;
        } else result.failed.push({ file: chat.file, error: error instanceof Error ? error.message : String(error) });
      }
      progress({ done: ++done, total: work.length });
    });
    await this.saveEmpties(empties);
    log.info("import", `${result.imported} imported, ${result.updated} updated, ${result.unchanged} unchanged, ${result.kept} kept, ${result.failed.length} failed in ${Date.now() - started} ms`);
    for (const failure of result.failed) log.warn("import", `${failure.file}: ${failure.error}`);
    return result;
  }
}
