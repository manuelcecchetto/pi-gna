// In-app updates from GitHub releases. Builds are ad-hoc signed, so Squirrel.Mac (Electron's autoUpdater and
// electron-updater) cannot install them: it checks an update against the running app's designated requirement,
// which for an ad-hoc signature is that one build's cdhash. pi-gna updates itself the way the README's agent
// install does instead: it asks GitHub for the latest release, downloads this Mac's dmg, checks it against the
// sha256 digest GitHub publishes for every asset, and copies the app out of it into the profile. When pi-gna
// quits, a detached shell swaps the staged app for the running one and, for Restart, starts it.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, net } from "electron";
import { homepage, name } from "../../package.json";
import type { UpdateRelease, UpdateState } from "../shared/ipc";
import { log } from "./log";

const REPO = new URL(homepage).pathname.replace(/^\/|\/$/g, "");
const FIRST_CHECK = 15_000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

/** A release as the updater sees it: what the window shows, plus this Mac's dmg when GitHub has a digest for it. */
export interface ReleaseInfo extends UpdateRelease {
  dmg?: { url: string; size: number; sha256: string };
}

/** 1, 0 or -1 as version `a` is newer than, the same as or older than `b` (X.Y.Z; anything else counts as 0.0.0). */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1) ?? []).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** GitHub's `releases/latest` answer, reduced to the release and the dmg named `asset`. */
export function parseRelease(json: unknown, asset: string): ReleaseInfo {
  const release = (json ?? {}) as Record<string, unknown>;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`GitHub's latest release has an unexpected tag (${JSON.stringify(release.tag_name)})`);
  const assets = Array.isArray(release.assets) ? (release.assets as Record<string, unknown>[]) : [];
  const file = assets.find((entry) => entry?.name === asset);
  const sha256 = typeof file?.digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(file.digest)?.[1] : undefined;
  const url = typeof file?.browser_download_url === "string" && file.browser_download_url.startsWith("https://") ? file.browser_download_url : undefined;
  const page = typeof release.html_url === "string" && release.html_url.startsWith("https://github.com/") ? release.html_url : `https://github.com/${REPO}/releases/tag/${tag}`;
  return {
    version: tag.slice(1),
    notes: typeof release.body === "string" ? release.body : "",
    url: page,
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    dmg: url && sha256 && typeof file?.size === "number" ? { url, size: file.size, sha256 } : undefined,
  };
}

/** The .app bundle around an executable, if it is in one. */
export function bundleOf(exe: string): string | undefined {
  const at = exe.lastIndexOf(".app/Contents/MacOS/");
  return at < 0 ? undefined : exe.slice(0, at + 4);
}

/** Why this copy of pi-gna cannot replace itself (then the release page has the download), or undefined. */
export function installBlocker(bundle: string | undefined, packaged: boolean, writable: (path: string) => boolean): string | undefined {
  if (!packaged || !bundle) return "This pi-gna runs from a source checkout: pull and rebuild it to update.";
  if (bundle.includes("/AppTranslocation/")) {
    return "macOS runs this pi-gna from a temporary read-only copy because it was opened where it was downloaded. Move it to Applications, open it from there, and update again.";
  }
  if (!writable(bundle) || !writable(dirname(bundle))) return `pi-gna cannot replace itself in ${dirname(bundle)}: you have no write access there.`;
  return undefined;
}

/**
 * Runs detached as pi-gna quits: waits for its pid to exit, moves the old app aside, moves the staged one into
 * its place (putting the old one back if that fails), and with an executable name starts the app at the
 * target. A failure goes to the `failed` file for the next launch to report. The profile and /Applications
 * share the Data volume, so the swap is two renames. Arguments: pid target staged backup failed [executable].
 * Its output is appended to main.log in the log's file format.
 */
export const SWAP_SCRIPT = `
pid=$1 target=$2 staged=$3 backup=$4 failed=$5 exe=$6
say() { printf '%s %-5s %-10s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" updater "$2"; }
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$backup"
if ! out=$(mv "$target" "$backup" 2>&1); then
  printf 'could not move %s aside: %s' "$target" "$out" > "$failed"
elif ! out=$(mv "$staged" "$target" 2>&1); then
  mv "$backup" "$target"
  printf 'could not move the new version to %s: %s' "$target" "$out" > "$failed"
else
  rm -rf "$backup"
fi
if [ -s "$failed" ]; then say error "$(cat "$failed")"; else say info "installed $target"; fi
if [ -n "$exe" ]; then "$target/Contents/MacOS/$exe" >/dev/null 2>&1 & fi
`;

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, (error, stdout, stderr) => (error ? reject(new Error(`${file.split("/").at(-1)} failed: ${stderr.trim() || error.message}`)) : resolve(stdout.trim()))),
  );
