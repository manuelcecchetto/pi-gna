import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSiteIcons, iconServiceUrl, publicOrigin, siteIcon } from "./site-icons";

const png = (bytes = 4, type = "image/png") => new Response(new Uint8Array(bytes), { headers: { "content-type": type } });

afterEach(() => clearSiteIcons());

describe("publicOrigin", () => {
  it("keeps the origin of public web hosts", () => {
    expect(publicOrigin("https://GitHub.com/a/b?c")).toBe("https://github.com");
    expect(publicOrigin("http://docs.example.org.:8080/x")).toBe("http://docs.example.org:8080");
  });
  it("never sends local or private hosts out", () => {
    for (const url of ["http://localhost:5173", "http://127.0.0.1/", "http://[::1]/", "http://intranet/", "http://box.local/", "https://mac.tail1.ts.net/", "file:///etc/hosts", "mailto:a@b.com", "not a url"]) {
      expect(publicOrigin(url)).toBeNull();
    }
  });
});

describe("siteIcon", () => {
  it("fetches once per origin and returns a data payload", async () => {
    const fetcher = vi.fn(async (_url: string) => png());
    const first = await siteIcon("https://github.com/a", fetcher as typeof fetch);
    const second = await siteIcon("https://github.com/b", fetcher as typeof fetch);
    expect(first).toEqual({ mimeType: "image/png", data: "AAAAAA==" });
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(iconServiceUrl("https://github.com"));
    expect(iconServiceUrl("https://github.com")).toBe("https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https%3A%2F%2Fgithub.com&size=32&drop_404_icon=true");
  });
  it("rejects missing, non-image, SVG and oversized icons, and network errors", async () => {
    expect(await siteIcon("https://a.com", (async () => new Response("", { status: 404 })) as typeof fetch)).toBeNull();
    expect(await siteIcon("https://b.com", (async () => png(4, "text/html")) as typeof fetch)).toBeNull();
    expect(await siteIcon("https://c.com", (async () => png(4, "image/svg+xml")) as typeof fetch)).toBeNull();
    expect(await siteIcon("https://d.com", (async () => png(200_000)) as typeof fetch)).toBeNull();
    expect(await siteIcon("https://e.com", (async () => { throw new Error("offline"); }) as typeof fetch)).toBeNull();
  });
  it("does not fetch for local hosts", async () => {
    const fetcher = vi.fn();
    expect(await siteIcon("http://localhost:3000", fetcher as unknown as typeof fetch)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
