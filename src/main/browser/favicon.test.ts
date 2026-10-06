import { describe, expect, it, vi } from "vitest";
import { iconDataUrl, pickCandidate, tabFavicon } from "./favicon";

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
