#!/usr/bin/env node
// Append Windows assets to an EXISTING release. Never creates/retags a release or replaces an asset.
// A Windows port may be newer than that release's tag: record both immutable commits, not just package.version.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ASSETS = ["pi-gna-setup-x64.exe", "pi-gna-windows-x64-build.json", "pi-gna-windows-x64.sha256", "pi-gna-windows-x64-notes.md"];
const MARKER = "<!-- pigna-windows-preview -->";
const fields = "tagName,isDraft,isPrerelease,assets,body,url";
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();

export function validateTarget(release, latest, version, requested = `v${version}`) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || requested !== `v${version}`) throw new Error("Release tag must match package.json's stable version");
  if (release.tagName !== requested || latest !== requested) throw new Error("Target must already be the latest release; no release will be created");
  if (release.isDraft || release.isPrerelease) throw new Error("Expected the existing published stable release");
  const collisions = release.assets.filter((asset) => ASSETS.includes(asset.name)).map((asset) => asset.name);
  if (collisions.length) throw new Error(`Refusing to replace existing Windows assets: ${collisions.join(", ")}`);
  if (release.body?.includes(MARKER)) throw new Error("Windows notes already exist; inspect the release before retrying");
}

export function manifestFor({ version, repo, sourceCommit, releaseCommit, installer, createdAt = new Date().toISOString() }) {
  for (const commit of [sourceCommit, releaseCommit]) if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("An immutable source and release commit are required");
  if (installer.length < 2 || installer[0] !== 0x4d || installer[1] !== 0x5a) throw new Error("Installer is not a Windows executable");
  return {
    schema: 1, version, releaseTag: `v${version}`, releaseCommit, sourceCommit,
    source: `https://github.com/${repo}/tree/${sourceCommit}`, createdAt,
    platform: "win32", arch: "x64", channel: "windows-preview", computerUse: false, automaticUpdates: false,
    signing: "unsigned", node: process.version,
    installer: { name: ASSETS[0], bytes: installer.length, sha256: createHash("sha256").update(installer).digest("hex") },
  };
}

export function windowsNotes(manifest) {
  return `${MARKER}
## Windows x64 preview — ${manifest.version}

The Windows installer is appended to this release; **the existing tag and Mac downloads are unchanged**.

- **Computer Use is not included on Windows.** It remains available in the Mac builds.
- Unsigned, per-user NSIS installer. Windows may show SmartScreen warnings; do not disable system protection.
- No Windows in-app updates yet. Download replacements manually.
- Requires Node 24 and pi; the app's Setup can install pi. ATP/file discovery also need Python 3 and ripgrep.
- This is a Windows preview, not a claim of full macOS feature parity. See the Windows roadmap in the source below.

Windows source: [\`${manifest.sourceCommit}\`](${manifest.source}).
Original release tag commit: \`${manifest.releaseCommit}\`. The Windows source includes fixes after that tag.

Installer SHA-256: \`${manifest.installer.sha256}\`.
The build manifest and checksum file are attached alongside the installer.
`;
}

export function appendNotes(body, notes) {
  if (body.includes(MARKER)) throw new Error("Windows notes already exist; refusing to duplicate or overwrite them");
  return `${body}\n\n${notes}`;
}

async function context() {
  const { version, repository } = JSON.parse(await readFile("package.json", "utf8"));
  const repo = process.env.GITHUB_REPOSITORY ?? /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(repository.url)?.[1];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("A GitHub repository is required");
  const tag = process.env.WINDOWS_RELEASE_TAG || `v${version}`;
  if (tag !== `v${version}`) throw new Error("Target release differs from package.json");
  if (run("git", ["status", "--porcelain"])) throw new Error("Commit the source first; refusing to publish an uncommitted build");
  const sourceCommit = run("git", ["rev-parse", "HEAD"]);
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) throw new Error("Checked-out source differs from the workflow commit");
  const view = (args) => JSON.parse(run("gh", ["release", "view", ...args, "--repo", repo]));
  const release = view([tag, "--json", fields]);
  validateTarget(release, view(["--json", "tagName"]).tagName, version, tag);
  const releaseCommit = run("gh", ["api", `repos/${repo}/commits/${tag}`, "--jq", ".sha"]);
  run("git", ["merge-base", "--is-ancestor", releaseCommit, sourceCommit]);
  // A manifest must point to available source, not a local-only commit.
  if (run("gh", ["api", `repos/${repo}/commits/${sourceCommit}`, "--jq", ".sha"]) !== sourceCommit) throw new Error("Publish the source commit before its binary");
  return { version, repo, tag, sourceCommit, releaseCommit, release };
}

async function prepare(ctx) {
  const installer = await readFile(resolve("dist", ASSETS[0]));
  const manifest = manifestFor({ ...ctx, installer });
  await writeFile(resolve("dist", ASSETS[1]), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve("dist", ASSETS[2]), `${manifest.installer.sha256}  ${ASSETS[0]}\n`);
  await writeFile(resolve("dist", ASSETS[3]), windowsNotes(manifest));
  return manifest;
}

export async function main(command) {
  if (!["check", "prepare", "publish"].includes(command)) throw new Error("Usage: node scripts/windows-release.mjs <check|prepare|publish>");
  const ctx = await context();
  if (command === "check") return console.log(`Append-only target verified: ${ctx.repo} ${ctx.tag}; source ${ctx.sourceCommit}`);
  if (process.platform !== "win32") throw new Error("Prepare/publish the installer on Windows after its native checks");
  const manifest = await prepare(ctx);
  if (command === "prepare") return console.log(`Prepared provenance/checksums for ${ASSETS[0]}; nothing uploaded`);
  // Publication is a separate, explicit workflow choice, after the same run's tests, build and installer smoke.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.WINDOWS_PUBLISH_VERIFIED !== "1") throw new Error("Publishing is restricted to the verified Windows workflow");
  // gh refuses duplicate assets by default. Never use --clobber; leave any partial upload for human inspection.
  run("gh", ["release", "upload", ctx.tag, "--repo", ctx.repo,
    ...ASSETS.slice(1).map((name) => resolve("dist", name)),
    `${resolve("dist", ASSETS[0])}#Windows x64 preview (unsigned, no Computer Use)`]);
  // Re-read notes after uploading so we do not restore an old copy of the Mac release notes.
  const current = JSON.parse(run("gh", ["release", "view", ctx.tag, "--repo", ctx.repo, "--json", "body"]));
  const notes = resolve("dist", "windows-release-notes.md");
  await writeFile(notes, appendNotes(current.body ?? "", windowsNotes(manifest)));
  run("gh", ["release", "edit", ctx.tag, "--repo", ctx.repo, "--notes-file", notes]);
  console.log(`Windows assets appended to ${ctx.release.url}. Existing tag and assets were not changed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2]).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
