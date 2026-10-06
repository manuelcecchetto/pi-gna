import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, "../../resources", name), "utf8");

describe("visual kit vocabulary", () => {
  it("defines every class the prompt lists", () => {
    const prompt = read("pigna-visual-prompt.md");
    const line = prompt.split("\n").find((l) => l.startsWith("- Classes:")) ?? "";
    const listed = [...line.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1] ?? "");
    const modifiers = new Set(["ok", "bad", "warn", "accent"]);
    expect(listed.length).toBeGreaterThan(10);
    const css = read("visual/kit.css");
    for (const name of listed.filter((n) => !modifiers.has(n))) expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    for (const name of modifiers) expect(css, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
  });

  it("defines every token and helper the prompt names, tokens for both themes", () => {
    const prompt = read("pigna-visual-prompt.md");
    const css = read("visual/kit.css");
    const [dark = "", light = ""] = css.split("@media (prefers-color-scheme: light)");
    const tokens = new Set([...prompt.matchAll(/--([a-z][\w-]*)/g)].map((m) => m[1]));
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) tokens.add(`c${n}`);
    for (const n of [0, 1, 2, 3, 4]) tokens.add(`heat-${n}`);
    tokens.delete("v"); // per-element inputs, not theme tokens
    tokens.delete("c");
    for (const name of tokens) expect(dark, name).toContain(`--${name}:`);
    for (const name of ["c1", "c8", "heat-0", "heat-4", "fg", "accent"]) expect(light, name).toContain(`--${name}:`);
    const js = read("visual/kit.js");
    for (const [, helper] of prompt.matchAll(/kit\.(\w+)\(/g)) expect(js, helper).toMatch(new RegExp(`\\b${helper}: function`));
  });
});

describe("visual extension", () => {
  it("adds the visual prompt to the project context once per run", async () => {
    // A computed path keeps tsc out of it: like the other extensions, it types against pi's SDK, which is not a dependency.
    const { default: extension } = await import(/* @vite-ignore */ join(__dirname, "../../resources/visual-extension.ts"));
    let handler: ((event: unknown) => void) | undefined;
    extension({ on: (name: string, fn: (event: unknown) => void) => name === "before_agent_start" && (handler = fn) } as never);
    const contextFiles = [{ path: "/repo/AGENTS.md", content: "project rules" }];
    const event = { systemPromptOptions: { contextFiles } };
    handler?.(event);
    handler?.(event);
    expect(contextFiles).toHaveLength(2);
    expect(contextFiles[0]?.path).toBe("/repo/AGENTS.md");
    expect(contextFiles[1]?.path).toMatch(/resources\/pigna-visual-prompt\.md$/);
    expect(contextFiles[1]?.content).toBe(read("pigna-visual-prompt.md"));
  });
});
