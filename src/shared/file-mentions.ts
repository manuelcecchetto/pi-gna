// The "# Files mentioned by the user:" block (Codex style): files and folders go as paths that pi reads with its own
// tools, images also travel as image content. Shared by the desktop composer and the host, which composes a phone's send.
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