const plistValue = (bundle: string, key: string) => run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents", "Info.plist")]);

const isWritable = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Pushes every state change to `onState` (the window). */
export class Updater {
  private state: UpdateState = { phase: "idle" };
  private release?: ReleaseInfo;
  private checking?: Promise<UpdateState>;
  /** The downloaded app, verified and ready to swap in, its executable's name and the release it is. */
  private staged?: { app: string; exe: string; release: ReleaseInfo };
  private relaunch = false;
  /** Why the last install failed, from the swap script's file; shown until an install works. */
  private installError?: string;
  private readonly bundle = bundleOf(app.getPath("exe"));
  private readonly dir = join(app.getPath("userData"), "update");
  private readonly failedFile = join(app.getPath("userData"), "update-failed.txt");
  // An Intel build under Rosetta moves to the Apple silicon one.
  private readonly asset = `${name}-${app.runningUnderARM64Translation ? "arm64" : process.arch}.dmg`;

  /** Create it once this instance holds the profile: it clears the profile's update files. */
  constructor(private readonly logFile: string, private readonly onState: (state: UpdateState) => void) {
    this.installError = (existsSync(this.failedFile) && readFileSync(this.failedFile, "utf8").trim()) || undefined;
    if (this.installError) log.error("updater", `the last update did not install: ${this.installError}`);
    rmSync(this.failedFile, { force: true });
    // Leftovers of a download that never got installed (pi-gna was killed before it quit cleanly).
    rmSync(this.dir, { recursive: true, force: true });
  }

  get(): UpdateState {
    return this.state;
  }

  /** Packaged builds check at launch and every few hours; a checkout updates with git. */
  start(): void {
    if (!app.isPackaged) return;
    const check = () => void this.check().catch((error: Error) => log.warn("updater", `could not check for updates: ${error.message}`));
    setTimeout(check, FIRST_CHECK);
    setInterval(check, CHECK_EVERY);
  }

