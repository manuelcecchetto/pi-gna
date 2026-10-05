// Pure helpers of the viewer: byte formatting, text sniffing, line escaping, `#L12` parsing.

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Text when the first bytes hold no NUL and decode as UTF-8 (a cut multi-byte tail at the end is tolerated). */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Line to jump to from `#L12`, `#12` or `#L12-20` (the first number wins). */
export function lineFromHash(hash: string): number | undefined {
  const match = /^#L?(\d+)/.exec(hash);
  const line = match ? Number(match[1]) : undefined;
  return line && line > 0 ? line : undefined;
}

/** Lines of a text, without the empty one a trailing newline leaves. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}
