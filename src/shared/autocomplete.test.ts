import { describe, expect, it } from "vitest";
import { buildPrompt, cleanSuggestion, confidentText, isTypedPrompt, lastExchange, pickExamples, remainingGhost, wantsSuggestion } from "./autocomplete";
import type { Item } from "./session-state";

describe("buildPrompt", () => {
  it("lays out the scene, earlier messages, the last exchange and the draft", () => {
    const prompt = buildPrompt({ draft: "now fix the  scroll\nwhen", lastUser: "check the composer", lastAgent: "Done.\nThe composer\tscrolls." }, ["the scroll jumps when a task opens"]);
    expect(prompt).toBe(
      [
        "A software developer is chatting with an AI coding agent about their project.",
        "Earlier messages from the user:",
        "- the scroll jumps when a task opens",
        "***Roleplay chat below***",
        "User: check the composer",
        "Agent: Done. The composer scrolls.",
        "User: now fix the scroll when",
      ].join("\n"),
    );
  });

  it("leaves out what a new chat does not have", () => {
    expect(buildPrompt({ draft: "hello there" }, [])).toBe("A software developer is chatting with an AI coding agent about their project.\n***Roleplay chat below***\nUser: hello there");
  });

  it("keeps the end of a long reply and the start of a long earlier message", () => {
    const prompt = buildPrompt({ draft: "ok", lastAgent: `${"a".repeat(1000)}END` }, [`START${"b".repeat(1000)}`]);
    expect(prompt).toContain(`Agent: ${"a".repeat(597)}END`);
    expect(prompt).toContain(`- START${"b".repeat(245)}\n`);
  });
});

describe("cleanSuggestion", () => {
  it("starts with a space after a whole word, and without one after a trailing space", () => {
    expect(cleanSuggestion(" the composer scroll\nUser: more", "fix")).toBe(" the composer scroll");
    expect(cleanSuggestion(" the composer scroll", "fix ")).toBe("the composer scroll");
  });

  it("drops a continuation of the word being typed, and empty lines", () => {
    expect(cleanSuggestion("ing the bug", "fix")).toBe("");
    expect(cleanSuggestion("\nUser: hi", "fix")).toBe("");
    expect(cleanSuggestion("   ", "fix")).toBe("");
  });

  it("keeps punctuation that ends the word", () => {
    expect(cleanSuggestion(", then push", "fix it")).toBe(", then push");
  });

  it("keeps at most 6 words", () => {
    expect(cleanSuggestion(` ${"w ".repeat(20)}`, "go ").split(" ")).toHaveLength(6);
  });

  it("ends with the first sentence", () => {
    expect(cleanSuggestion(" fix it? I want to see the code.", "can you")).toBe(" fix it?");
    expect(cleanSuggestion(" v1.2 build. Then more", "ship the")).toBe(" v1.2 build.");
  });

  it("drops a suggestion that repeats three words of the draft", () => {
    expect(cleanSuggestion(" using react-native too", "I'm using react-native. I'm")).toBe("");
    expect(cleanSuggestion(" commit and push", "commit and push, then")).toBe("");
    expect(cleanSuggestion(" and push", "commit")).toBe(" and push");
  });
});

describe("confidentText", () => {
  const tokens = (...pairs: [string, number][]) => pairs.map(([text, prob]) => ({ text, prob }));

  it("keeps whole words while each is likely enough", () => {
    expect(confidentText(tokens([" the", 0.9], [" compos", 0.8], ["er", 0.9], [" scroll", 0.2], [" bar", 0.9]))).toBe(" the composer");
  });

  it("weighs a word by all its tokens", () => {
    expect(confidentText(tokens([" the", 0.9], [" compos", 0.5], ["er", 0.5]))).toBe(" the");
  });

  it("is empty when the first word is a guess, and ends at a newline", () => {
    expect(confidentText(tokens([" maybe", 0.1], [" this", 0.99]))).toBe("");
    expect(confidentText(tokens([" fix", 0.9], [" it?\n", 0.9], ["User", 0.9]))).toBe(" fix it?");
    expect(confidentText([])).toBe("");
  });
});

describe("pickExamples", () => {
  const prompts = ["release the new build to main", "the composer scroll jumps when streaming", "unrelated thing about billing pages", "composer scroll"];

  it("ranks by shared words, favouring short matches, and skips messages sharing none", () => {
    expect(pickExamples("why does composer scroll", prompts)).toEqual(["composer scroll", "the composer scroll jumps when streaming"]);
  });

  it("returns nothing for a draft without words", () => {
    expect(pickExamples("ok", prompts)).toEqual([]);
  });
});

describe("isTypedPrompt", () => {
  it("keeps messages a person typed", () => {
    expect(isTypedPrompt("opening an ongoing task scrolls at the end, we should stay")).toBe(true);
  });

  it("drops task prompts, pastes, code and short replies", () => {
    expect(isTypedPrompt("Resolve this card from the project's Kanban board and more words")).toBe(false);
    expect(isTypedPrompt("# Context from my IDE setup: lots of words here")).toBe(false);
    expect(isTypedPrompt("look at this ```ts const a = 1``` and fix it now")).toBe(false);
    expect(isTypedPrompt("go ahead")).toBe(false);
    expect(isTypedPrompt("x".repeat(901))).toBe(false);
    expect(isTypedPrompt("/var/folders/gv/abc/def/ghi.png /tmp/a/b/c.txt 1 2 3 4")).toBe(false);
  });
});

describe("wantsSuggestion", () => {
  it("asks for words being written", () => {
    expect(wantsSuggestion("fix the")).toBe(true);
  });

  it("skips empty drafts, slash commands and a fresh line", () => {
    expect(wantsSuggestion("  ")).toBe(false);
    expect(wantsSuggestion("/compact now")).toBe(false);
    expect(wantsSuggestion("first line\n")).toBe(false);
    expect(wantsSuggestion("can you fix it? ")).toBe(false);
    expect(wantsSuggestion("done.")).toBe(false);
  });
});

describe("remainingGhost", () => {
  it("eats the ghost as its characters are typed", () => {
    expect(remainingGhost("fix", " the scroll", "fix th")).toBe("e scroll");
  });

  it("drops it when the typing differs, the text shrinks, or the ghost is used up", () => {
    expect(remainingGhost("fix", " the scroll", "fix a")).toBeUndefined();
    expect(remainingGhost("fix", " the scroll", "fi")).toBeUndefined();
    expect(remainingGhost("fix", " the", "fix the")).toBeUndefined();
  });
});

describe("lastExchange", () => {
  const user = (content: unknown): Item => ({ kind: "user", key: "u", message: { role: "user", content, timestamp: 1 } }) as Item;
  const answer = (content: unknown[]): Item => ({ kind: "assistant", key: "a", streaming: false, message: { role: "assistant", content, timestamp: 2 } }) as unknown as Item;

  it("takes the last user message and the agent's last text, skipping tool-only turns", () => {
    const items = [user("old"), answer([{ type: "text", text: "old reply" }]), user([{ type: "text", text: "fix the scroll" }]), answer([{ type: "text", text: "Fixed." }]), answer([{ type: "toolCall" }])];
    expect(lastExchange(items)).toEqual({ lastUser: "fix the scroll", lastAgent: "Fixed." });
  });

  it("is empty for a new chat", () => {
    expect(lastExchange([])).toEqual({});
  });
});
