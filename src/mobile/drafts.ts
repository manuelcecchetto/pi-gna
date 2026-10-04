// Composer drafts, kept on the phone per chat (they are not synced: docs/REMOTE.md section 3).
const PREFIX = "pigna:draft:";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storage = (): Store | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined; // storage blocked
  }
};

/** A chat is its session file once it has one; a chat that is only a handle has no draft that outlives it. */
export const draftKey = (chat: { sessionPath?: string; handle: string }): string => PREFIX + (chat.sessionPath ?? chat.handle);

export function loadDraft(key: string, store: Store | undefined = storage()): string {
  try {
    return store?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(key: string, text: string, store: Store | undefined = storage()): void {
  try {
    if (text) store?.setItem(key, text);
    else store?.removeItem(key);
  } catch {
    // full or blocked: the draft lives only in the field
  }
}

/** Stop gave the queued messages back: they go in front of what is already typed. */
export function withRestored(draft: string, restored: string[]): string {
  const back = restored.map((text) => text.trim()).filter(Boolean).join("\n\n");
  if (!back) return draft;
  return draft.trim() ? `${back}\n\n${draft}` : back;
}
