// Composer attachments. Like Codex's local agent, files and folders are sent as paths in a
// "# Files mentioned by the user:" block (pi reads them with its own tools); images also travel as
// image content so the model sees them. pi resizes images itself (images.autoResize).
import { type FileMention, formatFileMentions, splitFileMentions, stripStudioBlocks } from "../../../shared/file-mentions";
import type { PickedPath } from "../../../shared/ipc";
import type { ImageContent } from "../../../shared/protocol";

export type Attachment =
  | { id: string; kind: "image"; name: string; mimeType: string; data: string; path?: string }
  | { id: string; kind: "file"; name: string; path: string; isDir: boolean };

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

export { type FileMention, formatFileMentions, splitFileMentions, stripStudioBlocks };

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
