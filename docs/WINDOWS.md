# pi-gna on Windows

Status: **Windows x64 previews published on v0.16.0 and v0.22.0; port not feature-complete**. The port's source baseline was v0.16.0 (`01eba2a`); previews now build from `main`. Keep one upstream
codebase and the existing macOS helper; isolate Windows behavior behind platform boundaries, not a fork or a patched
installed app. Never replace a user's working install while developing the port.

## Run from source

Use Node 24 and pnpm 10 (the version pinned in package.json), Git for Windows, and pi 1.0.0+. The normal test suite
also needs ripgrep and Python. Native auth tests compile a disposable executable with Windows' stock .NET Framework
C# compiler; private-file tests use Windows PowerShell. Neither requires elevation.

```powershell
pnpm install --frozen-lockfile
pnpm build
node bin/pi-gna.mjs
pnpm typecheck
pnpm test
node scripts/verify-windows-preview.mjs
```

If pnpm is not installed, `npx --yes pnpm@10.34.3 <command>` uses the pinned version without a global installation.
The smoke test requires an existing build. It starts a separate, non-focusing Electron instance with its own temporary
profile, agent directory and project, and a fake pi behind an npm-style `.cmd` shim. No real provider call or login.
It verifies RPC startup, native/relative/file-URL links, spaces and Unicode in paths, and actual rendered Markdown
and raw bytes in Electron. It also writes a native Kanban card and verifies that the Computer Use extension is not
passed to pi. Pass `dist/win-unpacked/pi-gna.exe` to test the packaged app instead. It closes only its own process
tree, removes successful fixtures, and retains a failure log.

## Native verification: 2026-10-11

Windows x64, Node **24.21.0**, pnpm 10.34.3, Electron 44.5.1. Earlier runs used Node 25.4.0, which crashed with
0xC0000409 in `fs.cpSync` on Unicode paths (also reproduced outside Vitest). A checksum-verified private Node 24
installation fixed that runtime failure without removing Unicode coverage or changing the global Node/PATH.

| Check | Result |
| --- | --- |
| Frozen-lockfile dependency install | Passed |
| Typecheck | Passed |
| Desktop, mobile and preview production builds | Passed |
| Initial full suite | 1,546 passed, 84 failed, 14 skipped; 29 failing files including suite-load failures |
| After first path/worktree fixes | 1,588 passed, 76 failed, 14 skipped; 25 failing files including suite-load failures |
| Focused path/worktree/host-link suites | 138 passed |
| Core paths/stores/authenticated bridge milestone | 153 passed |
| Previous core/harness milestone | 1,760 passed, 9 failed, 24 skipped; 1,793 tests in 182 files |
| Latest full suite after auth/ACL/cache/release fixes | **1,790 passed, 0 failed, 25 skipped**; 1,815 tests in 184 files |
| NSIS packaging | Passed; unsigned `dist/pi-gna-setup-x64.exe` produced |
| Packaged executable smoke | Passed: native Kanban, shim/RPC, Markdown/raw preview; no Computer Use extension |
| Native ATP claim/release + three concurrent Python processes | Passed; exactly one worker claimed the ready node |
| Corrected development Kanban | Seven real cards created through renderer IPC in an isolated profile; not the installed app's board |
| Real Electron Windows preview/RPC smoke | Passed twice consecutively after fixing a document-ready race in the harness; fake pi only |
| CUA 0.34.1 private stdio probe | Initialize, tools/list (59 tools), read-only list_apps passed |
| Gated macOS CI regression | 1,797 passed, 0 failed, 18 skipped |
| Gated Windows CI suite | 1,792 passed, 0 failed, 23 skipped; file-symlink security coverage required |
| Fresh hosted Windows install/reinstall/uninstall | Passed, including profile preservation and packaged smoke |
| Real-model streaming, native Computer Use actions, Windows updates | Not verified/enabled by this milestone |

