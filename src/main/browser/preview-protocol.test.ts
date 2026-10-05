import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ session: {}, app: { getPath: () => "/tmp" } }));
vi.mock("./manager", () => ({ PARTITION: "persist:pigna-browser" }));

const { PreviewRegistry, confine, contentTypeFor, handlePreview, parseRange } = await import("./preview-protocol");

describe("parseRange", () => {
  it("handles open-ended, bounded and suffix ranges", () => {
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-50", 10)).toEqual({ start: 0, end: 9 });
  });
  it("rejects unsatisfiable and malformed ranges", () => {
    for (const header of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=abc", "items=0-1"]) expect(parseRange(header, 10)).toBe("invalid");
    expect(parseRange("bytes=-1", 0)).toBe("invalid");
  });
  it("serves everything when there is no header or several ranges", () => {
    expect(parseRange(null, 10)).toBeUndefined();
    expect(parseRange("bytes=0-1,3-4", 10)).toBeUndefined();
  });
});

describe("contentTypeFor", () => {
  it("maps extensions, case-insensitively, with a safe fallback", () => {
    expect(contentTypeFor("a.PDF")).toBe("application/pdf");
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a.mp4")).toBe("video/mp4");
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
  });
});

describe("PreviewRegistry", () => {
  it("mints random hex tokens, one per root, and revokes them", () => {
    const registry = new PreviewRegistry();
    const a = registry.mint("/a");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(registry.mint("/a")).toBe(a);
    expect(registry.mint("/b")).not.toBe(a);
    expect(registry.revoke(a)).toBe(true);
    expect(registry.get(a)).toBeUndefined();
    expect(registry.revoke(a)).toBe(false);
  });
  it("resolves a URL back to the real path", () => {
    const registry = new PreviewRegistry();
    const token = registry.mint("/root");
    expect(registry.resolve(`pigna-file://${token}/dir/a%20b.md`)).toEqual({ path: "/root/dir/a b.md", root: "/root" });
    expect(registry.resolve("pigna-file://nope/a")).toBeUndefined();
  });
});

describe("confine", () => {
  it("accepts paths under the root", () => {
    expect(confine("/r", "a/b.txt")).toBe("/r/a/b.txt");
    expect(confine("/r", "./a")).toBe("/r/a");
  });
  it("refuses traversal, backslashes, NUL and smuggled separators", () => {
    for (const rel of ["../x", "a/../../x", "a/..", "..\\x", "a\\b", "a\0b"]) expect(confine("/r", rel)).toBeUndefined();
  });
  it("treats an absolute-looking path as relative to the root", () => {
    expect(confine("/r", "/etc/passwd")).toBe("/r/etc/passwd");
  });
  it("denies dotfiles except the opened one", () => {
    expect(confine("/r", ".env")).toBeUndefined();
    expect(confine("/r", ".git/config")).toBeUndefined();
    expect(confine("/r", ".env", new Set([".env"]))).toBe("/r/.env");
  });
});

describe("handlePreview", () => {
  const base = mkdtempSync(join(tmpdir(), "preview-"));
  const root = realpathSync(base);
  const viewer = join(root, "viewer");
  mkdirSync(viewer);
  writeFileSync(join(viewer, "index.html"), '<script src="./a.js"></script>');
  writeFileSync(join(viewer, "a.js"), "1");
  mkdirSync(join(root, "project"));
  writeFileSync(join(root, "project", "a.pdf"), "0123456789");
  writeFileSync(join(root, "project", "a.md"), "# hi");
  writeFileSync(join(root, "project", "page.html"), "<p>x</p>");
  writeFileSync(join(root, "project", ".env"), "SECRET=1");
  writeFileSync(join(root, "secret.txt"), "outside");
  symlinkSync(join(root, "secret.txt"), join(root, "project", "link.txt"));
  mkdirSync(join(root, "project", "sub"));
  const registry = new PreviewRegistry();
  const token = registry.mint(join(root, "project"));
  const get = (path: string, headers?: Record<string, string>, method = "GET") =>
    handlePreview(registry, viewer, new Request(`pigna-file://${path}`, { method, headers }));

  it("serves raw bytes with type, no-store and Range", async () => {
    const full = await get(`${token}/a.pdf`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("application/pdf");
    expect(full.headers.get("cache-control")).toBe("no-store");
    expect(await full.text()).toBe("0123456789");
    const part = await get(`${token}/a.pdf`, { range: "bytes=2-4" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    const bad = await get(`${token}/a.pdf`, { range: "bytes=20-" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */10");
  });
  it("serves HTML raw without a CSP", async () => {
    const response = await get(`${token}/page.html`);
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(await response.text()).toBe("<p>x</p>");
  });
  it("serves the viewer with a strict CSP for viewer kinds, bytes for ?raw=1", async () => {
    const page = await get(`${token}/a.md`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(await page.text()).toContain('src="/__viewer/a.js"');
    expect((await get(`${token}/a.md?raw=1`)).headers.get("content-security-policy")).toBeNull();
    expect(await (await get(`${token}/a.md?raw=1`)).text()).toBe("# hi");
    expect(await (await get(`${token}/__viewer/a.js`)).text()).toBe("1");
  });
  it("404s unknown tokens, traversal, dotfiles, directories, symlink escapes and missing files", async () => {
    for (const path of ["deadbeef/a.pdf", `${token}/%2e%2e/secret.txt`, `${token}/a%2f..%2f..%2fsecret.txt`, `${token}/.env`, `${token}/sub`, `${token}/link.txt`, `${token}/missing.txt`, `${token}/__viewer/../../secret.txt`]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain(root);
    }
  });
  it("refuses other methods and a revoked token", async () => {
    expect((await get(`${token}/a.pdf`, undefined, "POST")).status).toBe(405);
    expect((await get(`${token}/a.pdf`, undefined, "HEAD")).status).toBe(200);
    const other = registry.mint(join(root, "viewer"));
    registry.revoke(other);
    expect((await get(`${other}/a.js`)).status).toBe(404);
  });
});
