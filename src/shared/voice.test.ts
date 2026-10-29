import { describe, expect, it } from "vitest";
import { addFragment, clipCommentary, COMMENTARY_CHARS, delegationPrompt, KEY_COMMAND, type TranscriptLine } from "./voice";

describe("addFragment", () => {
  it("grows the speaker's line with fragments as received and starts a line for the other speaker", () => {
    let lines: TranscriptLine[] = [];
    lines = addFragment(lines, "user", " Tell the release", 1200);
    lines = addFragment(lines, "user", " chat to push", 1800);
    lines = addFragment(lines, "assistant", " Sure,", 1900);
    lines = addFragment(lines, "user", " but run the tests first", 2600);
    expect(lines).toEqual([
      { speaker: "user", text: " Tell the release chat to push", end: 1800 },
      { speaker: "assistant", text: " Sure,", end: 1900 },
      { speaker: "user", text: " but run the tests first", end: 2600 },
    ]);
  });
});

describe("delegationPrompt", () => {
  const lines: TranscriptLine[] = [
    { speaker: "user", text: " Ciao.", end: 1000 },
    { speaker: "assistant", text: " Ciao, come va?", end: 2000 },
    { speaker: "user", text: " Tell the release chat to push,", end: 4000 },
    { speaker: "assistant", text: " Okay,", end: 4300 },
    { speaker: "user", text: " but run the tests first.", end: 5200 },
  ];

  it("gives the call so far and what the user said since the last hand-off", () => {
    expect(delegationPrompt(lines, 2000)).toBe(
      "The call so far (a speech transcript, a word may be misheard):\nUser: Ciao.\nVoice assistant: Ciao, come va?\nUser: Tell the release chat to push,\nVoice assistant: Okay,\nUser: but run the tests first.\n\nThe voice assistant handed this to you. What the user said since the last hand-off: Tell the release chat to push, but run the tests first.",
    );
  });

  it("says when nothing new was said", () => {
    expect(delegationPrompt(lines, 6000)).toMatch(/since the last hand-off: \(nothing new; answer from the call so far\)$/);
    expect(delegationPrompt([], -1)).toMatch(/^The call so far[^\n]*\n\(nothing yet\)/);
  });

  it("keeps only the newest lines of a long call", () => {
    const long = Array.from({ length: 40 }, (_, index): TranscriptLine => ({ speaker: index % 2 ? "assistant" : "user", text: ` line ${index}`, end: index }));
    const prompt = delegationPrompt(long, 38);
    expect(prompt).toContain("line 39");
    expect(prompt).not.toContain("line 20\n");
    expect(prompt.split("\n").filter((line) => /^(User|Voice assistant):/.test(line))).toHaveLength(12);
  });
});

describe("clipCommentary", () => {
  it("flattens whitespace and stays under GPT-Live's append limit", () => {
    expect(clipCommentary("Sent.\n\n  The chat will   run the tests.")).toBe("Sent. The chat will run the tests.");
    expect(clipCommentary("word ".repeat(1000)).length).toBe(COMMENTARY_CHARS);
  });
});

describe("KEY_COMMAND", () => {
  it("reads the key hidden and passes it on stdin, not as an argument the 128-character prompt would cut", () => {
    expect(KEY_COMMAND).toMatch(/^read -rs /);
    expect(KEY_COMMAND).toContain("| /usr/bin/security -i");
    expect(KEY_COMMAND).toContain("-s pi-gna.openai-api-key");
    expect(KEY_COMMAND).toMatch(/unset K$/);
  });
});
