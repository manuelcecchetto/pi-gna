import { describe, expect, it } from "vitest";
import { appendPartialJson, completePartialJson, EMPTY_PARTIAL_JSON, parsePartialJson } from "./partial-json";

/** Feeds `text` in chunks of `size`, completing after each one. */
function stream(text: string, size: number): (Record<string, unknown> | undefined)[] {
  const seen: (Record<string, unknown> | undefined)[] = [];
  let state = EMPTY_PARTIAL_JSON;
  for (let i = 0; i < text.length; i += size) {
    state = appendPartialJson(state, text.slice(i, i + size));
    seen.push(completePartialJson(state));
  }
  return seen;
}

describe("incremental partial JSON", () => {
  const args = {
    path: "/repo/src/a \"quoted\" \\ back.ts",
    content: 'line 1\n\ttab "q" \\ é ✓ 😀 \u0001 end',
    edits: [{ oldText: "a", newText: "b" }, { oldText: "[{,:}]", newText: "" }],
    n: 12.5,
    ok: true,
  };
  const text = JSON.stringify(args, null, 1).replace(/é/g, "\\u00e9").replace(/😀/g, "\\ud83d\\ude00");

  it("matches a whole-text parse at every prefix, whatever the chunk boundaries", () => {
    for (const size of [1, 2, 3, 5, 7, 40]) {
      let state = EMPTY_PARTIAL_JSON;
      for (let i = 0; i < text.length; i += size) {
        state = appendPartialJson(state, text.slice(i, i + size));
        expect(completePartialJson(state)).toEqual(parsePartialJson(text.slice(0, i + size)));
      }
      expect(completePartialJson(state)).toEqual(args);
    }
  });

  it("never fails inside an escape or a \\u sequence", () => {
    // Every prefix once the first value has started yields an object: a cut inside an escape drops it.
    const seen = stream(text, 1).slice(text.indexOf(': "') + 2);
    expect(seen.every((value) => value !== undefined)).toBe(true);
    const prefixes = ['{"c": "a\\', '{"c": "a\\u', '{"c": "a\\u0', '{"c": "a\\u00', '{"c": "a\\u00e'];
    for (const prefix of prefixes) expect(parsePartialJson(prefix)).toEqual({ c: "a" });
    expect(parsePartialJson('{"c": "a\\u00e9')).toEqual({ c: "aé" });
    expect(parsePartialJson('{"c": "a\\\\')).toEqual({ c: "a\\" });
    expect(parsePartialJson('{"c": "a\\"')).toEqual({ c: 'a"' });
  });

  it("grows a streaming string monotonically", () => {
    const content = "x".repeat(50) + "\\n" + "y".repeat(50);
    const seen = stream(`{"path": "/a.ts", "content": "${content}"}`, 3)
      .map((value) => value?.content)
      .filter((value): value is string => typeof value === "string");
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)).toBe(JSON.parse(`"${content}"`));
  });

  it("falls back to the last comma for a cut literal or key", () => {
    expect(parsePartialJson('{"a": 1, "b": tr')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a": [1, {"b": 2}, nu')).toEqual({ a: [1, { b: 2 }] });
    expect(parsePartialJson('{"a": 1, "b"')).toEqual({ a: 1 });
  });
});
