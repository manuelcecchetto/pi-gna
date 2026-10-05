// What the composer's `/` and `@` triggers mean at the caret: a slash command at the start of the text, or a file
// mention after whitespace. Shared by the desktop composer and the phone's.

export interface MenuState {
  kind: "command" | "file";
  query: string;
  /** Index in the text where the trigger (/ or @) starts. */
  start: number;
}

export function detectMenu(text: string, caret: number): MenuState | undefined {
  const before = text.slice(0, caret);
  const command = before.match(/^\/(\S*)$/);
  if (command) return { kind: "command", query: command[1] ?? "", start: 0 };
  const file = before.match(/(^|\s)@([^\s@]*)$/);
  if (file) return { kind: "file", query: file[2] ?? "", start: caret - (file[2]?.length ?? 0) - 1 };
  return undefined;
}

/** The text with the trigger and its query replaced by `insert` (the caret was at `caret`). */
export function applyMenuChoice(text: string, menu: MenuState, insert: string, caret: number): { text: string; caret: number } {
  return { text: text.slice(0, menu.start) + insert + text.slice(caret), caret: menu.start + insert.length };
}
