import { beforeEach, describe, expect, it } from "vitest";
import { annotations, sendAnnotations } from "./annotations";

const note = (id: string) => ({ id, url: "u", title: "t", selector: "s", label: "l", html: "h", comment: "c" });

describe("annotations", () => {
  beforeEach(() => annotations.drop(annotations.get()));

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

  it("sends every waiting comment to the chat, and keeps them when pi does not take them", async () => {
    annotations.add(note("a"));
    annotations.add(note("b"));
    const calls: unknown[] = [];
    const refuse = await sendAnnotations(async (method, args) => (calls.push([method, args]), { accepted: false, error: "busy" }), "chat-1");
    expect(refuse).toEqual({ accepted: false, error: "busy" });
    expect(annotations.get().map((a) => a.id)).toEqual(["a", "b"]);
    expect(calls[0]).toEqual(["chat.send", { handle: "chat-1", text: "", mode: "send", annotations: [note("a"), note("b")] }]);
    expect(await sendAnnotations(async () => ({ accepted: true }), "chat-1")).toEqual({ accepted: true });
    expect(annotations.get()).toEqual([]);
    expect((await sendAnnotations(async () => ({ accepted: true }), "chat-1")).accepted).toBe(false);
  });

  it("keeps the comments when sending throws", async () => {
    annotations.add(note("a"));
    const error = new Error("host unreachable");
    await expect(sendAnnotations(async () => { throw error; }, "chat-1")).rejects.toBe(error);
    expect(annotations.get()).toEqual([note("a")]);
  });

  it("keeps comments added while an accepted send is in flight", async () => {
    annotations.add(note("a"));
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const pending = sendAnnotations(async (_method, args) => {
      expect(args.annotations).toEqual([note("a")]);
      await gate;
      return { accepted: true };
    }, "chat-1");
    annotations.add(note("b"));
    finish();
    expect(await pending).toEqual({ accepted: true });
    expect(annotations.get()).toEqual([note("b")]);
  });
});
