import { describe, expect, it } from "vitest";
import { draftKey, loadDraft, saveDraft, withRestored } from "./drafts";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
};

describe("drafts", () => {
  it("survive a host that is unreachable or restarted: they live on the phone, keyed by the session, not the host handle", () => {
    const store = memory();
    saveDraft(draftKey({ sessionPath: "/s/a.jsonl", handle: "h1" }), "half a thought", store);
    // After a host restart the chat has a new handle but the same session file.
    expect(loadDraft(draftKey({ sessionPath: "/s/a.jsonl", handle: "h2" }), store)).toBe("half a thought");
  });

  it("drops an emptied draft and tolerates blocked storage", () => {
    const store = memory();
    saveDraft("k", "x", store);
    saveDraft("k", "", store);
    expect(store.map.size).toBe(0);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(loadDraft("k", blocked)).toBe("");
    expect(() => saveDraft("k", "x", blocked)).not.toThrow();
  });

  it("puts messages given back by Stop in front of the typed draft", () => {
    expect(withRestored("typed", ["a", " b "])).toBe("a\n\nb\n\ntyped");
    expect(withRestored("", [])).toBe("");
  });
});
