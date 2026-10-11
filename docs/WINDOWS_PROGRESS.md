# Windows port progress

Source: `windows/v0.16-port`, based on v0.16.0. Release plan: append Windows preview assets to the existing latest
release, preserving its original tag and Mac downloads. Publish only after the gated workflow passes; the Windows
manifest must link the actual port source commit, not imply the old tag contains these fixes.

## Live Kanban

The installed app's session tools reject Windows paths (`cwd must be an absolute path`). Tracking therefore lives on
**a real Kanban board in a separate, corrected development instance**, created/updated through renderer IPC rather
than by hand-editing a board file. No installed files or original profile were changed.

- Profile: `C:\Users\cecch\Projects\pi-gna-windows-dev\profile`
- Temporary control script: `C:\Users\cecch\Projects\pi-gna-windows-dev\board.mjs`
- Development logs: `C:\Users\cecch\Projects\pi-gna-windows-dev\dev.log`
- Its pi agent directory is separate and unconfigured; startup RPC uses the installed pi, but no real provider call
  or login was made. The repeatable smoke test separately uses a fake pi.
- All seven cards, statuses and reports survived a restart of **only this development instance** into the latest build.
- The current porting chat still belongs to the installed instance: it is not falsely attached to these cards. Once
  working in a corrected instance/project, the normal `kanban_*` tools can own the cards again.
- The local CDP debugging endpoint is only for this temporary development instance, never the installed app.

| Card | State | Scope |
| --- | --- | --- |
| `win001` | In review | Preview and worktree bootstrap; 138 focused tests and Electron smoke passed |
| `win002` | In review | Shared Windows paths, boards/laments/themes, ATP references and persistence; authenticated HTTP/project-isolation tests passed |
| `win003` | In progress | Native suite now green: 1,790 passed / 0 failed / 25 skipped; remote CI still pending |
| `win004` | To do | Windows Computer Use via CUA; only discovery/read-only app listing probed, no input integration |
| `win005` | In progress | Append-only release workflow prepared; NSIS packaging and packaged smoke passed, remote Mac/installer checks pending; broader desktop parity remains separate |
| `win006` | In review | Native Claude Code executable discovery/auth/cancellation now passes with disposable .exe and npm-shim fixtures |
| `win007` | In review | Private settings/VAPID files created with verified DACLs before writing; fail-closed and public-parent tests pass |

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
- Release workflow now gates tests, macOS regression, packaged smoke and CI-only installer lifecycle. Publication is
  explicit and append-only; tag/Mac assets remain untouched. Remote workflow results are still pending.

Latest machine-local reports: `%TEMP%\pigna-windows-append-full.json`, `pigna-windows-append-typecheck.log`, and
`pigna-windows-package.log`. See [WINDOWS.md](WINDOWS.md) for the implementation details, prerequisites, CUA design
and remaining acceptance matrix.
