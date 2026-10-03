// Composer attachments. Like Codex's local agent, files and folders are sent as paths in a
// "# Files mentioned by the user:" block (pi reads them with its own tools); images also travel as
// image content so the model sees them. pi resizes images itself (images.autoResize).
import type { PickedPath } from "../../../shared/ipc";
import type { ImageContent } from "../../../shared/protocol";

export type Attachment =
  | { id: string; kind: "image"; name: string; mimeType: string; data: string; path?: string }
  | { id: string; kind: "file"; name: string; path: string; isDir: boolean };

const HEADER = "# Files mentioned by the user:";
let seq = 0;
const nextId = () => `a${++seq}`;

export function fromPicked(picked: PickedPath): Attachment {
  if (picked.image) return { id: nextId(), kind: "image", name: picked.name, path: picked.path, ...picked.image };
  return { id: nextId(), kind: "file", name: picked.name, path: picked.path, isDir: picked.isDir };
}

export function fromImageData(name: string, mimeType: string, data: string): Attachment {
  return { id: nextId(), kind: "image", name, mimeType, data };
}

/** Add without duplicating paths already attached. */
export function mergeAttachments(current: Attachment[], incoming: Attachment[]): Attachment[] {
  const paths = new Set(current.flatMap((a) => (a.path ? [a.path] : [])));
  return [...current, ...incoming.filter((a) => !a.path || !paths.has(a.path))];
}

export function attachmentImages(attachments: Attachment[]): ImageContent[] {
  return attachments.flatMap((a) => (a.kind === "image" ? [{ type: "image" as const, data: a.data, mimeType: a.mimeType }] : []));
}

/** Codex-style mention block for everything that has a path. Empty when nothing has one. */
export function formatFileMentions(attachments: Attachment[]): string {
  const lines = attachments.flatMap((a) => {
    if (!a.path) return [];
    if (a.kind === "file") return [`## ${a.name}${a.isDir ? "/" : ""}: ${a.path}${a.isDir && !a.path.endsWith("/") ? "/" : ""}`];
    return [`## ${a.name}: ${a.path} (image attached)`];
  });
  return lines.length ? `${HEADER}\n\n${lines.join("\n")}` : "";
}

export interface FileMention {
  label: string;
  path: string;
  isDir: boolean;
  image: boolean;
}

/**
 * Pull the mention block back out of a sent message so the transcript can show chips instead.
 * The block ends at the first line that is not a mention: pi can append text after it (for example a
 * note that an image was omitted), which is kept.
 */
export function splitFileMentions(text: string): [string, FileMention[]] {
  const index = text.lastIndexOf(HEADER);
  if (index === -1) return [text, []];
  const lines = text.slice(index + HEADER.length).split("\n");
  const mentions: FileMention[] = [];
  let consumed = 0;
  for (const line of lines) {
    const match = line.match(/^## (.+?): (\/.*?)( \(image attached\))?$/);
    if (match?.[1] && match[2]) mentions.push({ label: match[1], path: match[2], isDir: match[2].endsWith("/"), image: Boolean(match[3]) });
    else if (line.trim() && mentions.length) break;
    else if (line.trim()) return [text, []]; // a quoted header, not our block
    consumed++;
  }
  if (!mentions.length) return [text, []];
  const rest = lines.slice(consumed).join("\n").trim();
  return [[text.slice(0, index).trimEnd(), rest].filter(Boolean).join("\n\n"), mentions];
}

export interface CardMention {
  id: string;
  title: string;
}

/** Pull a Kanban card's details (cardBlock) out of a sent message, so the transcript can show a chip instead. */
export function splitCardBlock(text: string): [string, CardMention | undefined] {
  const block = text.match(/\n*<kanban-card>\n?([\s\S]*?)\n?<\/kanban-card>\n*/);
  const head = block?.[1]?.match(/^Card (\S+): (.*)$/m);
  if (!block || !head?.[1]) return [text, undefined];
  return [text.replace(block[0], "\n\n").trim(), { id: head[1], title: head[2] ?? "" }];
}

/** Message text without the blocks pi-gna adds (file mentions, browser comments, a Kanban card's details). */
export function stripStudioBlocks(text: string): string {
  return splitFileMentions(text)[0].replace(/\n*<(browser-comments|kanban-card)>[\s\S]*?<\/\1>\n*/g, "\n").trim();
}
