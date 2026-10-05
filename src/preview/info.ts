// Info card for files with no viewer: the host's toolbar offers Reveal in Finder and Open with default app.
import { app, readBytes, type Source } from "./shell";
import { formatBytes } from "./format";
import { extensionOf } from "../shared/preview";

export async function showInfo(source: Source): Promise<void> {
  const head = await readBytes(source.rawUrl, 1);
  const ext = extensionOf(source.name);
  const rows: [string, string][] = [
    ["Name", source.name],
    ["Size", formatBytes(head.total)],
    ["Type", ext ? `${ext.toUpperCase()} file${head.type && head.type !== "application/octet-stream" ? ` (${head.type.split(";")[0]})` : ""}` : "Binary file"],
  ];
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = "No preview for this file type";
  const list = document.createElement("dl");
  for (const [key, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = key;
    const detail = document.createElement("dd");
    detail.textContent = value;
    list.append(term, detail);
  }
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Use Reveal in Finder or Open with default app in the toolbar above.";
  card.append(title, list, hint);
  const wrap = document.createElement("div");
  wrap.className = "center";
  wrap.append(card);
  app.replaceChildren(wrap);
}
