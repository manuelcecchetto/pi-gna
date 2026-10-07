// The File screen: a chat's text file or image drawn on the phone (docs/FILE_PREVIEW.md, Phone), instead of a stream of
// the Mac's preview tab, which lags and letterboxes on a phone. Markdown renders with the transcript's own component (its
// links resolve from the file's folder), code, text and JSON as highlighted lines with a gutter, CSV as a table, and an
// image opens the lightbox. The host reads at most PREVIEW_LIMITS.text bytes; a binary file offers the Mac's stream.
import { Copy, Monitor } from "../renderer/src/components/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../renderer/src/components/Markdown";
import { type ChatUi, ChatUiProvider, useChatUiHandle } from "../renderer/src/lib/chat-ui";
import { highlight } from "../renderer/src/lib/highlight";
import { markdownBlockLines } from "../renderer/src/lib/markdown";
import { shortenHome } from "../renderer/src/lib/preview";
import { parseCsv } from "../preview/csv";
import { formatBytes, splitLines } from "../preview/format";
import { splitFrontMatter } from "../preview/links";
import { baseName, kindFor, languageFor, modesFor, PREVIEW_LIMITS, type PreviewMode, type PreviewText } from "../shared/preview";
import { fileLinks, streamFile } from "./chat-ui";
import type { HostClient } from "./client/host-client";
import { blockForLine, linesBefore, prettyJson } from "./file-data";
import type { Route } from "./nav";
import { copy, Header } from "./Screens";

