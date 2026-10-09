import { describe, expect, it, vi } from "vitest";
import { IconCache, iconDataUrl, iconKey, pickCandidate, tabFavicon } from "./favicon";

vi.mock("../site-icons", () => ({ siteIcon: vi.fn(async (url: string) => (url.includes("public.com") ? { mimeType: "image/png", data: "UFVC" } : null)) }));

const shrinkOk = () => "data:image/png;base64,U01BTEw=";
const shrinkFails = () => null;
const icon = (body: string, type: string, status = 200) => new Response(body, { status, headers: { "content-type": type } });

describe("iconDataUrl", () => {
  it("shrinks decodable bitmaps", () => {
    expect(iconDataUrl(Buffer.alloc(100_000), "image/png", shrinkOk)).toBe("data:image/png;base64,U01BTEw=");
  });
  it("keeps small undecodable images raw, never shrinks SVG", () => {
    const shrink = vi.fn(shrinkOk);
    expect(iconDataUrl(Buffer.from("<svg/>"), "image/svg+xml", shrink)).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
    expect(shrink).not.toHaveBeenCalled();
    expect(iconDataUrl(Buffer.alloc(10), "image/x-icon", shrinkFails)).toMatch(/^data:image\/x-icon;base64,/);
  });
  it("drops empty, oversized raw and non-image payloads", () => {
    expect(iconDataUrl(Buffer.alloc(0), "image/png", shrinkOk)).toBeNull();
    expect(iconDataUrl(Buffer.alloc(40_000), "image/x-icon", shrinkFails)).toBeNull();
    expect(iconDataUrl(Buffer.alloc(10), "text/html", shrinkFails)).toBeNull();
  });
});

describe("tabFavicon", () => {
  it("picks the first fetchable candidate", () => {
    expect(pickCandidate(["chrome://x", "http://localhost:5173/favicon.svg", "https://a/b.png"])).toBe("http://localhost:5173/favicon.svg");
  });
  it("fetches the page's icon through the tab session, inferring the type from the extension", async () => {
    const fetcher = vi.fn(async () => icon("<svg/>", "application/octet-stream"));
    expect(await tabFavicon("http://localhost:5173/", ["http://localhost:5173/vite.svg"], fetcher as unknown as typeof fetch, shrinkFails)).toMatch(/^data:image\/svg\+xml;base64,/);
  });
  it("reads icons inlined as data URLs without the session", async () => {
    const fetcher = vi.fn();
    const inline = `data:image/svg+xml,${encodeURIComponent("<svg/>")}`;
    expect(await tabFavicon("http://localhost:8765/", [inline], fetcher as unknown as typeof fetch, shrinkFails)).toBe(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("falls back to the icon service for public pages only", async () => {
    const missing = (async () => icon("", "text/html", 404)) as typeof fetch;
    expect(await tabFavicon("https://public.com/x", ["https://public.com/favicon.ico"], missing, shrinkOk)).toBe("data:image/png;base64,UFVC");
    expect(await tabFavicon("http://localhost:3000/", ["http://localhost:3000/favicon.ico"], missing, shrinkOk)).toBeNull();
  });
});

describe("IconCache", () => {
  const loader = (url: string | null) => vi.fn(async () => url);

  it("loads a site's declared icon once and names it by its content", async () => {
    const cache = new IconCache();
    const load = loader("data:image/png;base64,QQ==");
    const first = await cache.get("https://a.test", ["https://a.test/icon.png"], load);
    expect(first).toEqual({ url: "data:image/png;base64,QQ==", key: iconKey("data:image/png;base64,QQ==") });
    expect(await cache.get("https://a.test", ["https://a.test/icon.png"], load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("keeps origins and declared icons apart", async () => {
    const cache = new IconCache();
    const load = loader("data:image/png;base64,QQ==");
    await cache.get("https://a.test", ["https://a.test/icon.png"], load);
    await cache.get("https://b.test", ["https://a.test/icon.png"], load);
    await cache.get("https://a.test", ["https://a.test/other.png"], load);
    await cache.get("https://a.test", [], load);
    await cache.get("https://a.test", [`data:image/svg+xml,${"x".repeat(5000)}`], load);
    await cache.get("https://a.test", [`data:image/svg+xml,${"y".repeat(5000)}`], load);
    expect(load).toHaveBeenCalledTimes(6);
  });
  it("does not keep a miss", async () => {
    const cache = new IconCache();
    const load = loader(null);
    expect(await cache.get("https://a.test", ["https://a.test/icon.png"], load)).toBeNull();
    expect(await cache.get("https://a.test", ["https://a.test/icon.png"], load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("drops the least recently used icon past its limit", async () => {
    const cache = new IconCache(2);
    const load = loader("data:image/png;base64,QQ==");
    await cache.get("https://a.test", [], load);
    await cache.get("https://b.test", [], load);
    await cache.get("https://a.test", [], load);
    await cache.get("https://c.test", [], load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get("https://a.test", [], load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get("https://b.test", [], load);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it("gives the same icon the same short key and another icon another", () => {
    expect(iconKey("data:image/png;base64,QQ==")).toBe(iconKey("data:image/png;base64,QQ=="));
    expect(iconKey("data:image/png;base64,QQ==")).not.toBe(iconKey("data:image/png;base64,Qg=="));
    expect(iconKey("data:image/png;base64,QQ==")).toMatch(/^[\w-]{16}$/);
  });
});
