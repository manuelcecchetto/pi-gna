import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSETS, appendNotes, manifestFor, validateTarget, windowsNotes } from "./windows-release.mjs";

const release = () => ({ tagName: "v0.16.0", isDraft: false, isPrerelease: false, body: "Original Mac release notes.\n", assets: [{ name: "pi-gna-arm64.dmg" }, { name: "pi-gna-x64.dmg" }] });
const fixture = () => manifestFor({ version: "0.16.0", repo: "manuelcecchetto/pi-gna", sourceCommit: "a".repeat(40), releaseCommit: "b".repeat(40), installer: Buffer.from("MZfake test executable"), createdAt: "2026-10-11T00:00:00.000Z" });

describe("append-only Windows release", () => {
  it("accepts the existing latest version without modifying its tag, assets or notes", () => {
    const target = release();
    const before = structuredClone(target);
    validateTarget(target, "v0.16.0", "0.16.0");
    expect(target).toEqual(before);
  });

  it("refuses a different package/tag, an older release, a draft or a prerelease", () => {
    expect(() => validateTarget(release(), "v0.16.0", "0.16.0", "v0.15.0")).toThrow("match");
    expect(() => validateTarget(release(), "v0.17.0", "0.16.0")).toThrow("latest");
    expect(() => validateTarget({ ...release(), isDraft: true }, "v0.16.0", "0.16.0")).toThrow("published");
    expect(() => validateTarget({ ...release(), isPrerelease: true }, "v0.16.0", "0.16.0")).toThrow("published");
  });

  it.each(ASSETS)("refuses an existing %s rather than overwriting it", (name) => {
    expect(() => validateTarget({ ...release(), assets: [{ name }] }, "v0.16.0", "0.16.0")).toThrow("replace");
  });

  it("records BOTH commits and the exact executable checksum, not merely its version", () => {
    const manifest = fixture();
    expect(manifest.sourceCommit).not.toBe(manifest.releaseCommit);
    expect(manifest.source).toBe(`https://github.com/manuelcecchetto/pi-gna/tree/${"a".repeat(40)}`);
    expect(manifest.installer).toMatchObject({ name: ASSETS[0], bytes: 22, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(manifest).toMatchObject({ platform: "win32", arch: "x64", computerUse: false, automaticUpdates: false, channel: "windows-preview", signing: "unsigned" });
  });

  it("rejects an invalid executable or mutable source reference", () => {
    expect(() => manifestFor({ ...fixture(), repo: "owner/repo", sourceCommit: "main", installer: Buffer.from("MZ") })).toThrow("immutable");
    expect(() => manifestFor({ ...fixture(), repo: "owner/repo", installer: Buffer.from("not an exe") })).toThrow("executable");
  });

  it("only appends clear Windows limitations, leaving the original notes byte-for-byte intact", () => {
    const body = release().body;
    const notes = windowsNotes(fixture());
    const appended = appendNotes(body, notes);
    expect(appended.slice(0, body.length)).toBe(body);
    expect(appended).toContain("Computer Use is not included on Windows");
    expect(appended).toContain("fixes after that tag");
    expect(() => appendNotes(appended, notes)).toThrow("already exist");
    expect(() => validateTarget({ ...release(), body: appended }, "v0.16.0", "0.16.0")).toThrow("already exist");
  });

  it("keeps publication explicit and gated by tests, macOS regression and packaged install checks", () => {
    const workflow = readFileSync(new URL("../.github/workflows/windows-beta.yml", import.meta.url), "utf8");
    expect(workflow).not.toMatch(/continue-on-error|release create|--clobber/);
    expect(workflow).toMatch(/default: false/);
    expect(workflow).toContain("needs: mac-regression");
    expect(workflow).toContain("- run: pnpm test");
    expect(workflow).toContain("scripts/verify-windows-installer.mjs");
    expect(workflow).toContain("scripts/windows-release.mjs publish");
    const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    // Computer Use stays off on Windows: only the macOS app and the Linux (KDE Plasma) helper exist.
    expect(source).toMatch(/computer: \(process\.platform === "darwin" \|\| process\.platform === "linux"\) &&/);
    expect(source).not.toMatch(/computer:[^\n]*win32/);
  });
});
