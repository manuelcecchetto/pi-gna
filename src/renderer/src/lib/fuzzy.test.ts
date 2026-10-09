import { describe, expect, it, vi } from "vitest";
import { fuzzyFilter, fuzzyScore, fuzzySearch, topK } from "./fuzzy";

/** What fuzzyFilter returned before it was fast: every match scored, stably sorted, cut to the limit. */
const reference = <T,>(items: T[], query: string, key: (item: T) => string, limit = 50): T[] =>
  items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);

/** A seeded random number generator (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Few letters, so queries match often, partly and in many ways; separators, capitals and characters that are two
// UTF-16 units (an emoji, either half of one) or lowercase to two (İ).
const ALPHABET = ["a", "b", "c", "d", "A", "B", "/", "-", "_", ".", " ", "😀", "\ud83d", "\ude00", "İ"];
const word = (next: () => number, max: number): string => {
  let text = "";
  const length = 1 + Math.floor(next() * max);
  for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return text;
};

const PATHS = [
  "src/renderer/src/components/Composer.tsx",
  "src/renderer/src/lib/fuzzy.ts",
  "src/main/files.ts",
  "docs/DESIGN.md",
  "README.md",
  "src/renderer/src/components/CommandPalette.tsx",
  "scripts/build.mjs",
  "src/compose/index.ts",
];

describe("fuzzySearch", () => {
  it("ranks a project's files as fuzzyFilter always did", () => {
    const search = fuzzySearch(PATHS, (path) => path);
    for (const query of ["c", "co", "com", "comp", "compo", "compos", "composer", "md", "src/", "files", "Fuzzy", "xyz"]) {
      expect(search(query, 5)).toEqual(reference(PATHS, query, (path) => path, 5));
    }
    expect(search("comp", 3)).toEqual(["src/renderer/src/components/Composer.tsx", "src/compose/index.ts", "src/renderer/src/components/CommandPalette.tsx"]);
  });

  it("ranks like scoring every item, whatever was typed before", () => {
    const next = random(41);
    for (let round = 0; round < 40; round++) {
      const items = Array.from({ length: 120 }, () => word(next, 12));
      const search = fuzzySearch(items, (item) => item);
      const limit = 1 + Math.floor(next() * 20);
      // Type a query a character at a time, delete part of it, type on, and start over now and then.
      let query = "";
      for (let step = 0; step < 60; step++) {
        const roll = next();
        if (roll < 0.6) query += ALPHABET[Math.floor(next() * ALPHABET.length)];
        else if (roll < 0.85) query = query.slice(0, Math.max(0, query.length - 1 - Math.floor(next() * 3)));
        else if (roll < 0.95) query = word(next, 3);
        else query = "";
        expect(search(query, limit), JSON.stringify({ round, query, limit })).toEqual(reference(items, query, (item) => item, limit));
      }
    }
  });

  it("gives the same answer when asked again, for any limit", () => {
    const search = fuzzySearch(PATHS, (path) => path);
    search("src", 3).push("changed by the caller");
    search("src", 3).push("changed by the caller");
    expect(search("src", 3)).toEqual(reference(PATHS, "src", (path) => path, 3));
    expect(search("src", 6)).toEqual(reference(PATHS, "src", (path) => path, 6));
    expect(search("src", 2)).toEqual(reference(PATHS, "src", (path) => path, 2));
  });

  it("reads each item's key once", () => {
    const key = vi.fn((path: string) => path);
    const search = fuzzySearch(PATHS, key);
    for (const query of ["s", "sr", "src", "s", "", "md"]) search(query, 4);
    expect(key).toHaveBeenCalledTimes(PATHS.length);
  });

  it("shows the list as it is before you type", () => {
    expect(fuzzySearch(PATHS, (path) => path)("", 3)).toEqual(PATHS.slice(0, 3));
  });
});

describe("fuzzyFilter", () => {
  it("ranks like scoring every item, for any limit", () => {
    const next = random(7);
    const items = Array.from({ length: 600 }, () => word(next, 10));
    for (const limit of [0, 1, 8, 50, 256, 257, 600]) {
      for (let i = 0; i < 12; i++) {
        const query = word(next, 3);
        expect(fuzzyFilter(items, query, (item) => item, limit), JSON.stringify({ query, limit })).toEqual(reference(items, query, (item) => item, limit));
      }
    }
  });

  it("matches by the key it is given", () => {
    const models = [{ id: "claude-opus" }, { id: "gpt-5" }, { id: "claude-sonnet" }];
    expect(fuzzyFilter(models, "claude", (model) => model.id, 1)).toEqual([{ id: "claude-opus" }]);
  });
});

describe("topK", () => {
  it("keeps the best, best first, and equal scores in their order", () => {
    const entries = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5].map((score, at) => ({ score, at }));
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    for (const limit of [0, 1, 4, 5, 11, 20]) expect(topK(entries, limit)).toEqual(sorted.slice(0, limit));
    expect(topK(entries, 3).map((entry) => entry.at)).toEqual([5, 7, 4]);
  });

  it("sorts once when the limit is long", () => {
    const next = random(3);
    const entries = Array.from({ length: 2_000 }, (_, at) => ({ score: Math.floor(next() * 50), at }));
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    for (const limit of [256, 257, 1_000, 2_000]) expect(topK(entries, limit)).toEqual(sorted.slice(0, limit));
  });
});
