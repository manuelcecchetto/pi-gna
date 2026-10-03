import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cutRelease, nextVersion, releaseNotes } from "./release.mjs";

const root = new URL("..", import.meta.url);

describe("nextVersion", () => {
  it("bumps one level and resets the lower ones", () => {
    expect(nextVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(nextVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
  });

  it("takes an explicit newer version, with or without a v", () => {
    expect(nextVersion("0.1.0", "0.10.0")).toBe("0.10.0");
    expect(nextVersion("0.9.9", "v1.0.0")).toBe("1.0.0");
  });

  it("refuses the same or an older version and anything that is not X.Y.Z", () => {
    expect(() => nextVersion("0.2.0", "0.2.0")).toThrow("not newer");
    expect(() => nextVersion("0.2.0", "0.1.9")).toThrow("not newer");
    expect(() => nextVersion("0.2.0", "1.0")).toThrow("expected patch");
    expect(() => nextVersion("0.2.0", undefined)).toThrow("got nothing");
    expect(() => nextVersion("0.2.0-beta", "patch")).toThrow("not X.Y.Z");
  });
});

const changelog = `# Changelog

Intro.

## Unreleased

- Two.
- One.

## 0.1.0 - 2026-10-03

- First.
`;

describe("cutRelease", () => {
  it("moves the Unreleased entries under the version and leaves Unreleased empty", () => {
    expect(cutRelease(changelog, "0.2.0", "2026-10-04")).toBe(`# Changelog

Intro.

## Unreleased

## 0.2.0 - 2026-10-04

- Two.
- One.

## 0.1.0 - 2026-10-03

- First.
`);
  });

  it("works when Unreleased is the only section", () => {
    expect(cutRelease("# Changelog\n\n## Unreleased\n\n- New.\n", "0.1.0", "2026-10-03")).toBe(
      "# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-10-03\n\n- New.\n",
    );
  });

  it("refuses an empty Unreleased, a missing one and a version that is already there", () => {
    const released = cutRelease(changelog, "0.2.0", "2026-10-04");
    expect(() => cutRelease(released, "0.3.0", "2026-10-05")).toThrow("nothing under");
    expect(() => cutRelease("# Changelog\n", "0.3.0", "2026-10-05")).toThrow("no `## Unreleased`");
    expect(() => cutRelease(changelog, "0.1.0", "2026-10-05")).toThrow("already has a 0.1.0");
  });
});

describe("releaseNotes", () => {
  it("returns one version's entries, given with or without a v", () => {
    const released = cutRelease(changelog, "0.2.0", "2026-10-04");
    expect(releaseNotes(released, "v0.2.0")).toBe("- Two.\n- One.");
    expect(releaseNotes(released, "0.1.0")).toBe("- First.");
  });

  it("does not match a longer version that starts the same", () => {
    expect(() => releaseNotes("## 0.1.0 - 2026-10-03\n\n- First.\n", "0.1")).toThrow("no entries for 0.1");
    expect(() => releaseNotes("## 0.1.10 - 2026-10-03\n\n- Tenth.\n", "0.1.1")).toThrow("no entries");
  });

  it("finds notes in CHANGELOG.md for package.json's version, which release.yml publishes", () => {
    const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    expect(releaseNotes(readFileSync(new URL("CHANGELOG.md", root), "utf8"), version)).not.toBe("");
  });
});
