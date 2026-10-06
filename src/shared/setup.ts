// The first-run Setup flow: what pi-gna needs on the Mac (Node.js, pi and pi's package) and what it found. pi-gna
// never bundles pi; it installs it the way pi's README does, so the terminal and pi-gna run the same pi.

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** pi's README: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (pi needs no lifecycle scripts). */
export const PI_INSTALL_ARGS = ["install", "-g", "--ignore-scripts", PI_PACKAGE] as const;
export const PI_INSTALL_COMMAND = `npm ${PI_INSTALL_ARGS.join(" ")}`;
/** pi's `engines.node`. */
export const MIN_NODE = "22.19.0";

export interface SetupStatus {
  /** The `node` on the PATH (the one pi's shebang runs); `ok` when it is new enough for pi. */
  node: { version: string; ok: boolean } | null;
  npm: boolean;
  /** `pi --version` of the pi chats run (PATH, or PIGNA_PI_BIN); `error` when it is there but fails or does not answer. */
  pi: { version: string } | { error: string } | null;
  /** pi's package was found next to that pi: Providers and Plugins run on it. */
  sdk: boolean;
  /** Homebrew is installed, so `brew install node` is an option. */
  brew: boolean;
}

export type SetupInstallResult = { ok: true } | { ok: false; error: string };

/** A version like `v22.19.0` or `22.20.1` is at least MIN_NODE. */
export function nodeSupported(version: string): boolean {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const have = parts(version);
  const need = parts(MIN_NODE);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** pi runs and pi-gna can reach its logins and plugins. */
export const piReady = (status: SetupStatus): boolean => status.pi !== null && "version" in status.pi && status.sdk;

/** Why npm failed, in words, from the end of its output. */
export function installError(output: string, code: number | null): string {
  if (/EACCES|permission denied/i.test(output))
    return "npm cannot write to its global folder. Node.js from nodejs.org's installer needs sudo for global installs; Node.js from Homebrew or nvm does not. Run the command in a terminal, or install Node.js with Homebrew.";
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(output)) return "npm could not reach the registry. Check your connection and try again.";
  const last = output
    .trim()
    .split("\n")
    // npm ends with "A complete log of this run can be found in…" and blank error lines; the cause comes before them.
    .filter((line) => /npm (error|ERR!)/.test(line) && !/complete log of this run|^npm (error|ERR!)\s*$/.test(line))
    .slice(-3)
    .join("\n");
  return last || `npm exited with code ${code ?? "?"}.`;
}
