import { describe, expect, it } from "vitest";
import { annotations } from "./annotations";

const note = (id: string) => ({ id, url: "u", title: "t", selector: "s", label: "l", html: "h", comment: "c" });

describe("annotations", () => {
  it("keeps what was added, and a send drops only what it took", () => {
    annotations.add(note("a"));
    annotations.add(note("b"));
    const sent = annotations.get();
    annotations.add(note("c"));
    annotations.drop(sent);
    expect(annotations.get().map((a) => a.id)).toEqual(["c"]);
    annotations.remove("c");
    expect(annotations.get()).toEqual([]);
  });
});
