import { describe, expect, it } from "vitest";
import { addHostPath, readyRefs, refusal, uploading, type Attached } from "./attach-state";

const ready = (n: number): Attached[] => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, name: `f${i}`, source: "upload", state: "ready", ref: { upload: `id${i}` } }));

describe("phone attachments", () => {
  it("sends only what finished uploading", () => {
    const list: Attached[] = [...ready(1), { key: "u", name: "u", source: "upload", state: "uploading" }, { key: "e", name: "e", source: "upload", state: "error" }];
    expect(readyRefs(list)).toEqual([{ upload: "id0" }]);
    expect(uploading(list)).toBe(true);
  });
  it("refuses before uploading: too many, too large, empty", () => {
    expect(refusal(ready(10), { name: "a", size: 1 })).toMatch(/At most 10/);
    expect(refusal([], { name: "a.mov", size: 26 * 1024 * 1024 })).toMatch(/larger than 25 MB/);
    expect(refusal([], { name: "a", size: 0 })).toMatch(/empty/);
    expect(refusal(ready(9), { name: "a", size: 5 })).toBeUndefined();
  });
  it("attaches a host path once", () => {
    const once = addHostPath([], { name: "src", path: "/Users/me/src", isDir: true });
    expect(addHostPath(once, { name: "src", path: "/Users/me/src", isDir: true })).toBe(once);
    expect(readyRefs(once)).toEqual([{ path: "/Users/me/src" }]);
  });
});
