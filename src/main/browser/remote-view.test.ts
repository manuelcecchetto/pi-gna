import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: {} }));

const { lazyFrame } = await import("./remote-view");

describe("lazyFrame", () => {
  it("decodes the frame on first read only, so frames a viewer drops are never decoded", () => {
    const from = vi.spyOn(Buffer, "from");
    const frame = lazyFrame(Buffer.from("jpeg bytes").toString("base64"), 390, 844);
    from.mockClear();
    expect(frame.cssWidth).toBe(390);
    expect(frame.cssHeight).toBe(844);
    expect(from).not.toHaveBeenCalled();
    expect(frame.jpeg.toString()).toBe("jpeg bytes");
    expect(frame.jpeg).toBe(frame.jpeg);
    expect(from).toHaveBeenCalledTimes(1);
    from.mockRestore();
  });
});

describe("RemoteBrowser input", () => {
  it("drops the pane's still of a page the phone acted on", async () => {
    const { RemoteBrowser } = await import("./remote-view");
    const sendCommand = vi.fn(async () => ({}));
    const tab = { id: "t1", view: { webContents: { debugger: { isAttached: () => true, sendCommand } }, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) } };
    const order: string[] = [];
    const browser = { hold: () => tab, release: () => order.push("release"), staleStill: (stale: unknown) => order.push(stale === tab ? "stale" : "other") };
    await new RemoteBrowser(browser as never).input("t1", { type: "text", text: "hi" });
    expect(sendCommand).toHaveBeenCalledWith("Input.insertText", { text: "hi" });
    expect(order).toEqual(["stale", "release"]);
  });
});