The latest run used Python 3.14.2 and a private ripgrep 15.2.0 binary on the test PATH (official Windows archive,
SHA-256 `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5`, checked against the release checksum).
No global installation/PATH change. The developer profile's launcher also adds this private binary to its own PATH.

The nine previous failures are fixed. Auth now resolves native `claude.exe` and npm shims without a shell. Settings
and push saves create an exclusively opened temporary file with a protected current-user DACL **before** writing any
contents; protection is checked and unavailable protection refuses the save. POSIX settings retain their existing
mode, with 0600 for a new file. Only disposable fixtures were used, not existing credentials or parent/profile ACLs.
Session-cache saves now have a shutdown flush and retain dirty state after failures so a subsequent flush can retry.

The 25 skips include POSIX shell/npm/symlink cases that have native Windows counterparts, macOS swap-script execution,
and file-symlink cases requiring a Windows privilege. Native Windows setup now has nine shim/streaming/failure tests;
security confinement still runs with real directory junctions. Set `PIGNA_REQUIRE_FILE_SYMLINKS=1` on a configured
security runner to turn an unavailable file-symlink fixture into a failure. Skips are not claims of Windows parity.

The Windows release workflow no longer tolerates failing tests. Live tracking and the isolated development profile
are recorded in [WINDOWS_PROGRESS.md](WINDOWS_PROGRESS.md). A green fixture suite still does not prove full parity.

### Implemented bootstrap and first fixes

- `src/main/command.ts` resolves npm/pnpm `.cmd` shims to scripts run by Node, without passing user input through a
  shell. Node's `NPM_CLI_JS` is preferred over the adjacent `npm-prefix.js` helper. Pi, npm and SDK lookup use it.
