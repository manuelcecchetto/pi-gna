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
});
