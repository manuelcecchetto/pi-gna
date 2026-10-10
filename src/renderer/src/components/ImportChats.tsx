// Settings > Import chats: the chats you had with Codex and Claude Code on this Mac, by project, imported into pi's
// sessions so the sidebar lists them in their projects (src/main/chat-import). Only the chats a person started list:
// subagents, scripted runs and the Claude Code sessions pi itself drives (claude-bridge) are left out.
import { useCallback, useEffect, useMemo, useState } from "react";
import { IMPORT_SOURCE_LABELS, IMPORT_SOURCES, type ImportProgress, type ImportProject, type ImportResult, type ImportScan } from "../../../shared/chat-import";
import { baseName, relativeTime, tildify } from "../lib/format";
import { refreshProjects, remoteError, toast } from "../state/app";
import { TriangleAlert } from "./icons";
import { Switch } from "./primitives";
import { Button, Card, Row } from "./SettingsControls";

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** What importing the project would do now. */
const pending = (project: ImportProject) => project.fresh + project.changed;

function projectStatus(project: ImportProject): string {
  const parts = [project.fresh > 0 && `${project.fresh.toLocaleString()} new`, project.changed > 0 && `${project.changed.toLocaleString()} changed`].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Imported";
}

function sourceCounts(project: ImportProject): string {
  return IMPORT_SOURCES.filter((source) => project.chats[source] > 0)
    .map((source) => `${project.chats[source].toLocaleString()} ${IMPORT_SOURCE_LABELS[source]}`)
    .join(" · ");
}

