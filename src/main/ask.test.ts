import { describe, expect, it } from "vitest";
import type { AskResult } from "../shared/ask";
import { askRoute, type RequestAnswers } from "./ask";

describe("askRoute", () => {
  const params = { questions: [{ prompt: "Which fix?", options: ["start", "close"], default: "start" }], timeoutSec: 5 };

  it("puts the questions up, holds each wait briefly, and returns the answers once", async () => {
    let finish!: (result: AskResult) => void;
    const calls: unknown[] = [];
    const request: RequestAnswers = (handle, questions, timeoutMs) => {
      calls.push({ handle, ids: questions.map((q) => q.id), timeoutMs });
      return new Promise((resolve) => (finish = resolve));
    };
    const route = askRoute(request, 5);
    const started = (await route("h1", { action: "start", params })) as { id: string };
    expect(calls).toEqual([{ handle: "h1", ids: ["q1"], timeoutMs: 5000 }]);
    await expect(route("h1", { action: "wait", id: started.id })).resolves.toEqual({ done: false });
    // Another chat's token cannot read or cancel them.
    await expect(route("h2", { action: "wait", id: started.id })).rejects.toMatchObject({ status: 404 });
    const question = { id: "q1", prompt: "Which fix?", options: [{ label: "start" }, { label: "close" }], multi: false, allowOther: true, defaultPicks: [0] };
    finish({ questions: [question], answers: [{ id: "q1", values: ["start"], custom: false, source: "default" }], cancelled: false });
    await expect(route("h1", { action: "wait", id: started.id })).resolves.toEqual({
      done: true,
      text: "Which fix?\n→ start (default)\n\nAnswers marked (default) were not chosen by the user: the countdown ran out, so the defaults were taken.",
      details: expect.objectContaining({ cancelled: false }),
    });
    await expect(route("h1", { action: "wait", id: started.id })).rejects.toMatchObject({ status: 404 });
  });

  it("aborts the card when the tool call is cancelled, and refuses bad questions", async () => {
    let signal: AbortSignal | undefined;
    const route = askRoute((_handle, _questions, _timeout, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { id } = (await route("h1", { action: "start", params })) as { id: string };
    await expect(route("h1", { action: "cancel", id })).resolves.toEqual({ cancelled: true });
    expect(signal?.aborted).toBe(true);
    await expect(route("h1", { action: "start", params: { questions: [] } })).rejects.toMatchObject({ status: 400 });
    await expect(route("h1", { action: "nope" })).rejects.toMatchObject({ status: 400 });
  });
});
