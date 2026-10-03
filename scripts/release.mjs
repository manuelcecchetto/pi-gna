#!/usr/bin/env node
// Cut a release: bump package.json's version, move CHANGELOG.md's Unreleased entries under the new version,
// commit both and add an annotated tag vX.Y.Z (see docs/DESIGN.md, Versioning). Nothing is pushed.
//   pnpm release <patch|minor|major|X.Y.Z> [--dry-run]
//   node scripts/release.mjs notes <vX.Y.Z>   # print a version's changelog section (release.yml)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const UNRELEASED = /^## Unreleased[ \t]*$/m;
const NEXT_HEADING = /^## /m;

/** The version after `current` for a bump level, or an explicit X.Y.Z, which must be newer. */
export function nextVersion(current, bump) {
  const parse = (version) => (/^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : undefined);
  const [major, minor, patch] = parse(current) ?? fail(`package.json's version ${current} is not X.Y.Z`);
  const next =
    bump === "major" ? [major + 1, 0, 0]
    : bump === "minor" ? [major, minor + 1, 0]
    : bump === "patch" ? [major, minor, patch + 1]
    : (parse(bump?.replace(/^v/, "")) ?? fail(`expected patch, minor, major or X.Y.Z, got ${bump ?? "nothing"}`));
  const order = next.findIndex((part, index) => part !== [major, minor, patch][index]);
  if (order === -1 || next[order] < [major, minor, patch][order]) fail(`${next.join(".")} is not newer than ${current}`);
  return next.join(".");
}

/** The changelog with the Unreleased entries moved under `## <version> - <date>`, and an empty Unreleased on top. */
export function cutRelease(changelog, version, date) {
  const heading = changelog.match(UNRELEASED) ?? fail("CHANGELOG.md has no `## Unreleased` heading");
  if (section(changelog, version) !== undefined) fail(`CHANGELOG.md already has a ${version} section`);
  const start = heading.index + heading[0].length;
  const rest = changelog.slice(start);
  const end = rest.search(NEXT_HEADING);
  const entries = (end === -1 ? rest : rest.slice(0, end)).trim();
  if (!entries) fail("nothing under `## Unreleased` in CHANGELOG.md: write what changed first");
  const after = end === -1 ? "" : `\n\n${rest.slice(end)}`;
  return `${changelog.slice(0, start)}\n\n## ${version} - ${date}\n\n${entries}${after.trimEnd()}\n`;
}

/** A version's changelog entries (accepts vX.Y.Z), for the GitHub release notes and the tag message. */
export function releaseNotes(changelog, version) {
  const notes = section(changelog, version.replace(/^v/, ""));
  if (!notes) fail(`CHANGELOG.md has no entries for ${version}`);
  return notes;
}

function section(changelog, version) {
  const heading = changelog.match(new RegExp(`^## ${version.replaceAll(".", "\\.")}(?:[ \\t].*)?$`, "m"));
  if (!heading) return undefined;
  const rest = changelog.slice(heading.index + heading[0].length);
  const end = rest.search(NEXT_HEADING);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function fail(message) {
  throw new Error(message);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function today() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
}

function release(bump, dryRun) {
  const packagePath = join(root, "package.json");
  const changelogPath = join(root, "CHANGELOG.md");
  const packageText = readFileSync(packagePath, "utf8");
  const current = JSON.parse(packageText).version;
  const version = nextVersion(current, bump);
  const tag = `v${version}`;
  if (git("tag", "--list", tag)) fail(`the tag ${tag} already exists`);
  const dirty = git("status", "--porcelain");
  if (dirty && !dryRun) fail("commit or stash your changes first: the release commit holds only package.json and CHANGELOG.md");

  const changelog = cutRelease(readFileSync(changelogPath, "utf8"), version, today());
  const notes = releaseNotes(changelog, version);
  const field = `"version": "${current}"`;
  if (packageText.split(field).length !== 2) fail(`expected ${field} once in package.json`);
  const branch = git("branch", "--show-current") || "HEAD";

  console.log(`${current} -> ${version}\n\n${notes}\n`);
  if (dryRun) {
    console.log(`Dry run: nothing written.${dirty ? " The tree has uncommitted changes, which a real run refuses." : ""}`);
    return;
  }
  writeFileSync(packagePath, packageText.replace(field, `"version": "${version}"`));
  writeFileSync(changelogPath, changelog);
  git("add", "package.json", "CHANGELOG.md");
  git("commit", "--quiet", "-m", `release ${tag}`);
  // whitespace, not strip: keep `### Added`-style lines in the message.
  git("tag", "-a", "--cleanup=whitespace", tag, "-m", `pi-gna ${version}\n\n${notes}`);
  console.log(`Committed and tagged ${tag}. Pushing the tag publishes the release (.github/workflows/release.yml):`);
  console.log(`  git push --atomic origin ${branch} ${tag}`);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "notes") console.log(releaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), args[0] ?? fail("usage: release.mjs notes <vX.Y.Z>")));
    else release(command, args.includes("--dry-run"));
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
