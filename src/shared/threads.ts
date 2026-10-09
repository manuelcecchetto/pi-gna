// The threads tools (resources/threads-extension.ts): an agent lists the other chats (threads) of its project, or of
// every project, and reads one's recent turns. POST /threads on the agent bridge; the calling chat is known from its
// token. Read-only: a thread is read from its session file, never sent to.

export type ThreadsRequest =
  | { action: "list"; all?: boolean; query?: string; limit?: number }
  | { action: "read"; thread: string; turns?: number; before?: number };

export interface ThreadsResponse {
  text: string;
}

export const THREAD_LIMITS = {
  /** Threads a list shows by default, and at most. */
  list: 20,
  listMax: 100,
  /** Turns a read shows by default, and at most. */
  turns: 3,
  turnsMax: 20,
  /** Characters of one read, about 10k tokens: older turns of the page are dropped past it. */
  readChars: 40_000,
} as const;
