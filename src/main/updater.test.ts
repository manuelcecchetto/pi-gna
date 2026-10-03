import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleOf, compareVersions, installBlocker, parseRelease, SWAP_SCRIPT } from "./updater";

vi.mock("electron", () => ({ app: {}, net: {} }));

const SHA = "b94cce76e9bc92fb701ed510599ee1edbe52387738199101985fedf16e2e7a25";
// The shape of GitHub's releases/latest answer, trimmed to what the updater reads.
const latest = (patch: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0",
  html_url: "https://github.com/manuelcecchetto/pi-gna/releases/tag/v0.2.0",
  body: "- The sidebar shows pi-gna's version.",
  published_at: "2026-10-03T17:00:00Z",
  assets: [
    {
      name: "pi-gna-arm64.dmg",
      size: 113747161,
      digest: `sha256:${SHA}`,
      browser_download_url: "https://github.com/manuelcecchetto/pi-gna/releases/download/v0.2.0/pi-gna-arm64.dmg",
    },
    { name: "pi-gna-x64.dmg", size: 120576488, digest: null, browser_download_url: "https://github.com/manuelcecchetto/pi-gna/releases/download/v0.2.0/pi-gna-x64.dmg" },
  ],
  ...patch,
});

describe("compareVersions", () => {
  it("orders X.Y.Z numerically, with or without a v", () => {
    expect(compareVersions("0.2.0", "0.1.0")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBe(-1);
  });

  it("counts anything else as 0.0.0", () => {
    expect(compareVersions("nightly", "0.0.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.1", "0.0.0")).toBe(0);
  });
});

describe("parseRelease", () => {
  it("takes the version, notes, page and this Mac's dmg with its digest", () => {
    expect(parseRelease(latest(), "pi-gna-arm64.dmg")).toEqual({
      version: "0.2.0",
      notes: "- The sidebar shows pi-gna's version.",
      url: "https://github.com/manuelcecchetto/pi-gna/releases/tag/v0.2.0",
      publishedAt: "2026-10-03T17:00:00Z",
      dmg: { url: "https://github.com/manuelcecchetto/pi-gna/releases/download/v0.2.0/pi-gna-arm64.dmg", size: 113747161, sha256: SHA },
    });
  });

  it("offers no download without a sha256 digest, an https URL or the asset itself", () => {
    expect(parseRelease(latest(), "pi-gna-x64.dmg").dmg).toBeUndefined();
    expect(parseRelease(latest(), "pi-gna-universal.dmg").dmg).toBeUndefined();
    const plain = latest({ assets: [{ ...latest().assets[0], browser_download_url: "http://example.com/pi-gna-arm64.dmg" }] });
    expect(parseRelease(plain, "pi-gna-arm64.dmg").dmg).toBeUndefined();
  });

  it("only links release pages on github.com", () => {
    expect(parseRelease(latest({ html_url: "https://evil.example/v0.2.0" }), "pi-gna-arm64.dmg").url).toBe(
      "https://github.com/manuelcecchetto/pi-gna/releases/tag/v0.2.0",
    );
  });

  it("refuses tags that are not vX.Y.Z", () => {
    expect(() => parseRelease(latest({ tag_name: "nightly" }), "pi-gna-arm64.dmg")).toThrow(/unexpected tag/);
    expect(() => parseRelease(null, "pi-gna-arm64.dmg")).toThrow(/unexpected tag/);
  });
});

describe("installBlocker", () => {
  const writable = () => true;

  it("finds the bundle around the executable", () => {
    expect(bundleOf("/Applications/pi-gna.app/Contents/MacOS/pi-gna")).toBe("/Applications/pi-gna.app");
    expect(bundleOf("/usr/local/bin/node")).toBeUndefined();
  });

  it("lets an installed app in a writable folder replace itself", () => {
    expect(installBlocker("/Applications/pi-gna.app", true, writable)).toBeUndefined();
  });

  it("sends checkouts, translocated copies and read-only folders to the release page", () => {
    expect(installBlocker("/repo/node_modules/electron/dist/Electron.app", false, writable)).toMatch(/source checkout/);
    expect(installBlocker("/private/var/folders/x/AppTranslocation/ABC/d/pi-gna.app", true, writable)).toMatch(/Move it to Applications/);
    expect(installBlocker("/Applications/pi-gna.app", true, (path) => path !== "/Applications")).toMatch(/no write access/);
  });
});

describe("SWAP_SCRIPT", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake .app whose executable records that it was started. */
  function bundle(path: string, marker: string): void {
    mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(path, "marker"), marker);
    const exe = join(path, "Contents", "MacOS", "pi-gna");
    writeFileSync(exe, `#!/bin/sh\necho ${marker} > "${join(dir, "launched")}"\n`);
    chmodSync(exe, 0o755);
  }

  function swap(pid: number, exe: string) {
    const paths = { target: join(dir, "Applications", "pi-gna.app"), staged: join(dir, "update", "pi-gna.app"), failed: join(dir, "failed.txt") };
    const args = [String(pid), paths.target, paths.staged, join(dir, "update", "previous.app"), paths.failed, exe];
    const done = new Promise<string>((resolve, reject) =>
      execFile("/bin/sh", ["-c", SWAP_SCRIPT, "pigna-update", ...args], (error, stdout) => (error ? reject(error) : resolve(stdout))),
    );
    return { ...paths, done };
  }

  async function launched(): Promise<string> {
    for (let i = 0; i < 50 && !existsSync(join(dir, "launched")); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    return readFileSync(join(dir, "launched"), "utf8").trim();
  }

  it("waits for pi-gna to exit, swaps in the staged app and starts it", async () => {
    dir = mkdtempSync(join(tmpdir(), "pigna-swap-"));
    bundle(join(dir, "Applications", "pi-gna.app"), "old");
    bundle(join(dir, "update", "pi-gna.app"), "new");
    const app = spawn("sleep", ["0.6"]);
    const { target, staged, failed, done } = swap(app.pid ?? 0, "pi-gna");

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("old");
    expect(await done).toMatch(/ info  updater +installed .*pi-gna\.app\n$/);
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("new");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(join(dir, "update", "previous.app"))).toBe(false);
    expect(existsSync(failed)).toBe(false);
    expect(await launched()).toBe("new");
  });

  it("keeps the old app when the new one cannot move in, and says why", async () => {
    dir = mkdtempSync(join(tmpdir(), "pigna-swap-"));
    bundle(join(dir, "Applications", "pi-gna.app"), "old");
    mkdirSync(join(dir, "update")); // the staged app is gone
    const { target, failed, done } = swap(999_999_999, "");

    expect(await done).toMatch(/ error updater +could not move the new version to/);
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("old");
    expect(readFileSync(failed, "utf8")).toMatch(/^could not move the new version to .*pi-gna\.app: /);
    expect(existsSync(join(dir, "launched"))).toBe(false);
  });
});
