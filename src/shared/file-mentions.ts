// The "# Files mentioned by the user:" block (Codex style): files and folders go as paths that pi reads with its own
// tools, images also travel as image content. Shared by the desktop composer and the host, which composes a phone's send
// and reads the turns of a chat back for the turn outline (turn-outline.ts).
export const FILE_MENTIONS_HEADER = "# Files mentioned by the user:";

/** What a mention needs from an attachment (the desktop's `Attachment` and the host's `PickedPath` both fit). */
export interface Mentionable {
  name: string;
  path?: string;
  isDir?: boolean;
  /** An image, which also travels as content. */
  image?: unknown;
  kind?: "image" | "file";
}

/** Empty when nothing has a path. */
export function formatFileMentions(attachments: Mentionable[]): string {
  const lines = attachments.flatMap((a) => {
    if (!a.path) return [];
    if (a.kind === "image" || (a.kind === undefined && a.image)) return [`## ${a.name}: ${a.path} (image attached)`];
    return [`## ${a.name}${a.isDir ? "/" : ""}: ${a.path}${a.isDir && !a.path.endsWith("/") ? "/" : ""}`];
  });
  return lines.length ? `${FILE_MENTIONS_HEADER}\n\n${lines.join("\n")}` : "";
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
export function splitFileMentions(raw: string): [string, FileMention[]] {
  const text = stripResizeNotes(raw);
  const index = text.lastIndexOf(FILE_MENTIONS_HEADER);
  if (index === -1) return [text, []];
  const lines = text.slice(index + FILE_MENTIONS_HEADER.length).split("\n");
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

/** pi's note on a downscaled image ("[Image: original WxH, displayed at WxH. Multiply coordinates by …]"), meant for the model only. */
const RESIZE_NOTE = /\n*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]/g;

export function stripResizeNotes(text: string): string {
  const stripped = text.replace(RESIZE_NOTE, "");
  return stripped === text ? text : stripped.trimEnd();
}

/** Message text without the blocks pi-gna adds (file mentions, browser comments, a Kanban card's details). */
export function stripStudioBlocks(text: string): string {
  return splitFileMentions(text)[0].replace(/\n*<(browser-comments|kanban-card)>[\s\S]*?<\/\1>\n*/g, "\n").trim();
}
