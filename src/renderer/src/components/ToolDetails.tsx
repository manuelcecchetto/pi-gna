import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ImageContent, TextContent, ToolCall, ToolResultLike } from "../../../shared/protocol";
import { styleAfter } from "../lib/ansi";
import { langFromPath } from "../lib/highlight";
import type { ToolRun } from "../../../shared/session-state";
import { Ansi } from "./primitives";
import { CodeView } from "./Markdown";
import { previewClick } from "../lib/preview";
import { useChatActions } from "../lib/chat-ui";
import { type AskAnswer, type AskParams, type AskQuestion, type AskResult, NOT_ANSWERED, normalizeAsk } from "../../../shared/ask";
import { Check } from "./icons";

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

/** The last `count` lines of `text` (a trailing newline ends the last line), and how many lines come before them. */
export function lastLines(text: string, count: number): { tail: string; before: number } {
  let cut = text.endsWith("\n") ? text.length - 1 : text.length;
  for (let n = 0; n < count; n++) {
    cut = text.lastIndexOf("\n", cut - 1);
    if (cut < 0) return { tail: text, before: 0 };
  }
  let before = 0;
  for (let index = text.indexOf("\n"); index >= 0 && index <= cut; index = text.indexOf("\n", index + 1)) before++;
  return { tail: text.slice(cut + 1), before };
}

/** Lines a running command shows: its box (max-h-96) holds about 19, so a few boxes to scroll back through. */
const LIVE_LINES = 60;

/**
 * A running command's output as a terminal shows it: its last lines, kept scrolled to the bottom unless you scroll up.
 * Each update then draws LIVE_LINES lines instead of the first MAX_LINES; the whole output comes back when it ends.
 */
function LiveTail({ text, className }: { text: string; className: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const { tail, before } = lastLines(text, LIVE_LINES);
  // A style set before the tail (a red block of errors) carries into it.
  const start = useMemo(() => styleAfter(text.slice(0, text.length - tail.length)), [text, tail]);
  useLayoutEffect(() => {
    const pre = ref.current;
    if (pre && following.current) pre.scrollTop = pre.scrollHeight;
  }, [text]);
  const onScroll = (event: React.UIEvent<HTMLPreElement>) => {
    const pre = event.currentTarget;
    following.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 2;
  };
  return (
    <pre ref={ref} onScroll={onScroll} className={className}>
      {before > 0 && <span className="select-none text-faint">{`⋯ ${before} earlier lines\n`}</span>}
      <Ansi text={tail} start={start} />
    </pre>
  );
}

function Output({ text, error, live }: { text: string; error?: boolean; live?: boolean }) {
  if (!text.trim()) return <div className="px-3 py-2 font-mono text-[12px] text-faint">(no output)</div>;
  const className = `code selectable max-h-96 overflow-auto whitespace-pre-wrap break-words ${error ? "text-bad" : "text-muted"}`;
  if (live) return <LiveTail text={text} className={className} />;
  return (
    <Clipped text={text}>
      {(visible) => (
        <pre className={className}>
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

const ASK_SOURCE: Record<AskAnswer["source"], string> = { user: "", default: "default: the countdown ran out", skipped: "skipped: took the default" };

/** One option or free-text answer, marked as the card marked it: a filled radio or checkbox when chosen. */
function AskRow({ label, description, multi, on, isDefault }: { label: string; description?: string; multi: boolean; on: boolean; isDefault?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 py-0.5" data-chosen={on || undefined}>
      <span className={`mt-[3px] grid size-3.5 shrink-0 place-items-center ${multi ? "rounded-[4px]" : "rounded-full"} ${on ? "bg-fg text-canvas" : "shadow-[inset_0_0_0_1.5px_var(--line-strong)]"}`}>
        {on && (multi ? <Check size={10} strokeWidth={3} /> : <span className="size-1.5 rounded-full bg-canvas" />)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={on ? "text-fg" : "text-muted"}>{label}</span>
        {isDefault && <span className="ml-2 rounded-full border border-line px-1.5 py-px align-[1px] text-[10.5px] text-faint">default</span>}
        {description && <span className="block text-[11.5px] text-faint">{description}</span>}
      </span>
    </div>
  );
}

/**
 * ask_user's questions and answers as the card showed them: each prompt, its options with the chosen ones filled and
 * where an answer came from when the user did not choose it. Before the answer comes back, the defaults are marked.
 */
function AskDetails({ questions, result }: { questions: AskQuestion[]; result?: AskResult }) {
  return (
    <div className="selectable flex flex-col gap-4 px-3 py-2.5 text-[12.5px]">
      {result?.cancelled && <div className="text-muted">Declined to answer</div>}
      {questions.map((question, index) => {
        const answer = result && !result.cancelled ? result.answers[index] : undefined;
        const chosen = new Set(answer?.values.slice(0, answer.custom ? -1 : undefined));
        const text = answer?.custom ? answer.values.at(-1) : !result ? question.defaultText : undefined;
        return (
          <div key={question.id}>
            <div className="font-medium text-fg">{question.prompt}</div>
            <div className="mt-1.5 flex flex-col">
              {question.options.map((option, i) => (
                <AskRow key={option.label} label={option.label} description={option.description} multi={question.multi} on={chosen.has(option.label)} isDefault={!answer?.values.length ? question.defaultPicks.includes(i) : undefined} />
              ))}
              {text !== undefined && <AskRow label={text} multi={question.multi} on={Boolean(answer)} isDefault={!result} />}
            </div>
            {answer && !answer.values.length && <div className="mt-1 text-faint">{NOT_ANSWERED}</div>}
            {answer?.values.length && answer.source !== "user" ? <div className="mt-1 text-faint">{ASK_SOURCE[answer.source]}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function askResult(details: Record<string, unknown>): AskResult | undefined {
  return Array.isArray(details.questions) && Array.isArray(details.answers) ? (details as unknown as AskResult) : undefined;
}

export function ToolDetails({ call, run }: { call: ToolCall; run?: ToolRun }) {
  const args = call.arguments;
  const result = run?.result ?? run?.partial;
  const text = resultText(result);
  const failed = run?.status === "error";
  const details = (run?.result?.details ?? {}) as Record<string, unknown>;

  // The arguments as JSON and the result's text: any tool without its own view.
  const raw = () => (
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
            <Output text={text} error={failed} live={run?.status === "running"} />
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
    case "ask_user": {
      const answered = askResult(details);
      const asked = answered ?? normalizeAsk(args as unknown as AskParams);
      body =
        "questions" in asked ? (
          <>
            <AskDetails questions={asked.questions} result={answered} />
            {run?.status === "running" && (
              <Section>
                <div className="px-3 py-1.5 text-[11.5px] text-faint">Waiting for an answer</div>
              </Section>
            )}
            {failed && text && (
              <Section>
                <Output text={text} error />
              </Section>
            )}
          </>
        ) : (
          raw()
        );
      break;
    }
    default:
      body = raw();
  }
  return <div className={`mt-1 mb-2 overflow-hidden rounded-xl border bg-sunken ${failed ? "border-bad/40" : "border-line"}`}>{body}</div>;
}
