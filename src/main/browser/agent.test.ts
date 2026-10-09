import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: {} }));

const { BrowserAgent } = await import("./agent");

describe("BrowserAgent", () => {
  it("drops the pane's still of a page once the agent has acted on it", async () => {
    const order: string[] = [];
    const tab = { id: "t1", agent: "h1", console: [], view: { webContents: { getURL: () => "https://site.test/", getTitle: () => "Site" } } };
    const browser = {
      tabs: new Map([["t1", tab]]),
      active: () => tab,
      hold: () => order.push("hold"),
      release: () => order.push("release"),
      markAgent: () => order.push("mark"),
      staleStill: (stale: unknown) => order.push(stale === tab ? "stale" : "other"),
    };
    expect(await new BrowserAgent(browser as never).run("h1", { action: "console", tab: "t1" })).toMatchObject({ url: "https://site.test/", text: "No console messages." });
    expect(order).toEqual(["hold", "mark", "stale", "release"]);
  });
});
