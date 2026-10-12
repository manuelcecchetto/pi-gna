import { describe, expect, it } from "vitest";
import { cleanTitle, firstWords, TITLE_CHARS, titleInput } from "./chat-title";

describe("titleInput", () => {
  it("leaves out pi-gna's blocks and folds whitespace", () => {
    const message = "<kanban-card>\nCard abc123: Old title\nColumn: To do\n</kanban-card>\n\nFix the   login\nredirect";
    expect(titleInput(message)).toBe("Fix the login redirect");
    expect(titleInput("x".repeat(10_000))).toHaveLength(4000);
    expect(titleInput("<browser-comments>\nnote\n</browser-comments>")).toBe("");
  });
});

describe("firstWords", () => {
  const photo = "# Files mentioned by the user:\n\n## IMG_1.png: /uploads/IMG_1.png (image attached)";
  // pi stores an image's text with its resize note after the mention.
  const stored = `${photo}\n\n[Image: original 1206x2622, displayed at 920x2000. Multiply coordinates by 1.31 to map to original image.]`;

  it("titles a new chat from its first message, before or after pi records it", () => {
    expect(firstWords([], "Fix the login")).toBe(true);
    expect(firstWords(["Fix the login"], "Fix the login")).toBe(true);
    expect(firstWords([stored.replace(photo, `Fix the login\n\n${photo}`)], `Fix the login\n\n${photo}`)).toBe(true);
  });

  it("waits past a first message of images alone", () => {
    expect(firstWords([], photo)).toBe(false);
    expect(firstWords([stored], "Why is this broken")).toBe(true);
    expect(firstWords([stored, "Why is this broken"], "Why is this broken")).toBe(true);
  });

  it("leaves a chat that had words before", () => {
    expect(firstWords(["Fix the login"], "Now the logout")).toBe(false);
    expect(firstWords(["Fix the login", "Now the logout"], "Now the logout")).toBe(false);
    expect(firstWords(["Same", "Same"], "Same")).toBe(false);
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
