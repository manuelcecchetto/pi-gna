// Shared pieces of the viewer: what is shown, how bytes are read, and the full-page message states.
import type { PreviewKind, PreviewMode } from "../shared/preview";

export interface Source {
  /** Same-origin URL that returns the file bytes. */
  rawUrl: string;
  name: string;
  /** Kind after sniffing: an extensionless text file arrives as `text`. */
  kind: PreviewKind;
  mode: PreviewMode;
  line?: number;
}

export interface Bytes {
  data: Uint8Array;
  /** Size of the whole file, not of `data`. */
  total: number;
  type: string;
}

export const app = document.getElementById("app") as HTMLElement;

/** Replace the page with one centered message (loading, empty, error). */
export function showMessage(title: string, detail?: string, tone: "plain" | "error" = "plain"): void {
  const box = document.createElement("div");
  box.className = `message ${tone}`;
  const heading = document.createElement("div");
  heading.className = "message-title";
  heading.textContent = title;
  box.append(heading);
  if (detail) {
    const text = document.createElement("div");
    text.className = "message-detail";
    text.textContent = detail;
    box.append(text);
  }
  app.replaceChildren(box);
}

class ReadError extends Error {}

/** Read the first `limit` bytes of the file (a Range request; the handler answers 206, or 416 for an empty file). */
export async function readBytes(rawUrl: string, limit: number): Promise<Bytes> {
  let response: Response;
  try {
    response = await fetch(rawUrl, { headers: { range: `bytes=0-${limit - 1}` } });
  } catch {
    throw new ReadError("The file could not be read.");
  }
  const type = response.headers.get("content-type") ?? "";
  if (response.status === 416) return { data: new Uint8Array(), total: 0, type };
  if (response.status === 404) throw new ReadError("This file was not found. It may have been moved or deleted.");
  if (!response.ok) throw new ReadError(`The file could not be read (${response.status}).`);
  const data = new Uint8Array(await response.arrayBuffer());
  const range = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  const total = range ? Number(range[1]) : Number(response.headers.get("content-length") ?? data.length);
  return { data, total, type };
}
