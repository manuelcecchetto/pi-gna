# pi-gna on Windows

Status: bootstrap. Written on macOS and not yet run on Windows. The goal of the first Windows session is to get a chat
running from a source checkout, then fix the rest from there with pi.

## Run from source

Needs Node 22+, pnpm (`corepack enable`), git, and pi (`npm install -g @earendil-works/pi-coding-agent`).

```powershell
pnpm install
pnpm start      # builds, then starts Electron from the checkout; logs go to this terminal
```

## Done

- `src/main/command.ts`: npm puts commands like `pi` and `npm` on Windows as `.cmd` shims, which Node's `spawn` refuses
  without a shell. `resolveCommand` reads the shim and starts its script with node instead. Every `pi`/`npm` spawn
  goes through it (`pi-process.ts`, `setup.ts`, `plugins.ts`), and so does `findPiSdk` (`pi-auth.ts`). Node's
  bundled `npm.cmd`/`npx.cmd` name their CLI in `SET "NPM_CLI_JS=..."` (`NPM_CLI_SCRIPT`), next to `npm-prefix.js`,
  which is a helper and must not be picked.
- Setup (`setup.ts`): a spawn that throws synchronously (`EINVAL` on an unreadable `.cmd`) fails that one check
  instead of rejecting the whole status, which had also skipped automatic onboarding. After installing pi it adds the
  npm prefix root to PATH (Windows has no `prefix\bin`) with `;`. Verified in the Windows UI (patched windows-beta-0.6.9-1).
- `host-core.ts` `project()` takes any `isAbsolute` path (`C:\...`, UNC), so the Plugins page accepts Windows
  projects. Unit-tested on Windows; not yet checked in the Windows UI.
- `shell-env.ts` skips the login-shell environment read: Explorer already gives apps the user's environment.
- The window keeps the native frame and hides the menu bar until Alt (`index.ts`, macOS-only `hiddenInset`).
- Computer Use is off on anything but macOS (its helper is a macOS app).
- `scripts/build.mjs` starts `pnpm` through a shell on Windows (fixed arguments only).
- Packaging: `pnpm dist:win` builds `dist/pi-gna-setup-x64.exe` (NSIS, per user, unsigned). It also cross-builds on
  macOS without Wine. The updater is off outside macOS, since releases carry dmgs only.
- Beta releases: Actions > **Windows beta** > Run workflow (on main) runs typecheck, runs the tests without failing
  on them (their output is the Windows to-do list) and publishes a prerelease tagged `windows-beta-<version>-<n>`.
  Prereleases are not `releases/latest`, so macOS updates are unaffected.

Platform checks: CI (`ci.yml`) runs the unit tests on Linux, so a `process.platform` guard inside a unit-tested module
switches that module off in CI (the updater's tests failed that way). Put guards where the app wires modules up
(`src/main/index.ts`), or pass the platform in as a parameter, as `command.ts` does.

## Left, roughly in order

1. **Verify the bootstrap.** Onboarding and Setup (node/npm/pi/SDK, provider list) work in a patched Windows beta; check
   that a chat streams and that the Plugins page loads for a `C:\` project. If a spawn fails with `EINVAL`, a `.cmd`
   shim matched neither `SHIM_SCRIPT` nor `NPM_CLI_SCRIPT` in `command.ts`. Known Windows test failures:
   `worktreeCwd` builds a path with an embedded `C:` drive, and a file-symlink test in `host-core.test.ts` hits
   `EPERM` without symlink privileges.
2. **pi's child processes on close.** `PiProcess.close()` sends SIGTERM/SIGKILL, which on Windows kills only pi itself.
   Check whether pi's own children (bash tool, MCP servers) are left running; if so, use `taskkill /T /F /PID`.
3. **Path handling.** About 45 places treat `/` as the separator or as a sign of an absolute path:
   `rg -n 'startsWith\("/"\)|split\("/"\)|lastIndexOf\("/"\)|"/" \+' src`. Hot spots: `src/shared/preview.ts`
   (file links must accept `C:\...`), `src/shared/board.ts` (`projectOf`, worktrees), `src/shared/themes.ts`,
   `src/main/chat-tasks.ts`, `src/main/browser/preview-protocol.ts`, `src/renderer/src/lib/preview-path.ts`.
   Also check how pi names its session folders from the cwd (`session-index.ts`).
4. **Shortcuts.** The renderer checks `metaKey` (about 79 places, e.g. `App.tsx`, `Composer.tsx`, `primitives.tsx`).
   Windows needs Ctrl, through one shared "primary modifier" helper, with the labels to match. `App.tsx` already uses
   Ctrl+O for something else.
5. **Title bar.** The renderer leaves room on the left for the macOS traffic lights (`styles.css` ~127). With the
   native frame that space is wasted; either drop it on Windows or move to `titleBarOverlay`.
6. **Smaller items.**
   - Saving MCP tokens uses the macOS Keychain (`/usr/bin/security` in `plugins.ts`); Windows needs Electron
     `safeStorage` or Credential Manager.
   - Claude Code lookup in `resources/pi-auth.mts`: on Windows the binary is `claude.exe`, and a bare `claude` may be
     a `.cmd` shim.
   - The Tailscale CLI path (`src/shared/tailscale.ts`).
   - The `pi --pigna` launcher (`resources/pigna-flag.ts`) only knows `/Applications/*.app`.
7. **Packaging and updates.** Make the Windows tests pass, then gate on them. Fold the beta into
   `release.yml`. Give `updater.ts` a Windows path: today it is macOS-only (dmg, ditto, codesign, a sh swap script).
8. **Computer Use** through [Cua Driver](https://cua.ai/docs/cua-driver) (MIT, Rust, background UIA/MSAA driving on
   Windows).
   - Start a pinned `cua-driver.exe` as a child behind the existing `ComputerService`, not as a native addon in
     Electron main.
   - Map pi-gna's `computer_*` tools onto its `get_window_state`, `click`, `type_text`, `hotkey`, `set_value` and the
     rest, keeping the tool contract.
   - Pass `background_unavailable` back to the agent instead of retrying in the foreground.
   - Fallback if Cua does not work out: fork iaghp/Desktop-Computer-Use (C#, tools nearly 1:1 with pi-gna's).