type Loaded = { type: "text"; file: PreviewText } | { type: "image"; src: string } | { type: "error"; message: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

export function FileScreen({ client, handle, path, line, push, back }: { client: HostClient; handle: string; path: string; line?: number; push: (route: Route) => void; back: () => void }) {
  const ui = useChatUiHandle();
  const kind = kindFor(path);
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    let live = true;
    const load: Promise<Loaded> =
      kind === "image"
        ? client.call("chat.linkImage", { handle, target: path }).then((image) => (image ? { type: "image", src: `data:${image.mimeType};base64,${image.data}` } : { type: "error", message: "This image is too large to show on the phone." }))
        : client.call("chat.readFile", { handle, path }).then((file) => ({ type: "text", file }));
    load.then(
      (value) => live && setLoaded(value),
      (error) => live && setLoaded({ type: "error", message: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [client, handle, path, kind]);

  const file = loaded?.type === "text" ? loaded.file : undefined;
  // An unknown extension that reads as text is "text" (the host decides); an image has one view here.
  const modes: PreviewMode[] = kind === "image" ? ["rendered"] : modesFor(path, file?.kind ?? kind);
  const [mode, setMode] = useState<PreviewMode>(modes[0] as PreviewMode);
  const [wrap, setWrap] = useState(true);
  const lines = useMemo(() => (file?.text !== undefined ? splitLines(file.text) : []), [file]);
  const codeView = file?.text !== undefined && (mode === "raw" || file.kind === "code" || file.kind === "text" || file.kind === "json");

  const notes = file?.text !== undefined ? [`${lines.length.toLocaleString("en-US")} line${lines.length === 1 ? "" : "s"}`, formatBytes(file.size)] : [];
  if (file?.truncated) notes.push(`showing the first ${formatBytes(PREVIEW_LIMITS.text)}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-screen">
      <Header
        title={baseName(path)}
        subtitle={shortenHome(dirOf(path), ui.actions.homeDir)}
        onBack={back}
        trailing={
          file?.text !== undefined && (
            <button type="button" aria-label="Copy the text" onClick={() => copy(file.text ?? "")} className="grid h-11 w-11 shrink-0 place-items-center text-muted active:text-fg">
              <Copy size={18} />
            </button>
          )
        }
      />
      {file?.text !== undefined && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
          {modes.length > 1 &&
            modes.map((each) => (
              <button key={each} type="button" aria-pressed={each === mode} onClick={() => setMode(each)} className={`min-h-9 rounded-lg border px-3 text-[13px] capitalize ${each === mode ? "border-accent/60 text-fg" : "border-line text-muted"}`} data-testid={`file-mode-${each}`}>
                {each}
              </button>
            ))}
          <span className="min-w-0 flex-1 truncate px-1 text-[12px] text-faint" data-testid="file-notes">
            {notes.join(" · ")}
          </span>
          {codeView && (
            <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)} className={`min-h-9 shrink-0 rounded-lg border px-3 text-[13px] ${wrap ? "border-accent/60 text-fg" : "border-line text-muted"}`}>
              Wrap
            </button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain" data-testid="file-view">
        {!loaded ? (
          <p className="p-6 text-center text-[13.5px] text-faint">Loading…</p>
        ) : loaded.type === "error" ? (
          <p className="p-6 text-center text-[13.5px] text-bad wrap-anywhere">{loaded.message}</p>
        ) : loaded.type === "image" ? (
          <button type="button" onClick={() => ui.actions.openLightbox(loaded.src)} className="block w-full p-4" aria-label="Zoom the image">
            <img src={loaded.src} alt={baseName(path)} className="mx-auto max-h-[75vh] max-w-full object-contain" data-testid="file-image" />
          </button>
        ) : loaded.file.text === undefined ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-[13.5px] text-muted">This file is not text, so the phone cannot draw it.</p>
            <button type="button" onClick={() => streamFile(client, push, handle, path, line)} className="flex min-h-11 items-center gap-2 rounded-xl border border-line-strong px-4 text-[14px] text-fg active:bg-raised" data-testid="file-stream">
              <Monitor size={16} className="text-muted" /> Show the Mac's preview
            </button>
          </div>
        ) : loaded.file.text === "" ? (
          <p className="p-6 text-center text-[13.5px] text-faint">This file is empty.</p>
        ) : codeView ? (
          <CodeFile text={loaded.file.kind === "json" && mode === "rendered" && !loaded.file.truncated ? prettyJson(loaded.file.text) : loaded.file.text} lang={loaded.file.kind === "text" ? undefined : languageFor(path)} line={line} wrap={wrap} />
        ) : loaded.file.kind === "table" ? (
          <TableFile text={loaded.file.text} name={loaded.file.name} />
        ) : (
          <MarkdownFile ui={ui} client={client} push={push} handle={handle} path={path} text={loaded.file.text} line={line} />
        )}
      </div>
    </div>
  );
}

/** Highlighted lines with a gutter (shiki, as in the Mac's viewer), the jump line marked and centered. */
function CodeFile({ text, lang, line, wrap }: { text: string; lang?: string; line?: number; wrap: boolean }) {
  const lines = useMemo(() => splitLines(text), [text]);
  const [html, setHtml] = useState<string>();
  const code = useRef<HTMLElement>(null);
  useEffect(() => {
    setHtml(undefined);
    if (!lang || text.length > PREVIEW_LIMITS.highlight || lines.length > PREVIEW_LIMITS.highlightLines) return;
    let live = true;
    // Shiki emits one `.line` span per line, separated by newlines that would render as blank lines in blocks. It is
    // given the lines as split, so a trailing newline does not add a numbered empty line the plain view lacks.
    highlight(lines.join("\n"), lang, PREVIEW_LIMITS.highlight).then(
      (result) => live && result && setHtml(result.replaceAll("\n", "")),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [text, lang, lines]);
  // Highlighting replaces the line elements: mark the jump line again then.
  useLayoutEffect(() => {
    if (!line || !code.current) return;
    const target = code.current.children[Math.min(line, lines.length) - 1];
    target?.classList.add("target");
    target?.scrollIntoView({ block: "center" });
  }, [html, line, lines.length]);
  const gutter = { "--gutter": `${String(lines.length).length + 1}ch` } as React.CSSProperties;
  return (
    <pre className={`file-code selectable ${wrap ? "wrap" : ""}`} data-testid="file-code">
      {html ? (
        <code ref={code} className="code hl" style={gutter} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code ref={code} className="code" style={gutter}>
          {lines.map((text, index) => (
            <span key={index} className="line">
              {text}
            </span>
          ))}
        </code>
      )}
    </pre>
  );
}

/** CSV/TSV: the first PREVIEW_LIMITS.tableRows rows, the header row sticky; Raw shows the text. */
function TableFile({ text, name }: { text: string; name: string }) {
  const { rows, truncated } = useMemo(() => parseCsv(text, name.toLowerCase().endsWith(".tsv") ? "\t" : ",", PREVIEW_LIMITS.tableRows + 1), [text, name]);
  const [header = [], ...body] = rows;
  const shown = body.slice(0, PREVIEW_LIMITS.tableRows);
  const columns = Math.max(header.length, ...shown.map((row) => row.length));
  const cells = (row: string[]) => Array.from({ length: columns }, (_, c) => row[c] ?? "");
  return (
    <div className="selectable">
      <table className="min-w-full border-collapse text-[12.5px]" data-testid="file-table">
        <thead className="sticky top-0 bg-panel">
          <tr>
            <th className="border-b border-line px-2 py-1.5 text-right font-mono text-[11px] font-normal text-faint" />
            {cells(header).map((cell, c) => (
              <th key={c} className="border-b border-line px-2 py-1.5 text-left font-medium whitespace-nowrap text-fg">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r} className="border-b border-line">
              <td className="px-2 py-1 text-right font-mono text-[11px] text-faint">{r + 1}</td>
              {cells(row).map((cell, c) => (
                <td key={c} className="max-w-[16rem] px-2 py-1 align-top text-muted wrap-anywhere">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncated || body.length > shown.length) && <p className="p-3 text-[12px] text-faint">Showing the first {PREVIEW_LIMITS.tableRows.toLocaleString("en-US")} rows; switch to Raw for the rest.</p>}
    </div>
  );
}

/**
 * Rendered Markdown with the transcript's component, its front matter as a small table. Links and embedded images
 * resolve from the file's folder (fileLinks), and a jump line scrolls to the block it falls in.
 */
function MarkdownFile({ ui, client, push, handle, path, text, line }: { ui: ChatUi; client: HostClient; push: (route: Route) => void; handle: string; path: string; text: string; line?: number }) {
  const { entries, body } = useMemo(() => splitFrontMatter(text), [text]);
  const scoped = useMemo<ChatUi>(() => ({ store: ui.store, actions: { ...ui.actions, links: fileLinks(client, push, handle, dirOf(path)) } }), [ui, client, push, handle, path]);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const prose = box.current?.querySelector(".prose");
    const starts = markdownBlockLines(body);
    // Only when blocks and elements pair up one to one: a raw HTML block can render as several elements or none.
    if (!line || !prose || !starts || starts.length !== prose.children.length) return;
    const offset = linesBefore(text, body);
    prose.children[blockForLine(starts.map((start) => start + offset), line)]?.scrollIntoView({ block: "start" });
  }, [text, body, line]);
  return (
    <div ref={box} className="px-4 py-3" data-testid="file-markdown">
      {entries.length > 0 && (
        <table className="mb-3 w-full text-[12px]">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b border-line">
                <th className="py-1 pr-3 text-left align-top font-mono font-normal whitespace-nowrap text-faint">{key}</th>
                <td className="py-1 text-muted wrap-anywhere">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ChatUiProvider ui={scoped}>
        <Markdown text={body} />
      </ChatUiProvider>
    </div>
  );
}
