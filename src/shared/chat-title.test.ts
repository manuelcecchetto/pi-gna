import { describe, expect, it } from "vitest";
import { cleanTitle, TITLE_CHARS, titleInput } from "./chat-title";

describe("titleInput", () => {
  it("leaves out pi-gna's blocks and folds whitespace", () => {
    const message = "<kanban-card>\nCard abc123: Old title\nColumn: To do\n</kanban-card>\n\nFix the   login\nredirect";
    expect(titleInput(message)).toBe("Fix the login redirect");
    expect(titleInput("x".repeat(10_000))).toHaveLength(4000);
    expect(titleInput("<browser-comments>\nnote\n</browser-comments>")).toBe("");
  });
});

describe("cleanTitle", () => {
  it("keeps the first line without quotes, labels or trailing punctuation", () => {
    expect(cleanTitle("Fix login redirect loop")).toBe("Fix login redirect loop");
    expect(cleanTitle('\n"Fix login redirect loop."\nMore text')).toBe("Fix login redirect loop");
    expect(cleanTitle("Title: **Compare Vite and Turbopack**")).toBe("Compare Vite and Turbopack");
    expect(cleanTitle("“Rename the chat”")).toBe("Rename the chat");
    expect(cleanTitle("  \n ")).toBeUndefined();
    expect(cleanTitle('""')).toBeUndefined();
  });

  it("cuts a long answer at a word", () => {
    const long = "Investigate why the remote server drops websocket connections after the laptop sleeps";
    const title = cleanTitle(long)!;
    expect(title.length).toBeLessThanOrEqual(TITLE_CHARS);
    expect(long.startsWith(title)).toBe(true);
    expect(long[title.length]).toBe(" ");
  });
});
