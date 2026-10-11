// Questions the agent asks the user (the ask_user tool, resources/ask-extension.ts): the card that takes the
// composer's place, its defaults and the answer that goes back to the agent. The tool's arguments follow pi's
// questionnaire example (id, prompt, options with label and description, allowOther), plus multi, a default and a
// countdown. Pure, so the extension, main and both clients agree on what an answer means.

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  /** None: the question is only the free-form field. */
  options: AskOption[];
  /** Pick any number of options; otherwise one. */
  multi: boolean;
  /** The free-form "Something else…" field. */
  allowOther: boolean;
  /** The options taken when the countdown ends or the user skips, by index. */
  defaultPicks: number[];
  /** Free text taken instead, when the default is not one of the options. */
  defaultText?: string;
}

/** What a client sends for one question: picked option indexes and/or free text, or a skip. */
export interface AskReply {
  id: string;
  picks?: number[];
  text?: string;
  skipped?: boolean;
}

/** Who chose an answer: the user, the default when the countdown ran out, or the default the user skipped to. */
export type AskSource = "user" | "default" | "skipped";

export interface AskAnswer {
  id: string;
  /** Option labels and/or free text; empty when nothing was answered and there was no default. */
  values: string[];
  /** Whether the last value is free text rather than an option. */
  custom: boolean;
  source: AskSource;
}

/** The tool's result details, shaped like pi's questionnaire example. */
export interface AskResult {
  questions: AskQuestion[];
  answers: AskAnswer[];
  cancelled: boolean;
}

export const ASK_LIMITS = { questions: 10, options: 12, text: 2000 } as const;
/** The countdown when the tool does not set one. */
export const ASK_DEFAULT_TIMEOUT_SEC = 30;
export const ASK_MAX_TIMEOUT_SEC = 3600;
export const NOT_ANSWERED = "(not answered)";

/** What the tool receives, before normalizing. */
export interface AskParams {
  questions: {
    id?: string;
    prompt: string;
    options?: (AskOption | string)[];
    multi?: boolean;
    allowOther?: boolean;
    default?: string | string[];
  }[];
  timeoutSec?: number;
}

/** POST /ask on the agent bridge (src/main/ask.ts). */
export type AskRequest = { action: "start"; params: AskParams } | { action: "wait"; id: string } | { action: "cancel"; id: string };
export type AskResponse = { id: string } | { done: false } | { done: true; text: string; details: AskResult } | { cancelled: true };

/** The questions as the card shows them, or an error the agent reads. */
export function normalizeAsk(params: AskParams): { questions: AskQuestion[]; timeoutMs: number } | { error: string } {
  if (!Array.isArray(params.questions) || params.questions.length === 0) return { error: "Ask at least one question." };
  if (params.questions.length > ASK_LIMITS.questions) return { error: `Ask at most ${ASK_LIMITS.questions} questions at once.` };
  const questions: AskQuestion[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of params.questions.entries()) {
    const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
    if (!prompt) return { error: `Question ${index + 1} has no prompt.` };
    const options = (raw.options ?? [])
      .map((option): AskOption => (typeof option === "string" ? { label: option } : { label: option.label, ...(option.description && { description: option.description }) }))
      .map((option) => ({ ...option, label: typeof option.label === "string" ? option.label.trim() : "" }))
      .filter((option) => option.label);
    if (options.length > ASK_LIMITS.options) return { error: `Question ${index + 1} has more than ${ASK_LIMITS.options} options.` };
    if (new Set(options.map((option) => option.label)).size !== options.length) return { error: `Question ${index + 1} repeats an option.` };
    const allowOther = options.length === 0 || raw.allowOther !== false;
    const multi = raw.multi === true && options.length > 1;
    let id = (typeof raw.id === "string" && raw.id.trim()) || `q${index + 1}`;
    while (ids.has(id)) id = `${id}_`;
    ids.add(id);

    const defaults = (Array.isArray(raw.default) ? raw.default : raw.default === undefined ? [] : [raw.default]).filter((value): value is string => typeof value === "string" && value.trim() !== "");
    const defaultPicks: number[] = [];
    let defaultText: string | undefined;
    for (const value of defaults) {
      const pick = options.findIndex((option) => option.label === value.trim());
      if (pick >= 0) {
        if (!defaultPicks.includes(pick)) defaultPicks.push(pick);
      } else if (allowOther && defaultText === undefined) defaultText = value.trim().slice(0, ASK_LIMITS.text);
      else return { error: `Question ${index + 1}: the default "${value}" is not one of its options.` };
    }
    if (!multi && defaultPicks.length + (defaultText === undefined ? 0 : 1) > 1) return { error: `Question ${index + 1} takes one answer, but has several defaults.` };
    questions.push({ id, prompt, options, multi, allowOther, defaultPicks: defaultPicks.sort((a, b) => a - b), ...(defaultText !== undefined && { defaultText }) });
  }
  const seconds = typeof params.timeoutSec === "number" && Number.isFinite(params.timeoutSec) ? params.timeoutSec : ASK_DEFAULT_TIMEOUT_SEC;
  return { questions, timeoutMs: Math.round(Math.min(Math.max(seconds, 0), ASK_MAX_TIMEOUT_SEC) * 1000) };
}

