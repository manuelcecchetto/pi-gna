import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewUrl } from "../../shared/preview";
import { previewRoot, relativeTo } from "./preview-tabs";
import { readPreviewImage, resolvePreviewTargets, within } from "./resolve-targets";

vi.mock("electron", () => ({ session: {} }));
vi.mock("./manager", () => ({ PARTITION: "persist:pigna-browser" }));
const { PreviewRegistry, confine, handlePreview } = await import("./preview-protocol");

let base: string;
let project: string;
let file: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pigna-preview-paths-")));
  project = join(base, "My Project");
  file = join(project, "docs", "a b.md");
  await mkdir(join(project, "docs"), { recursive: true });
  await writeFile(file, "# Windows preview\n");
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("native preview paths", () => {
  it("resolves absolute, relative, escaped and file URL links to the same native file", async () => {
    expect(await resolvePreviewTargets(project, [file, "docs/a%20b.md#L1", pathToFileURL(file).href, "missing.md"])).toEqual([file, file, file, null]);
    const image = join(project, "shot.png");
    await writeFile(image, "image fixture");
    expect(await readPreviewImage(project, image)).toEqual({ mimeType: "image/png", data: Buffer.from("image fixture").toString("base64") });
  });

  it("uses the project as root, including drive roots and trailing separators", () => {
    expect(previewRoot(file, project)).toBe(project);
    expect(previewRoot(file, project + sep)).toBe(project + sep);
    expect(previewRoot(file, parse(file).root)).toBe(parse(file).root);
    expect(previewRoot(file, project + "-other")).toBe(join(project, "docs"));
    expect(relativeTo(project, file)).toBe("docs/a b.md");
    expect(relativeTo(project + sep, file)).toBe("docs/a b.md");
    expect(relativeTo(parse(file).root, file)).not.toMatch(/^[\\/]/);
  });

  it("serves a native file through its token and rejects sibling-root traversal", async () => {
    const registry = new PreviewRegistry();
    const token = registry.mint(project);
    const url = previewUrl(token, relativeTo(project, file));
    expect(registry.resolve(url)).toEqual({ path: file, root: project });
    const response = await handlePreview(registry, base, new Request(url + "?raw=1"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Windows preview\n");
    expect(confine(project, "docs/a b.md")).toBe(file);
    expect(confine(parse(file).root, relativeTo(parse(file).root, file))).toBe(file);
    expect(confine(project, "../My Project-other/a.md")).toBeUndefined();
  });

  it("confines junction/symlink targets after realpath, not just their apparent path", async () => {
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "not for the preview");
    // Directory junctions are available to standard Windows users; no elevation or Developer Mode needed.
    await symlink(outside, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
    const escaped = join(project, "escape", "secret.txt");
    expect(await within(escaped, [project])).toBeNull();
    expect(await within(file, [project])).toBe(file);
    const registry = new PreviewRegistry();
    const token = registry.mint(project);
    const response = await handlePreview(registry, base, new Request(`pigna-file://${token}/escape/secret.txt?raw=1`));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("not for the preview");
  });

  it.skipIf(process.platform !== "win32")("rejects NTFS streams, drive selectors, devices and aliased filenames", () => {
    for (const path of ["a.md:secret", "C:/outside.txt", "C:outside.txt", "NUL", "con.txt", "COM1", "LPT².txt", "docs./a.md", "docs /a.md", "a?.md"]) {
      expect(confine(project, path), path).toBeUndefined();
    }
    expect(confine(project.toUpperCase(), "docs/a b.md")).toBe(resolve(project.toUpperCase(), "docs/a b.md"));
  });
});
