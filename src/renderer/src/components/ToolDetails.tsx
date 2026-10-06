import { useState } from "react";
import type { ImageContent, TextContent, ToolCall, ToolResultLike } from "../../../shared/protocol";
import { langFromPath } from "../lib/highlight";
import type { ToolRun } from "../../../shared/session-state";
import { Ansi } from "./primitives";
import { CodeView } from "./Markdown";
import { previewClick } from "../lib/preview";
import { useChatActions } from "../lib/chat-ui";

const MAX_LINES = 400;

export function resultText(result: ToolResultLike | undefined): string {
  if (!result) return "";
  return result.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function resultImages(result: ToolResultLike | undefined): ImageContent[] {
  return result?.content.filter((block): block is ImageContent => block.type === "image") ?? [];
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

function Clipped({ text, children }: { text: string; children: (visible: string) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const clipped = !all && lines.length > MAX_LINES;
  return (
    <>
      {children(clipped ? lines.slice(0, MAX_LINES).join("\n") : text)}
      {clipped && (
        <button type="button" onClick={() => setAll(true)} className="w-full border-t border-line py-1.5 text-[11.5px] text-muted hover:text-fg">
          Show all {lines.length} lines
        </button>
      )}
    </>
  );
}

function Output({ text, error }: { text: string; error?: boolean }) {
  if (!text.trim()) return <div className="px-3 py-2 font-mono text-[12px] text-faint">(no output)</div>;
  return (
    <Clipped text={text}>
      {(visible) => (
        <pre className={`code selectable max-h-96 overflow-auto whitespace-pre-wrap break-words ${error ? "text-bad" : "text-muted"}`}>
          <Ansi text={visible} />
        </pre>
      )}
    </Clipped>
  );
}

interface DiffRow {
  kind: "add" | "del" | "ctx" | "gap";
  line?: string;
  text: string;
}

/** pi's rendered diffs: "+ 12 text", "-12 text", " 12 text", "    ..." (padding varies). */
export function parseDiff(diff: string): DiffRow[] {
  return diff.split("\n").map((raw) => {
    if (raw.trim() === "...") return { kind: "gap", text: "" };
    const match = raw.match(/^([ +-])\s*(\d+)(?: (.*))?$/);
    if (!match) return { kind: "ctx", text: raw };
    const kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
    return { kind, line: match[2], text: match[3] ?? "" };
  });
}

export function DiffView({ diff }: { diff: string }) {
  const rows = parseDiff(diff);
  return (
    <div className="selectable max-h-[28rem] overflow-auto py-1.5 font-mono text-[12px] leading-[1.6]">
      {rows.map((row, index) =>
        row.kind === "gap" ? (
          <div key={index} className="my-1 border-y border-dashed border-line py-0.5 pl-14 text-faint">
            ⋯
          </div>
        ) : (
          <div
            key={index}
            className="flex min-w-max"
            style={{ background: row.kind === "add" ? "var(--add-bg)" : row.kind === "del" ? "var(--del-bg)" : undefined }}
          >
            <span className="w-11 shrink-0 select-none pr-2 text-right text-faint">{row.line}</span>
            <span className={`w-4 shrink-0 select-none ${row.kind === "add" ? "text-ok" : row.kind === "del" ? "text-bad" : "text-faint"}`}>
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
            </span>
            <span className="whitespace-pre pr-4">{row.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

/** A file path that previews the file on click (cmd-click: new tab). */
export function FileLink({ path, children, className = "" }: { path: string; children?: React.ReactNode; className?: string }) {
  const { links } = useChatActions();
  return (
    <span role="link" onClick={previewClick(links, path)} title="Preview (⌘-click: new tab)" className={`cursor-pointer hover:text-fg hover:underline ${className}`}>
      {children ?? path}
    </span>
  );
}

function Section({ file, path, children }: { file?: string; path?: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line first:border-t-0">
      {file && (
        <div className="selectable px-3 pt-2 font-mono text-[11.5px] text-muted">
          {path ? <FileLink path={path}>{file}</FileLink> : file}
        </div>
      )}
      {children}
    </div>
  );
}


function PathBar({ path }: { path: string }) {
  if (!path) return null;
  return (
    <div className="selectable border-b border-line px-3 py-1.5 font-mono text-[11.5px] text-muted">
      <FileLink path={path} />
    </div>
  );
}

export function ToolDetails({ call, run }: { call: ToolCall; run?: ToolRun }) {
  const args = call.arguments;
  const result = run?.result ?? run?.partial;
  const text = resultText(result);
  const failed = run?.status === "error";
  const details = (run?.result?.details ?? {}) as Record<string, unknown>;

  let body: React.ReactNode;
  switch (call.name) {
    case "bash":
      body = (
        <>
          <pre className="code selectable whitespace-pre-wrap break-words text-fg">
            <span className="select-none text-faint">$ </span>
            {str(args.command)}
          </pre>
          <Section>
            <Output text={text} error={failed} />
          </Section>
        </>
      );
      break;
    case "edit":
    case "apply_patch": {
      const fileDiffs = Array.isArray(details.fileDiffs) ? (details.fileDiffs as { path: string; status?: string; diff: string }[]) : undefined;
      if (fileDiffs?.length) {
        body = fileDiffs.map((file) => (
          <Section key={file.path} file={`${file.status ?? "M"} ${file.path}`} path={file.path}>
            <DiffView diff={file.diff} />
          </Section>
        ));
      } else if (str(details.diff)) {
        body = (
          <Section file={str(args.path)} path={str(args.path)}>
            <DiffView diff={str(details.diff)} />
          </Section>
        );
      } else if (Array.isArray(args.edits)) {
        // Still running or failed before producing a diff: show the requested replacements.
        body = (args.edits as { oldText?: string; newText?: string }[]).map((edit, index) => (
          <Section key={index}>
            <DiffView
              diff={[...str(edit.oldText).split("\n").map((l) => `- ${l}`), ...str(edit.newText).split("\n").map((l) => `+ ${l}`)].join("\n")}
            />
          </Section>
        ));
      } else body = <pre className="code selectable whitespace-pre-wrap text-muted">{str(args.input)}</pre>;
      if (failed && text) body = [body, <Section key="error"><Output text={text} error /></Section>];
      break;
    }
    case "write":
      body = (
        <>
          <PathBar path={str(args.path)} />
          <Clipped text={str(args.content)}>{(visible) => <CodeView code={visible} lang={langFromPath(str(args.path))} className="max-h-96 overflow-auto" />}</Clipped>
          {failed && (
            <Section>
              <Output text={text} error />
            </Section>
          )}
        </>
      );
      break;
    case "read":
      body = failed ? (
        <Output text={text} error />
      ) : (
        <>
          <PathBar path={str(args.path)} />
          {text.trim() && <Clipped text={text}>{(visible) => <CodeView code={visible} lang={langFromPath(str(args.path))} className="max-h-96 overflow-auto" />}</Clipped>}
        </>
      );
      break;
    default:
      body = (
        <>
          <Section>
            <CodeView code={JSON.stringify(args, null, 2)} lang="json" className="max-h-72 overflow-auto" />
          </Section>
          {result && (
            <Section>
              <Output text={text} error={failed} />
            </Section>
          )}
        </>
      );
  }
  return <div className={`mt-1 mb-2 overflow-hidden rounded-xl border bg-sunken ${failed ? "border-bad/40" : "border-line"}`}>{body}</div>;
}