export function ImportChatsSection() {
  const [scan, setScan] = useState<ImportScan>();
  const [failed, setFailed] = useState<string>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showScratch, setShowScratch] = useState(false);
  const [progress, setProgress] = useState<ImportProgress>();
  const [result, setResult] = useState<ImportResult>();

  const load = useCallback(async (keepChoice: boolean) => {
    try {
      const next = await window.studio.imports.scan();
      setScan(next);
      setFailed(undefined);
      // At first, every project with something to import, except scratch folders.
      if (!keepChoice) setChosen(new Set(next.projects.filter((project) => pending(project) > 0 && !project.scratch).map((project) => project.cwd)));
    } catch (error) {
      setFailed(remoteError(error));
    }
  }, []);
  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => window.studio.imports.onProgress(setProgress), []);

  const projects = scan?.projects ?? [];
  const [kept, scratch] = useMemo(() => [projects.filter((project) => !project.scratch), projects.filter((project) => project.scratch)], [projects]);
  const total = projects.filter((project) => chosen.has(project.cwd)).reduce((sum, project) => sum + pending(project), 0);
  const busy = progress !== undefined && result === undefined;

  const toggle = (cwd: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(cwd);
      else next.delete(cwd);
      return next;
    });

  const run = async () => {
    setResult(undefined);
    setProgress({ done: 0, total });
    try {
      const done = await window.studio.imports.run([...chosen]);
      setResult(done);
      refreshProjects();
      await load(true);
    } catch (error) {
      setProgress(undefined);
      toast(`Import failed: ${remoteError(error)}`, "error");
    }
  };

  if (failed) {
    return (
      <div className="flex gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[12.5px] text-fg">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
        <p className="selectable min-w-0 break-words">Could not read your chats: {failed}</p>
      </div>
    );
  }
  if (!scan) return <p className="text-[12.5px] text-muted">Looking for chats…</p>;

  const home = window.studio.homeDir;
  return (
    <>
      <Card title="Found on this Mac">
        {scan.sources.map((source) => (
          <Row
            key={source.source}
            title={IMPORT_SOURCE_LABELS[source.source]}
            about={
              <>
                <span className="font-mono">{tildify(source.root, home)}</span>
                {source.found && source.skipped > 0 && (
                  <span>
                    {" "}
                    · {count(source.skipped, "transcript")} left out ({source.source === "codex" ? "subagents and scripted runs" : "chats pi ran through Claude Code, and scripted runs"})
                  </span>
                )}
              </>
            }
          >
            <span className="text-[12.5px] text-muted">{source.found ? count(source.chats, "chat") : "Not found"}</span>
          </Row>
        ))}
      </Card>

      {projects.length > 0 && (
        <Card
          title="Projects"
          note="Chats keep their dates, so the sidebar shows them in their place in history and today's chats stay on top. Long tool outputs are cut to their start and end, and images are left out. Importing again brings in only what changed; a chat you continued in pi stays as it is."
        >
          {kept.map((project) => (
            <ProjectRow key={project.cwd} project={project} on={chosen.has(project.cwd)} disabled={busy} onChange={(on) => toggle(project.cwd, on)} />
          ))}
          {scratch.length > 0 && (
            <button type="button" onClick={() => setShowScratch(!showScratch)} className="px-3 py-2 text-left text-[12.5px] text-faint hover:text-muted">
              {showScratch ? "Hide" : "Show"} {count(scratch.length, "scratch folder")} (temp folders and Codex's folders for chats outside a project)
            </button>
          )}
          {showScratch && scratch.map((project) => <ProjectRow key={project.cwd} project={project} on={chosen.has(project.cwd)} disabled={busy} onChange={(on) => toggle(project.cwd, on)} />)}
        </Card>
      )}

      {projects.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Button primary disabled={busy || total === 0} onClick={() => void run()}>
              {total === 0 ? "Nothing to import" : `Import ${count(total, "chat")}`}
            </Button>
            {progress && !result && <span className="text-[12.5px] text-muted">{progress.total === 0 ? "Reading…" : `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}…`}</span>}
          </div>
          {progress && !result && progress.total > 0 && (
            <div className="h-1 overflow-hidden rounded-full bg-raised">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, (progress.done / progress.total) * 100)}%` }} />
            </div>
          )}
          {result && <ResultNote result={result} />}
        </div>
      )}
    </>
  );
}

function ProjectRow({ project, on, disabled, onChange }: { project: ImportProject; on: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const todo = pending(project);
  const notes = [sourceCounts(project), `last ${relativeTime(project.updatedAt)}`, project.missing && "folder no longer exists"].filter(Boolean).join(" · ");
  return (
    <Row
      title={baseName(project.cwd) || project.cwd}
      about={
        <>
          <span className="font-mono">{tildify(project.cwd, window.studio.homeDir)}</span>
          <br />
          {notes}
        </>
      }
    >
      <span className={`text-[12px] ${todo > 0 ? "text-muted" : "text-faint"}`}>{projectStatus(project)}</span>
      <Switch on={on && todo > 0} disabled={disabled || todo === 0} onChange={onChange} title={todo === 0 ? "Everything here is imported" : on ? "Leave out" : "Import"} />
    </Row>
  );
}

function ResultNote({ result }: { result: ImportResult }) {
  const parts = [
    result.imported > 0 && `${count(result.imported, "chat")} imported`,
    result.updated > 0 && `${result.updated.toLocaleString()} updated`,
    result.kept > 0 && `${result.kept.toLocaleString()} continued in pi, left as they are`,
  ].filter(Boolean);
  return (
    <div className="text-[12.5px] leading-relaxed text-muted">
      <p>{parts.length > 0 ? `${parts.join(", ")}. They are in the sidebar, under their projects.` : "Everything was already imported."}</p>
      {result.failed.length > 0 && (
        <details className="mt-1 text-warn">
          <summary className="cursor-pointer">{count(result.failed.length, "chat")} could not be read</summary>
          <ul className="selectable mt-1 flex flex-col gap-0.5 font-mono text-[11.5px] text-faint">
            {result.failed.map((failure) => (
              <li key={failure.file} className="break-all">
                {tildify(failure.file, window.studio.homeDir)}: {failure.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
