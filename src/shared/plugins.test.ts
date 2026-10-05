import { describe, expect, it } from "vitest";
import catalogJson from "../../resources/plugins/catalog.json";
import { npmName, packageLabel, parseCatalog, samePackage } from "./plugins";

const bundled = () => structuredClone(catalogJson) as unknown as { version: 1; entries: Record<string, unknown>[] };

/** The bundled catalog with its first entry of `kind` changed. */
function withEntry(kind: "mcp" | "package", change: Record<string, unknown>) {
  const catalog = bundled();
  const index = catalog.entries.findIndex((entry) => entry.kind === kind);
  catalog.entries[index] = { ...catalog.entries[index], ...change };
  return catalog;
}

describe("parseCatalog", () => {
  it("reads the bundled catalog: connections with logos, and pinned packages", () => {
    const catalog = parseCatalog(bundled());
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["attio", "notion", "granola", "intercom", "brevo", "pi-web-access", "pi-codex-image-gen"]);
    for (const entry of catalog.entries) if (entry.kind === "mcp") expect(entry.logo?.src).toMatch(/^data:image\/(svg\+xml|png);base64,/);
    expect(catalog.entries.find((entry) => entry.id === "intercom")).toMatchObject({ endpoints: [{ id: "us" }, { id: "eu" }] });
    expect(catalog.entries.find((entry) => entry.id === "brevo")).toMatchObject({ auth: { type: "key", label: "MCP token" } });
  });

  it("refuses what could reach past the catalog: plain http, remote logos, unpinned packages", () => {
    expect(() => parseCatalog(withEntry("mcp", { endpoints: [{ id: "default", label: "x", url: "http://mcp.example.com/mcp" }] }))).toThrow(/not an https URL/);
    expect(() => parseCatalog(withEntry("mcp", { logo: { src: "https://example.com/logo.svg", background: "#ffffff", scale: 0.6 } }))).toThrow(/data: URL/);
    expect(() => parseCatalog(withEntry("package", { source: "npm:pi-web-access" }))).toThrow(/exact version/);
    expect(() => parseCatalog(withEntry("package", { source: "git:github.com/x/y@1.0.0" }))).toThrow(/exact version/);
    expect(() => parseCatalog(withEntry("mcp", { server: "../x" }))).toThrow(/bad server name/);
  });

  it("refuses unknown versions, kinds and duplicates", () => {
    expect(() => parseCatalog({ ...bundled(), version: 2 })).toThrow(/version 2/);
    expect(() => parseCatalog(withEntry("mcp", { kind: "app" }))).toThrow(/unknown kind/);
    const catalog = bundled();
    expect(() => parseCatalog({ ...catalog, entries: [...catalog.entries, catalog.entries[0]] })).toThrow(/listed twice/);
  });
});

describe("package names", () => {
  it("matches a configured package to the catalog's by npm name, at any version", () => {
    expect(npmName("npm:@scope/name@1.2.3")).toBe("@scope/name");
    expect(npmName("npm:pi-web-access")).toBe("pi-web-access");
    expect(npmName("../local")).toBeUndefined();
    expect(samePackage("npm:pi-web-access", { source: "npm:pi-web-access@0.35.0" } as never)).toBe(true);
    expect(samePackage("npm:pi-web", { source: "npm:pi-web-access@0.35.0" } as never)).toBe(false);
    expect(packageLabel("git:github.com/user/repo.git")).toBe("repo");
    expect(packageLabel("../../Code/personal/pi-7tv")).toBe("pi-7tv");
  });
});
