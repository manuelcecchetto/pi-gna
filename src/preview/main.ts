// File-preview viewer: one page served by main for every kind except rendered HTML. It reads which file
// and mode from its URL (`pigna-file://<token>/<path>?view=raw#L12`), fetches the bytes from the same origin with
// `?raw=1` and dispatches by kind. File contents are untrusted: everything is rendered as text or `<img>`.
// Design: docs/FILE_PREVIEW.md.
import { baseName, extensionOf, kindFor, parsePreviewUrl, type PreviewKind } from "../shared/preview";
import { looksLikeText } from "./format";
import { showDocx } from "./docx";
import { showImage } from "./image";
import { showInfo } from "./info";
import { showMedia } from "./media";
import { showMarkdown } from "./markdown";
import { showTable } from "./table";
import { readBytes, showMessage, type Source } from "./shell";
import { showText } from "./text";
import "./style.css";

async function resolveKind(rawUrl: string, name: string): Promise<PreviewKind> {
  const kind = kindFor(name);
  if (kind !== "other") return kind;
  const head = await readBytes(rawUrl, 4096);
  return head.total === 0 || looksLikeText(head.data) ? "text" : "other";
}

async function main(): Promise<void> {
  const location = new URL(window.location.href);
  const parsed = parsePreviewUrl(location.href);
  if (!parsed) return showMessage("Nothing to preview", "This page needs a file address.", "error");
  const name = baseName(parsed.relative);
  document.title = name;
  const rawUrl = new URL(location.pathname, location.origin);
  rawUrl.searchParams.set("raw", "1");
  showMessage("Loading…", name);
  try {
    const kind = await resolveKind(rawUrl.href, name);
    const line = /^#L?(\d+)/.exec(location.hash)?.[1];
    const source: Source = {
      rawUrl: rawUrl.href,
      name,
      kind,
      mode: parsed.view === "raw" || parsed.view === "source" ? "raw" : "rendered",
      line: line ? Number(line) : undefined,
    };
    switch (kind) {
      case "image":
        // An SVG's source is text; its rendered form is an <img>, which never runs the file's scripts.
        if (source.mode === "raw" && extensionOf(name) === "svg") await showText(source);
        else await showImage(source);
        break;
      case "table":
        if (source.mode === "rendered") await showTable(source);
        else await showText(source);
        break;
      case "code":
      case "text":
      case "json":
      case "html":
        await showText(source);
        break;
      case "docx":
        await showDocx(source);
        break;
      case "pdf":
        // pdf.js and its stylesheet load only for PDFs.
        await (await import("./pdf")).showPdf(source);
        break;
      case "video":
      case "audio":
        showMedia(source);
        break;
      case "markdown":
        if (source.mode === "rendered") await showMarkdown(source);
        else await showText(source);
        break;
      default:
        await showInfo(source);
    }
  } catch (error) {
    showMessage("Can't show this file", error instanceof Error ? error.message : String(error), "error");
  }
}

void main();