  /** Asks GitHub for the latest release. Rejects when GitHub cannot be reached or answers oddly. */
  check(): Promise<UpdateState> {
    this.checking ??= this.fetchLatest().finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async fetchLatest(): Promise<UpdateState> {
    const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${app.getName()}/${app.getVersion()}` },
    });
    if (response.status === 404) return this.state; // nothing released yet
    if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
    const release = parseRelease(await response.json(), this.asset);
    // The user chose to update, so a newer release replaces the one downloading or staged: a download in progress
    // moves on to it when it ends, and a staged one stays installable until the newer one is staged.
    if (this.state.phase === "downloading") {
      if (release.dmg && this.release && compareVersions(release.version, this.release.version) > 0) this.supersede(release);
      return this.state;
    }
    if (this.state.phase === "ready") {
      if (release.dmg && this.staged && compareVersions(release.version, this.staged.release.version) > 0) {
        this.supersede(release);
        void this.fetchAndStage(release);
      }
      return this.state;
    }
    if (compareVersions(release.version, app.getVersion()) <= 0) {
      this.release = undefined;
      return this.set({ phase: "idle" });
    }
    if (this.release?.version !== release.version) log.info("updater", `${release.version} is available (running ${app.getVersion()})`);
    this.release = release;
    const shown = publicRelease(release);
    if (this.installError) return this.set({ phase: "failed", release: shown, error: `The last update did not install: ${this.installError}` });
    const manual = installBlocker(this.bundle, app.isPackaged, isWritable) ?? (release.dmg ? undefined : `GitHub lists no verified ${this.asset} for ${release.version}.`);
    return this.set({ phase: "available", release: shown, manual });
  }

  private supersede(release: ReleaseInfo): void {
    if (this.release?.version !== release.version) log.info("updater", `${release.version} is available (running ${app.getVersion()}, updating to ${this.release?.version})`);
    this.release = release;
  }

  /** Downloads, verifies and stages the available release; the state says how it went. */
  async download(): Promise<void> {
    const release = this.release;
    if (!release?.dmg || !this.bundle || (this.state.phase !== "available" && this.state.phase !== "failed")) return;
    const blocker = installBlocker(this.bundle, app.isPackaged, isWritable);
    if (blocker) {
      this.set({ phase: "failed", release: publicRelease(release), error: blocker });
      return;
    }
    this.installError = undefined;
    await this.fetchAndStage(release);
  }

  /**
   * Stages `release` in a folder of its own, so an older staged release stays installable until this one replaces
   * it; when that fails, the older one is still ready. Then moves on to any newer release a check found meanwhile.
   */
  private async fetchAndStage(release: ReleaseInfo): Promise<void> {
    if (!release.dmg) return;
    const shown = publicRelease(release);
    const dir = join(this.dir, release.version);
    this.set({ phase: "downloading", release: shown, progress: 0 });
    const started = Date.now();
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const dmg = join(dir, this.asset);
      await this.fetchDmg(release.dmg, dmg, (progress) => this.set({ phase: "downloading", release: shown, progress }));
      const staged = await this.stage(dmg, release.version, dir);
      rmSync(dmg, { force: true });
      if (this.staged) rmSync(dirname(this.staged.app), { recursive: true, force: true });
      this.staged = { ...staged, release };
      log.info("updater", `${release.version} is ready to install (${Math.round((Date.now() - started) / 1000)} s)`);
      this.set({ phase: "ready", release: shown });
    } catch (error) {
      log.error("updater", `could not download ${release.version}: ${(error as Error).message}`);
      rmSync(dir, { recursive: true, force: true });
      if (this.staged) this.set({ phase: "ready", release: publicRelease(this.staged.release) });
      else this.set({ phase: "failed", release: shown, error: (error as Error).message });
    }
    const latest = this.release;
    if (latest && latest !== release && compareVersions(latest.version, (this.staged?.release ?? release).version) > 0) await this.fetchAndStage(latest);
  }

  private async fetchDmg(dmg: NonNullable<ReleaseInfo["dmg"]>, path: string, onProgress: (progress: number) => void): Promise<void> {
    const response = await net.fetch(dmg.url, { headers: { "User-Agent": `${app.getName()}/${app.getVersion()}` } });
    if (!response.ok || !response.body) throw new Error(`the download answered ${response.status} ${response.statusText}`);
    const hash = createHash("sha256");
    let received = 0;
    let shown = 0;
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.length;
          // Every whole percent, so a 100 MB download is a hundred updates, not thousands.
          const progress = Math.floor((received / dmg.size) * 100) / 100;
          if (progress > shown && progress < 1) onProgress((shown = progress));
          yield chunk;
        }
      },
      createWriteStream(path),
    );
    if (received !== dmg.size) throw new Error(`the download stopped at ${received} of ${dmg.size} bytes`);
    if (hash.digest("hex") !== dmg.sha256) throw new Error("the download does not match the checksum GitHub lists for it");
    onProgress(1);
  }

  /** Copies the app out of the dmg next to it and checks that it is pi-gna at that version and intact. */
  private async stage(dmg: string, version: string, dir: string): Promise<{ app: string; exe: string }> {
    const mount = join(dir, "mount");
    await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", "-noautoopen", "-mountpoint", mount, dmg]);
    let staged: string;
    try {
      const bundle = readdirSync(mount).find((entry) => entry.endsWith(".app"));
      if (!bundle) throw new Error("the dmg has no app in it");
      staged = join(dir, bundle);
      // --noqtn: never carry a quarantine flag over, or Gatekeeper would stop the restarted app.
      await run("/usr/bin/ditto", ["--noqtn", join(mount, bundle), staged]);
    } finally {
      await run("/usr/bin/hdiutil", ["detach", "-force", mount]).catch((error: Error) => log.warn("updater", error.message));
    }
    const [id, ours, stagedVersion, exe] = await Promise.all([
      plistValue(staged, "CFBundleIdentifier"),
      plistValue(this.bundle ?? "", "CFBundleIdentifier"),
      plistValue(staged, "CFBundleShortVersionString"),
      plistValue(staged, "CFBundleExecutable"),
    ]);
    if (id !== ours) throw new Error(`the dmg holds ${id}, not ${ours}`);
    if (stagedVersion !== version) throw new Error(`the dmg holds version ${stagedVersion}, not ${version}`);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
    return { app: staged, exe };
  }

  /** Quit and start again: with a staged update, as the new version; otherwise the build on disk. */
  restart(): void {
    if (this.staged) this.relaunch = true;
    else app.relaunch();
    app.quit();
  }

  /** On will-quit: hand a staged update to the swap script, which installs it once this process is gone. */
  installOnQuit(): void {
    const staged = this.staged;
    if (!staged || !this.bundle) return;
    this.staged = undefined;
    log.info("updater", `installing ${staged.release.version} over ${this.bundle}${this.relaunch ? " and restarting" : ""}`);
    const out = openSync(this.logFile, "a");
    const args = [String(process.pid), this.bundle, staged.app, join(this.dir, "previous.app"), this.failedFile, this.relaunch ? staged.exe : ""];
    spawn("/bin/sh", ["-c", SWAP_SCRIPT, "pigna-update", ...args], { detached: true, stdio: ["ignore", out, out] }).unref();
  }

  private set(state: UpdateState): UpdateState {
    this.state = state;
    this.onState(state);
    return state;
  }
}

function publicRelease({ version, notes, url, publishedAt }: ReleaseInfo): UpdateRelease {
  return { version, notes, url, publishedAt };
}
