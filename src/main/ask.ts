// POST /ask on the agent bridge: the ask_user tool (resources/ask-extension.ts). `start` checks the questions and puts
// them on the chat's card; `wait` returns the answers once the user answered, skipped, dismissed the card or the
// countdown took the defaults, or `done: false` after WAIT_MS so no request outlives the HTTP client's timeouts (a
// paused card can wait for hours); `cancel` is the tool call's abort.
import { randomUUID } from "node:crypto";
import { type AskParams, type AskQuestion, type AskRequest, type AskResponse, type AskResult, normalizeAsk, resultText } from "../shared/ask";
import { bridgeError, type Route } from "./bridge";

export type RequestAnswers = (handle: string, questions: AskQuestion[], timeoutMs: number, signal?: AbortSignal) => Promise<AskResult>;

/** How long one wait holds the request. */
const WAIT_MS = 45_000;
/** Answers nobody collected (the tool call went away) are dropped after this long. */
const KEPT_MS = 5 * 60_000;

interface Pending {
  handle: string;
  abort: AbortController;
  result: Promise<AskResult>;
}

export function askRoute(requestAnswers: RequestAnswers, waitMs = WAIT_MS): Route {
  const pending = new Map<string, Pending>();
  const own = (handle: string, id: unknown): [string, Pending] => {
    const entry = typeof id === "string" ? pending.get(id) : undefined;
    if (!entry || entry.handle !== handle) throw bridgeError(404, "no such questions");
    return [id as string, entry];
  };

  return async (handle, body): Promise<AskResponse> => {
    const request = (body ?? {}) as AskRequest;
    switch (request.action) {
      case "start": {
        const asked = normalizeAsk((request.params ?? {}) as AskParams);
        if ("error" in asked) throw bridgeError(400, asked.error);
        const id = randomUUID();
        const abort = new AbortController();
        const result = requestAnswers(handle, asked.questions, asked.timeoutMs, abort.signal);
        pending.set(id, { handle, abort, result });
        void result.then(() => setTimeout(() => pending.delete(id), KEPT_MS).unref?.());
        return { id };
      }
      case "wait": {
        const [id, entry] = own(handle, request.id);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const details = await Promise.race([entry.result, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs)))]);
        clearTimeout(timer);
        if (!details) return { done: false };
        pending.delete(id);
        return { done: true, text: resultText(details), details };
      }
      case "cancel": {
        const [id, entry] = own(handle, request.id);
        entry.abort.abort();
        pending.delete(id);
        return { cancelled: true };
      }
      default:
        throw bridgeError(400, "unknown action");
    }
  };
}
