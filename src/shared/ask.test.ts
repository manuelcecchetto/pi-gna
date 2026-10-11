import { describe, expect, it } from "vitest";
import { answeredLine, answersFrom, type AskQuestion, countdownProgress, defaultAnswers, normalizeAsk, NOT_ANSWERED, resultText } from "./ask";

const ok = (params: Parameters<typeof normalizeAsk>[0]) => {
  const asked = normalizeAsk(params);
  if ("error" in asked) throw new Error(asked.error);
  return asked;
};

describe("normalizeAsk", () => {
  it("reads single, multiple and free-form questions with their defaults", () => {
    const { questions, timeoutMs } = ok({
      questions: [
        { prompt: "Which fix?", options: [{ label: "Prune on start" }, { label: "Prune on close", description: "when a card closes" }], default: "Prune on start" },
        { id: "tests", prompt: "Which tests?", options: ["Unit", "E2E", "Full"], multi: true, default: ["E2E", "Unit"] },
        { prompt: "Anything else?" },
        { prompt: "Name it", default: "ask_user" },
      ],
    });
    expect(timeoutMs).toBe(30_000);
    expect(questions).toEqual([
      { id: "q1", prompt: "Which fix?", options: [{ label: "Prune on start" }, { label: "Prune on close", description: "when a card closes" }], multi: false, allowOther: true, defaultPicks: [0] },
      { id: "tests", prompt: "Which tests?", options: [{ label: "Unit" }, { label: "E2E" }, { label: "Full" }], multi: true, allowOther: true, defaultPicks: [0, 1] },
      // Free form only: no options, so free text is always on, and no default.
      { id: "q3", prompt: "Anything else?", options: [], multi: false, allowOther: true, defaultPicks: [] },
      { id: "q4", prompt: "Name it", options: [], multi: false, allowOther: true, defaultPicks: [], defaultText: "ask_user" },
    ]);
  });

  it("takes a free-text default only where free form is on", () => {
    expect(ok({ questions: [{ prompt: "Which?", options: ["a", "b"], default: "c" }] }).questions[0]).toMatchObject({ defaultPicks: [], defaultText: "c" });
    expect(normalizeAsk({ questions: [{ prompt: "Which?", options: ["a", "b"], allowOther: false, default: "c" }] })).toEqual({ error: 'Question 1: the default "c" is not one of its options.' });
  });

  it("refuses what the card cannot show", () => {
    expect(normalizeAsk({ questions: [] })).toHaveProperty("error");
    expect(normalizeAsk({ questions: [{ prompt: " " }] })).toHaveProperty("error");
    expect(normalizeAsk({ questions: [{ prompt: "?", options: ["a", "a"] }] })).toHaveProperty("error");
    expect(normalizeAsk({ questions: [{ prompt: "?", options: ["a", "b"], default: ["a", "b"] }] })).toEqual({ error: "Question 1 takes one answer, but has several defaults." });
  });

  it("keeps ids unique and clamps the countdown", () => {
    expect(ok({ questions: [{ id: "x", prompt: "1" }, { id: "x", prompt: "2" }] }).questions.map((q) => q.id)).toEqual(["x", "x_"]);
    expect(ok({ questions: [{ prompt: "?" }], timeoutSec: 0 }).timeoutMs).toBe(0);
    expect(ok({ questions: [{ prompt: "?" }], timeoutSec: 99_999 }).timeoutMs).toBe(3_600_000);
    expect(ok({ questions: [{ prompt: "?" }], timeoutSec: -5 }).timeoutMs).toBe(0);
  });
});

describe("answers", () => {
  const questions: AskQuestion[] = ok({
    questions: [
      { id: "fix", prompt: "Which fix?", options: ["start", "close"], default: "start" },
      { id: "tests", prompt: "Which tests?", options: ["unit", "e2e"], multi: true, default: ["unit"] },
      { id: "note", prompt: "Anything else?" },
    ],
  }).questions;

  it("takes every default when the countdown runs out, and (not answered) where there is none", () => {
    const answers = defaultAnswers(questions);
    expect(answers).toEqual([
      { id: "fix", values: ["start"], custom: false, source: "default" },
      { id: "tests", values: ["unit"], custom: false, source: "default" },
      { id: "note", values: [], custom: false, source: "default" },
    ]);
    expect(answeredLine({ questions, answers, cancelled: false })).toBe(`Answered: start (default) · unit (default) · ${NOT_ANSWERED}`);
    expect(resultText({ questions, answers, cancelled: false })).toContain("the countdown ran out");
  });

  it("checks the user's replies: picks, free text, skips", () => {
    const answers = answersFrom(questions, [
      { id: "fix", text: "both" },
      { id: "tests", picks: [1, 0], text: "lint" },
      { id: "note", skipped: true },
    ]);
    expect(answers).toEqual([
      { id: "fix", values: ["both"], custom: true, source: "user" },
      { id: "tests", values: ["unit", "e2e", "lint"], custom: true, source: "user" },
      { id: "note", values: [], custom: false, source: "skipped" },
    ]);
    expect(answeredLine({ questions, answers: answers as never, cancelled: false })).toBe(`Answered: both · unit, e2e, lint · ${NOT_ANSWERED}`);
  });

  it("refuses replies the questions do not allow", () => {
    expect(answersFrom(questions, [{ id: "fix", picks: [0, 1] }])).toEqual({ error: "fix takes one answer" });
    expect(answersFrom(questions, [{ id: "fix", picks: [5] }])).toEqual({ error: "no such option in fix" });
    expect(answersFrom(questions, "nope")).toHaveProperty("error");
    const closed = ok({ questions: [{ prompt: "?", options: ["a"], allowOther: false }] }).questions;
    expect(answersFrom(closed, [{ id: "q1", text: "b" }])).toEqual({ error: "q1 takes no free text" });
  });

  it("says when the user declined", () => {
    expect(answeredLine({ questions, answers: [], cancelled: true })).toBe("Declined to answer");
    expect(resultText({ questions, answers: [], cancelled: true })).toMatch(/dismissed/);
  });
});

describe("countdownProgress", () => {
  it("runs from the deadline, stands where it was paused, and is absent without a countdown", () => {
    expect(countdownProgress({ timeout: 10_000, deadline: 7_500 }, 0)).toBe(0.25);
    expect(countdownProgress({ timeout: 10_000, deadline: 7_500 }, 9_000)).toBe(1);
    expect(countdownProgress({ timeout: 10_000, left: 4_000 }, 123)).toBe(0.6);
    expect(countdownProgress({}, 0)).toBeUndefined();
  });
});
