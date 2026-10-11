# Windows port progress

Source: `windows/v0.16-port`, based on v0.16.0. **Windows preview assets are now appended to v0.16.0**, preserving
its original tag and Mac downloads. Binary source: `6cf29cea868848ceaa88b425a74d37c6143d7134`. The manifest links this
actual port commit, not the older tag. [Successful gated workflow](https://github.com/manuelcecchetto/pi-gna/actions/runs/38130628077).

## Live Kanban

The installed app's session tools reject Windows paths (`cwd must be an absolute path`). Tracking therefore lives on
**a real Kanban board in a separate, corrected development instance**, created/updated through renderer IPC rather
than by hand-editing a board file. No installed files or original profile were changed.

- Profile: `C:\Users\cecch\Projects\pi-gna-windows-dev\profile`
- Temporary control script: `C:\Users\cecch\Projects\pi-gna-windows-dev\board.mjs`
- Development logs: `C:\Users\cecch\Projects\pi-gna-windows-dev\dev.log`
- Its pi agent directory is separate and unconfigured; startup RPC uses the installed pi, but no real provider call
  or login was made. The repeatable smoke test separately uses a fake pi.
- The initial seven cards, statuses and reports survived a restart of **only this development instance**. Desktop
  parity beyond the installer milestone is now tracked separately as `win008`.
- The current porting chat still belongs to the installed instance: it is not falsely attached to these cards. Once
  working in a corrected instance/project, the normal `kanban_*` tools can own the cards again.
- The local CDP debugging endpoint is only for this temporary development instance, never the installed app.

| Card | State | Scope |
| --- | --- | --- |
| `win001` | In review | Preview and worktree bootstrap; 138 focused tests and Electron smoke passed |
| `win002` | In review | Shared Windows paths, boards/laments/themes, ATP references and persistence; authenticated HTTP/project-isolation tests passed |
| `win003` | In review | Local suite green; remote Windows 1,792 passed / 0 failed, macOS 1,797 passed / 0 failed |
| `win004` | To do | Windows Computer Use via CUA; only discovery/read-only app listing probed, no input integration |
| `win005` | In review | v0.16.0 Windows installer published after all gates; original tag/Mac downloads unchanged |
| `win006` | In review | Native Claude Code executable discovery/auth/cancellation now passes with disposable .exe and npm-shim fixtures |
| `win007` | In review | Private settings/VAPID files created with verified DACLs before writing; fail-closed and public-parent tests pass |
| `win008` | To do | Native desktop parity: shortcuts, MCP credential retrieval, descendant shutdown, launcher/restart transport, updates and real-model/full-viewer acceptance |

No card is Done: user review/confirmation is still pending.

## Latest verification

- Frozen dependency installation, typecheck and all production bundles pass.
- Windows Electron shim/RPC/preview smoke passes after the final build.
- Full suite: **1,790 passed, 0 failed, 25 skipped**; 1,815 tests across 184 files, on Node 24.21.0.
- Session-cache saves have a graceful-shutdown flush, and retain dirty state after a failed save. The restart fixture
  waits for the old instance to finish before starting another; an injected sharing-violation test verifies retry.
- Native provider tests cover actual Windows executable discovery, configured and PATH npm shims, auth cancellation,
  installation and status. All are fake providers in disposable agent directories, with no browser/network login.
- Node 25.4.0 crashed on a minimal Unicode `fs.cpSync` fixture. A privately installed, checksum-verified Node 24.21.0
  resolved that runtime issue; global Node/PATH unchanged. Recorded as `winl01` on the development Laments board.
- Native Windows setup has nine tests for shims, install results, synchronous spawn errors, partial Unicode/CRLF,
  concurrency and timeout. POSIX shell tests run on POSIX instead of failing to execute on Windows.
- Computer Use policy/RPC tests run over Windows named-pipe fixtures, preserving macOS production transport and
  keeping Windows native Computer Use disabled. Approval/denylist/cancellation coverage is not skipped.
- ATP plan discovery/worktrees/claim/release and a three-process concurrent-claim test pass with Python 3.14.2 and
  private checksum-verified ripgrep 15.2.0 on the test PATH. Exactly one worker claimed the ready node.
- Directory-junction confinement tests pass without elevation. File-symlink checks explicitly report the missing
  privilege; `PIGNA_REQUIRE_FILE_SYMLINKS=1` makes it a failure on a configured security runner.
- Private-file checks use real Windows DACLs, not POSIX mode bits. Settings/VAPID temp files are protected at creation
  before any contents are written, and saves fail closed without ACL support. Tests verify actual private grants,
  public-parent inheritance refusal, exclusive creation and unavailable-helper refusal. No existing credentials or
  parent/user-profile/machine ACLs were inspected or changed.
- NSIS installer packaging passed. The unpacked packaged executable passed actual Electron RPC, Kanban and preview
  smoke, and did not expose the Computer Use extension. Authenticode status is `NotSigned`.
- Remote workflow passed: **Windows 1,792 passed / 0 failed / 23 skipped; macOS 1,797 passed / 0 failed / 18 skipped**.
  File-symlink security coverage is required on the hosted Windows runner. Fresh-runner per-user NSIS install,
  packaged smoke, reinstall, uninstall and preservation of an existing profile marker all passed.
- Published Windows assets on the existing v0.16.0 release. Verified same release ID, unchanged tag/main commit, and
  unchanged Mac asset IDs/sizes/digests. Windows manifest/hash matches the GitHub asset digest. No local installer
  was run and the user's installed application/profile remain untouched.
- Initial hosted runs exposed literal `/tmp`, short-name/canonical-root and inherited PowerShell-module assumptions
  in fixtures. Those are fixed without weakening confinement/DACL assertions. One seven-Python-process lifecycle
  exceeded the 5-second test default on the cold runner; it now has a bounded 15-second test budget.

Latest machine-local reports: `%TEMP%\pigna-windows-append-full.json`, `pigna-windows-append-typecheck.log`, and
`pigna-windows-package.log`; final remote logs are in `pigna-windows-ci-passed.log`. See [WINDOWS.md](WINDOWS.md) for the implementation details, prerequisites, CUA design
and remaining acceptance matrix.