function defaultAnswer(question: AskQuestion, source: AskSource): AskAnswer {
  const values = question.defaultPicks.map((pick) => question.options[pick]?.label ?? "");
  if (question.defaultText !== undefined) values.push(question.defaultText);
  return { id: question.id, values, custom: question.defaultText !== undefined, source };
}

/** Every question's default: what the countdown sends. */
export function defaultAnswers(questions: AskQuestion[]): AskAnswer[] {
  return questions.map((question) => defaultAnswer(question, "default"));
}

/**
 * The user's replies checked against the questions: picks out of range, a second pick on a single-choice question or
 * text where free form is off fail. A question without a reply takes its default.
 */
export function answersFrom(questions: AskQuestion[], replies: unknown): AskAnswer[] | { error: string } {
  if (!Array.isArray(replies)) return { error: "replies must be a list" };
  const byId = new Map<string, AskReply>();
  for (const reply of replies as AskReply[]) if (reply && typeof reply.id === "string") byId.set(reply.id, reply);
  const answers: AskAnswer[] = [];
  for (const question of questions) {
    const reply = byId.get(question.id);
    if (!reply) {
      answers.push(defaultAnswer(question, "default"));
      continue;
    }
    if (reply.skipped) {
      answers.push(defaultAnswer(question, "skipped"));
      continue;
    }
    const picks = Array.isArray(reply.picks) ? [...new Set(reply.picks)] : [];
    if (picks.some((pick) => !Number.isInteger(pick) || pick < 0 || pick >= question.options.length)) return { error: `no such option in ${question.id}` };
    const text = typeof reply.text === "string" ? reply.text.trim().slice(0, ASK_LIMITS.text) : "";
    if (text && !question.allowOther) return { error: `${question.id} takes no free text` };
    if (!question.multi && picks.length + (text ? 1 : 0) > 1) return { error: `${question.id} takes one answer` };
    const values = picks.sort((a, b) => a - b).map((pick) => question.options[pick]?.label ?? "");
    if (text) values.push(text);
    answers.push(values.length ? { id: question.id, values, custom: Boolean(text), source: "user" } : defaultAnswer(question, "skipped"));
  }
  return answers;
}

/** How one answer reads: its values, with where it came from when the user did not choose it. */
export function answerText(answer: AskAnswer): string {
  const value = answer.values.length ? answer.values.join(", ") : NOT_ANSWERED;
  if (answer.source === "user" || !answer.values.length) return value;
  return `${value} (${answer.source === "skipped" ? "skipped" : "default"})`;
}

/** The transcript's one line: "Answered: a, b (default), (not answered)". */
export function answeredLine(result: AskResult): string {
  if (result.cancelled) return "Declined to answer";
  return `Answered: ${result.answers.map(answerText).join(" · ")}`;
}

/** What the agent reads. */
export function resultText(result: AskResult): string {
  if (result.cancelled) return "The user dismissed the questions without answering. Do not assume an answer; continue with what you know or ask again later.";
  const lines = result.questions.map((question, index) => {
    const answer = result.answers[index];
    return `${question.prompt}\n→ ${answer ? answerText(answer) : NOT_ANSWERED}`;
  });
  const timedOut = result.answers.some((answer) => answer.source === "default");
  if (timedOut) lines.push("Answers marked (default) were not chosen by the user: the countdown ran out, so the defaults were taken.");
  return lines.join("\n\n");
}

/** How far the countdown is, 0 to 1, for the Send button and the sidebar row. */
export function countdownProgress(dialog: { timeout?: number; deadline?: number; left?: number }, now: number): number | undefined {
  if (!dialog.timeout) return undefined;
  const left = dialog.deadline !== undefined ? dialog.deadline - now : (dialog.left ?? dialog.timeout);
  return Math.min(1, Math.max(0, 1 - left / dialog.timeout));
}