- Every git pi-gna runs itself (worktrees, the status card, the GitHub page, ATP) goes through `resolveGit` in
  `command.ts`: on Windows it runs Git for Windows' real `git.exe` instead of the `cmd\git.exe` launcher the
  installer puts on PATH, which only starts the real binary as a second process and leaks a kernel token per run
  that only a reboot frees (the same fix T3 Code shipped in pingdotgg/t3code#17707). The launcher stays when
  `MSYSTEM` is set or no real binary is found, and a found resolution is remembered for 30 seconds, keyed on PATH.
- Setup catches synchronous spawn errors both per check and during install, and adds the npm prefix root to Windows
  PATH with `;`. Native Windows fixtures cover partial Unicode/CRLF output, concurrent installs, failure, timeout,
  missing npm, broken pi and unsupported shims without contacting npm.
- `host-core.ts` accepts native absolute project paths. The login-shell environment read is skipped on Windows.
- The native Windows frame stays, with the menu on Alt. Computer Use and automatic updates remain macOS-only.
- `scripts/build.mjs` starts pnpm through a shell only with fixed build arguments.
- `src/shared/preview.ts` now parses Windows drives (either separator), explicit UNC paths, local Windows `file:`
  URLs, host-relative/home paths and line suffixes. The renderer's tool/attachment paths share this implementation.
  It does not turn `//host` web links or remote `file://host` authorities into network shares. Device namespaces and
  ambiguous drive-relative paths are refused. UNC parsing is unit-tested; live network-share access is not verified.
- Preview root selection/relative URLs work at drive/filesystem roots and with trailing separators. The protocol
  handler rejects Windows NTFS streams, drive selectors, reserved device names and trailing-dot/space aliases;
  realpath confinement stays in place. A standard-user directory junction escape is covered by a native test.
- `worktreeBranch` compares native paths rather than Git's slash spelling against Node's backslash spelling.
  Real-Git tests now verify concurrent Resolve, reuse, subfolder projects and recovery of removed worktrees.
- Shared `paths.ts` validates POSIX, Windows drive and explicit UNC host paths independently of the client OS, while
  rejecting NULs, drive-relative paths and device namespaces. Kanban/Laments mutations, theme persistence and ATP
  references use it. New shared dependencies are shipped and unpacked for pi's extensions.
- Real authenticated HTTP tests cover card claim/report, lament filing/repeats, project themes and restart persistence
  with native paths, spaces and Unicode, while checking cross-project denial and token revocation.
- ATP discovers Windows plans, names them without backslashes, retains plan/draft thread references over restart,
  uses `py -3`/`python` rather than blindly invoking the Store's python3 alias, and does not reuse a nonempty worktree.
  The librarian's existing Windows lock was verified by concurrent claims, not replaced.
- Device revocation waits for the store's atomic write before returning, instead of racing disk reads in the tests.
- The macOS ComputerService accepts an injected test connector. Windows policy/RPC fixtures use named pipes; the
  production macOS Unix socket and Windows feature gate are unchanged. Approval, denylist, stale-index, overlay,
  cancellation and crash/restart assertions run rather than timing out. This does **not** enable native Windows input.
- Packaging/fixture paths, locale assertions and CRLF readers are portable. `.gitattributes` keeps interpreter scripts
  LF (the release suite could not load its CRLF shebang through Vitest); it does not change platform-specific protocols.

## Remaining work, in delivery order

### 1. Make the core workflow and its Windows tests dependable

- **Fixtures vs product bugs:** keep the new native Windows shim, named-pipe, junction and DACL tests gating, alongside
  platform-neutral policy tests. Run actual macOS helper/shell tests on macOS. Do not change its wire protocol for CI.
- **Filesystem/private state:** settings and VAPID private writes now pass real DACL checks, including public-parent
  inheritance and fail-closed tests. Audit other Windows private state and enterprise filesystem policies separately.
  Never alter user/profile/machine ACLs as a test workaround. File symlinks still need a suitably configured runner.
- **Persistence:** retain the strict device read-after-revoke and cache flush/retry tests; test abrupt process termination
  separately from graceful quit.
- **Commands and shutdown:** pi's own bash/MCP descendants must stop on chat close and quit. Verify before choosing
  targeted `taskkill /T /F /PID`, a Job Object, or an upstream pi fix. Never kill processes by executable name.
- **Discovery:** verify prerequisite discovery/installation on a clean machine. Real watcher tests pass with ripgrep
  on PATH; it is not globally installed or bundled by this patch. Check project identity round-trips with mixed slash
  spellings and live UNC shares; the shared validator deliberately does not rewrite saved keys or case-fold paths.
- **ATP:** native discovery, worktrees, claim/release and concurrent locking now pass. Still verify a complete
  real-model worker/orchestrator run, cancellation and restart. Do not infer that from graph rendering or fake RPC.
- **Providers/plugins:** native executable/shim discovery and login cancellation now pass with fake providers, including
  a real Windows executable fixture. Still verify real model streaming, plugin installs and pi's fd-3 JSON channel.
  Use isolated agent folders; never test logins against the real auth store.

### 2. Native desktop behavior

- Primary-modifier helper and matching labels: Ctrl on Windows, Cmd on macOS. Resolve the existing Ctrl+O
  expand-all vs open-file collision explicitly. Test keys with focus in composer, browser, settings and dialogs.
- Remove macOS traffic-light spacing on Windows; native title bar, menus, zoom, dialogs, Explorer labels and tray/quit
  behavior. Check standard and high DPI, multiple displays and non-English keyboard layouts.
- Replace the macOS Keychain dependency for token-based MCP connections with Windows-protected storage and a
  compatible pi credential retrieval path. No plaintext fallback or secrets in command-line arguments/logs.
- Windows Tailscale executable/PATH lookup, remote host lifecycle and login-item behavior; audit Mac-only UI copy.
- Windows `pi --pigna` launcher. Chat preservation over restart needs a Windows transport design; the POSIX FIFO
  option correctly remains unavailable until then.

### 3. Windows Computer Use, behind the existing policy boundary

Recommended reference/backend: [Cua Driver](https://github.com/trycua/cua/tree/cua-driver-rs-v0.34.1/libs/cua-driver),
**0.34.1**, MIT. The Windows x86_64 binary archive was downloaded separately from the pi-gna tree and checked against
that release's SHA-256 list. A read-only probe of `cua-driver.exe mcp --direct --no-overlay` negotiated legacy MCP
`2025-06-18`, discovered 59 tools and read the app list successfully. It made no input actions and installed no
service, scheduled task, skills or global package. This proves a viable process boundary, not feature parity.

- Keep the Swift backend on macOS. Define a small backend interface for `ComputerAgent`/host wiring, then add a
  Windows adapter that owns a pinned child process. Prefer private stdio over an Electron native addon or a shared,
  globally running daemon. Bound frames, startup/call timeouts and shutdown; do not retry a mutation after a lost reply.
- Explicitly disable upstream default telemetry in the child environment (`CUA_DRIVER_RS_TELEMETRY_ENABLED=false`,
  `DO_NOT_TRACK=1`) and isolate runtime state under the test/app profile. Review inherited driver configuration.
- Keep approval, per-app locks, denylist and revocation in pi-gna main. Resolve identities to canonical executable
  paths/AUMIDs and verify PID/HWND ownership; never authorize only a display name. Block terminal hosts, pi-gna and
  its children, secure desktop/UAC and credential prompts. Do not elevate the driver automatically.
- Set `delivery_mode: "background"` explicitly on input. Surface `background_unavailable` as a refusal; never
  follow its foreground-escalation suggestion automatically. No foreground input mode in the initial port.
- Bind each numeric `element_index` to a fresh driver `element_token` for the exact session/PID/window/snapshot.
  Coordinate actions need the matching capture identity and DPI transform. Do not reuse indexes after refresh or
  silently substitute the frontmost/largest window when a target disappears.
- Keep screenshots and trees from the same observation. Cache that image for pi-gna's subsequent `screenshot`
  method; a phone preview must not refresh/invalidate the agent's element tokens behind its back.
- Inspect structured action results. Delivery is not proof of an effect: verify state after actions and do not
  report an `unverifiable` write as confirmed. Test text focus and Unicode carefully.
- Prove overlay/session cleanup, global Esc, mid-action cancellation, revocation and crash recovery before enabling
  Computer Use in Settings or giving tools to chats. The read-only probe disabled overlays, so it proves none of these.

Observed tool mapping (from the **released executable**, not just main-branch docs):

| pi-gna contract | Driver surface / gap |
| --- | --- |
| app resolution/listing | `list_apps`, `list_windows`, `launch_app`; choose a stable Windows identity |
| app state + screenshot | `get_window_state` requires both `pid` and `window_id` |
| click | `click`, `element_token` or capture-bound coordinates; button/count |
| type/set | `type_text`, `set_value`; background delivery and exact element token |
| key/chord | `press_key`, `hotkey`; translate/validate pi-gna's xdotool syntax |
| drag/scroll | `drag`, `scroll`; translate coordinates and page/amount units explicitly |
| select text | No `select_text` tool advertised; implement a verified route or return unsupported |
| formatted paste | No `paste` tool advertised; not equivalent to blindly calling type_text |
| secondary accessibility action | No one-to-one contract established; discover supported patterns explicitly |
| overlay/motion, run end | cursor/session tools including `set_agent_cursor_motion`, `end_session`; verify live |

Acceptance fixture matrix: classic Win32 text fields/buttons, WPF, WinUI/UWP (Calculator/Notepad), Electron and
WebView2, and Office if installed. Verify successful background behavior **and honest refusal** for unsupported
surfaces. Include another foreground window receiving user typing, occluded targets, high DPI, multiple monitors,
stale handles, denylisted apps and two chats contending for the same app. Use disposable fixture documents.

License boundary: retain MIT notices when redistributing CUA code/binaries and inventory bundled dependencies.
The optional OmniParser-based perception extension has an AGPL detector and is **not** part of this proposal.
No driver binary or copied implementation is currently included in pi-gna.

### 4. Installer and release gate

Delivery decision: **append a clearly labeled Windows preview to the existing latest release**, without Computer Use.
Do not create a Windows-only version, move the existing tag, or replace the Mac assets. `pnpm dist:win` produces the
unsigned, per-user NSIS installer `dist/pi-gna-setup-x64.exe`.

`.github/workflows/windows-beta.yml` is now the manual **Windows release asset** workflow. It requires macOS regression
and Windows tests, then packaging and real packaged smoke. Its installer lifecycle check is restricted to fresh
GitHub-hosted Windows runners and refuses existing pi-gna registrations, running instances or profiles. That check
installs/reinstalls/uninstalls under a disposable directory and verifies a preexisting profile marker survives.
It must never be run against the developer's installed app. `publish` defaults to false.

`scripts/windows-release.mjs` checks the existing latest tag against package.json, clean/published source and ancestry.
The Windows manifest records both the original tag commit and the actual port commit, plus the installer hash.
Publication is append-only: refuse collisions (no `--clobber`), append Windows-only notes, and never create/retag a
release. Partial uploads require inspection instead of destructive automatic retries. The four Windows assets are:

- `pi-gna-setup-x64.exe`
- `pi-gna-windows-x64-build.json`
- `pi-gna-windows-x64.sha256`
- `pi-gna-windows-x64-notes.md`

**Published:** [v0.16.0 Windows installer](https://github.com/manuelcecchetto/pi-gna/releases/download/v0.16.0/pi-gna-setup-x64.exe).
The [gated workflow](https://github.com/manuelcecchetto/pi-gna/actions/runs/38130628077) passed macOS regression,
Windows tests, packaged smoke and fresh-runner install/reinstall/uninstall with profile preservation. The binary's
source is `6cf29cea868848ceaa88b425a74d37c6143d7134`; the existing release tag and `main` remained at `01eba2a` when
published. Original Mac asset IDs, sizes and SHA-256 digests were checked unchanged after publication.

Windows installer SHA-256: `8329f95d2e31711fdadd769751cb36a8a4cbb86efd8bee4589335dbe2db128e5` (161,405,833 bytes).
The GitHub asset digest matches its manifest and checksum file. The developer's installed application was not replaced.

**v0.22.0 (2026-10-15):** the same append-only publication on the v0.22.0 release, source `b2743f2`
(two commits past the tag, both in this smoke script, so the shipped app is the tagged one). Installer SHA-256:
`51e62c744dc3291296ed2d4dfaa13f1cd829695a01414452a61e31280a3e19a1` (161,466,210 bytes); same release ID and
unchanged Mac asset IDs/sizes/digests verified after appending. This is also the first Windows build whose own git
calls run Git for Windows' real `git.exe` (`resolveGit`, above). Two gate lessons from getting it out:

- The preview smoke copies the fake pi into its temp profile. `fake-pi-visuals.mjs` reads
  `../resources/skills/inline-visuals/SKILL.md` relative to itself at import, so the copies must keep the repo's
  `scripts/` + `resources/` layout, or the fake pi dies on startup and the smoke reports a window-less
  "session is not running". The smoke now also prints the RPC reply and the app's output into the CI log on
  failure; the runner-local `smoke.log` does not survive a hosted run.
- The seven-Python-process ATP lifecycle test (15 s budget) timed out once on a cold hosted runner and passed on
  the next two runs unchanged. Treat a single timeout there as runner weather, not a regression; two in a row is a bug.

SmartScreen/reputation and signing policy, real-model acceptance, full viewer/UI coverage and Windows updates remain
separate work. The updater is still macOS-only; no driver is bundled or Computer Use extension exposed on Windows.
Use the installed preview to open the source checkout; continue development there, never inside the installation.

CI should run platform-neutral tests on Linux, macOS and Windows, plus explicit platform-specific suites. Put runtime
platform selection where the app wires modules up, or inject it in tests; a platform guard deep inside a shared
module can silently disable the code that Linux CI was supposed to exercise.
