// Runs extractFileUsage for one file at a time on behalf of the index (usage-index.ts); the main thread never parses a session.
import { parentPort } from "node:worker_threads";
import type { FileUsageFacts } from "../shared/usage";
import { type ExtractTarget, extractFileUsage } from "./usage-extract";

export interface ExtractRequest {
  id: number;
  target: ExtractTarget;
  previous?: FileUsageFacts;
}

export type ExtractReply = { id: number; facts?: FileUsageFacts; error?: string };

parentPort?.on("message", async (request: ExtractRequest) => {
  try {
    const reply: ExtractReply = { id: request.id, facts: await extractFileUsage(request.target, request.previous) };
    parentPort?.postMessage(reply);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: (error as Error).message } satisfies ExtractReply);
  }
});
