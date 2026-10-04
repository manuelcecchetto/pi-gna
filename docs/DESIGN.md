# pi-gna design

pi-gna is an Electron desktop UI for the [pi coding agent](https://pi.dev). pi is always the backend: every
model call, tool, extension, skill and setting runs inside a `pi --mode rpc` child process, exactly as the user
configured pi. pi-gna only renders and controls.

## Principles

- **Lean.** No dependency on the pi package (its tree is huge); the RPC types we use are vendored in
  `src/shared/protocol.ts` from the pi docs. No component library: native `<dialog>`, the popover API and
  Tailwind. No diff library: pi's `edit` tool already returns a rendered diff. A tiny custom store.
- **pi owns behavior.** Never reimplement agent features client-side. If RPC lacks something, read pi's own files
  (sessions) or add a pi extension; do not fork the runtime.
- **The terminal is the log.** Launched from a terminal (`pi --pigna`, `bin/pi-gna.mjs`), the main process logs
  there, along with every pi child's stderr (prefixed by session). `PIGNA_DEBUG=1` also prints all RPC traffic.
  The same lines go to `~/Library/Logs/<app name>/main.log` (Help > Show Logs), the only log for Finder launches.
- **Untrusted content.** Model output and web pages are untrusted: sanitize markdown, keep the renderer sandboxed
  (contextIsolation, sandbox, CSP), open links outside the app window.

## Architecture

```
terminal: pi-gna            -> logs (main + pi stderr), Ctrl-C quits
  Electron main
    PiProcess      one `pi --mode rpc` child per open session (LF-only JSONL, id-correlated commands)
    SessionHost    handle -> PiProcess, forwards events + extension UI requests to the renderer
    SessionIndex   lists ~/.pi/agent/sessions (pi has no list_sessions command)
    files          `rg --files` for @ mentions
    bridge         AgentBridge: token-gated localhost server for pi-gna's pi extensions (POST /browser, /kanban, /lament)
    browser/       BrowserManager (WebContentsView tabs), BrowserAgent (CDP actions)
    computer/      ComputerService (installs, launches and talks to the native helper), ComputerAgent (policy, approvals, per-app locks), ComputerStore (userData/computer-use.json)
    board, kanban  BoardStore (userData/board.json) and the kanban_* tools' route
    laments        LamentStore (userData/laments.json) and the lament tool's route; both stores are a JsonStore (store)
    github         Github: a project's repository and gh account, its issues and PRs through gh (userData/github.json: logins only)
    atp            Atp: a project's ATP plans (watch, scan), the librarian CLI (claim, release, activate), commits, holds
    app-protocol   serves the built renderer on app://pigna with a strict CSP header
    shell-env      Finder/Dock launches: imports the login shell's environment (PATH for pi/node/rg, API keys)
    updater        checks GitHub releases, downloads and stages a newer build, swaps it in when pi-gna quits
  preload          typed contextBridge API (window.studio)
  renderer         React + Tailwind v4
resources/browser-extension.ts   pi extension loaded with `-e` into every pi-gna session: browser_* tools
resources/computer-extension.ts  the same for the computer_* tools, only while Computer Use is enabled
resources/kanban-extension.ts    the same for the kanban_* tools
resources/lament-extension.ts    the same for the lament tool
resources/atp-extension.ts       ATP orchestrator chats only: atp_pause, atp_resume
resources/atp/                   the ATP roles' system prompts and the vendored ATP skills (architects, librarian CLI)
native/computer-use/            Swift source of the helper app `pi-gna Computer Use.app` (built by `pnpm build:computer-use`)
resources/pigna-flag.ts         pi package extension (`pi install <repo>`): `pi --pigna` launches pi-gna
```

`pi --pigna`: the repo's `package.json` `pi` manifest exposes `resources/pigna-flag.ts`. It registers the flag
and, because flag values are not available to factories yet, checks `process.argv` in its (async) factory: pi
loads extensions before starting the TUI, so the factory can run pi-gna in the foreground with the terminal
attached and `process.exit` with its code. It runs the installed app (`/Applications/<productName>.app`, or
`~/Applications`) when there is one, else this checkout's build through `bin/pi-gna.mjs`; `PIGNA_DEV=1` forces the
checkout. Every other pi process (including pi-gna's RPC children) only registers the flag. `bin/pi-gna.mjs`
itself always runs the checkout, so test instances test the code you are changing.

macOS labels a running app from its bundle's Info.plist, so Electron from node_modules shows as "Electron" in the
Dock, ⌘Tab and the app menu. `bin/pi-gna.mjs` runs an APFS clone of Electron.app instead,
`node_modules/.pigna/<productName>.app`, with that name, `<appId>.dev` and the icon: it takes no space, and the
executable keeps its name (so `app.isPackaged` stays false) and its ad-hoc linker signature, which covers neither
Info.plist nor the icon. `pnpm dev` and test builds started on Electron directly still say "Electron".

## Packaging and release

`pnpm dist` builds `dist/<name>-<arch>.dmg` (no version, so `releases/latest/download/` URLs stay stable) with electron-builder (`electron-builder.yml`); pushing a
`v*` tag makes `.github/workflows/release.yml` build arm64 and x64 dmgs and attach them to a GitHub release.

- **Versioning.** Semver, chosen by hand when you release (while 0.x: minor for features, patch for fixes).
  `pnpm release patch|minor|major` (or an explicit `X.Y.Z`; `--dry-run` previews) bumps `package.json`, moves
  `CHANGELOG.md`'s Unreleased lines under `## X.Y.Z - <date>`, commits both as `release vX.Y.Z` and adds the
  annotated tag `vX.Y.Z` with those lines (`scripts/release.mjs`). It refuses a dirty tree, an empty Unreleased
  and an existing tag, and pushes nothing: it prints the `git push --atomic` that publishes. So a user-visible
  change adds its line under Unreleased in the same commit. release.yml checks the tag against `package.json`
  and puts `release.mjs notes <tag>` (that version's section) above GitHub's generated notes; a test keeps a
  section for the current version. The version is `app.getVersion()`: the log's first line, the About panel and
  the sidebar header (`--pigna-version`, `StudioApi.version`).
- **Name.** `productName` in `package.json` is the app's name everywhere (menus, About, Dock, bundle, profile
  folder `~/Library/Application Support/<productName>`, logs). Renaming the app moves the profile, so carry
  the old folder over when you rename.
- **No node_modules in the app.** Every runtime dependency is renderer code that Vite bundles, so they all sit in
  `devDependencies`; main and preload only import Node and Electron. The asar holds `out/`, `package.json` and
  the files pi reads from disk (`resources/browser-extension.ts`, `resources/kanban-extension.ts`,
  `resources/lament-extension.ts`, `resources/pigna-prompt.md`, and the `src/shared/browser.ts`, `src/shared/board.ts`
  and `src/shared/laments.ts` they import), which are
  also unpacked to `app.asar.unpacked/` (session-host points pi there; `onDisk` in `src/main/resources.ts`). The
  ATP files (`resources/atp/`, `resources/atp-extension.ts`) ride along under `resources/**`; the librarian is a
  Python script (`python3`, standard library only) that main runs from the unpacked copy.
- **Computer Use helper.** `pnpm dist` runs `build:computer-use` first (Swift, universal, ad-hoc signed; plain
  `pnpm build` and `pnpm dev` never need Swift). electron-builder copies `build/computer-use/pi-gna Computer Use.app`
  to `Contents/Resources/computer-use/` via `extraResources` (outside the asar); a checkout reads
  `build/computer-use/`. release.yml builds it, verifies it with `codesign --verify --deep --strict` and fails
  the release if the packaged app lacks it. A missing helper surfaces as `app_not_found` on the Computer Use page.
- **Signing.** There is no Developer ID certificate, so builds are ad-hoc signed (`identity: "-"`, no hardened
  runtime, no notarization) and macOS asks once before opening a downloaded build (README). Squirrel.Mac
  (Electron's `autoUpdater`, electron-updater) cannot update such builds, so pi-gna has its own updater.
- **Updates** (`src/main/updater.ts`). Squirrel checks an update against the running app's designated
  requirement, which for an ad-hoc signature is that one build's cdhash, so every update would fail validation.
  Instead, packaged builds ask `api.github.com/repos/<repo>/releases/latest` 15 s after launch and every 6 hours
  (no token: 60 requests an hour per IP); pi-gna > Check for Updates… asks now, in a checkout too. A newer
  `vX.Y.Z` puts a row at the foot of the sidebar; its dialog shows the release notes. Update downloads
  `<name>-<arch>.dmg` (arm64 for an Intel build under Rosetta) with `net.fetch` into `<profile>/update/` and
  checks its size and GitHub's `sha256:` asset digest (no digest, no in-app install), attaches it, copies the app
  out with `ditto --noqtn` (no quarantine flag, so Gatekeeper does not stop the restart) and checks its bundle id,
  version and `codesign --verify --deep --strict`. On `will-quit` a detached `/bin/sh` (`SWAP_SCRIPT`) waits for
  the pid, moves the old app aside, moves the new one in (two renames on the Data volume; the old one goes back
  if the second fails) and appends a line to main.log. A failure lands in `<profile>/update-failed.txt`, which
  the next launch reports in the dialog. Restart now is the `relaunch` IPC: with an update staged, the script
  starts the new executable directly with pi-gna's environment, as `app.relaunch()` would (so a test instance
  keeps its `PIGNA_USER_DATA`). A checkout, a translocated copy (opened where it was downloaded) or an unwritable
  folder gets a link to the release page instead. Trust: the download is as trustworthy as the GitHub account
  and TLS; the digest catches broken downloads, not a tampered release (a Developer ID would). macOS App
  Management only guards notarized apps, so the swap needs no permission. End to end: package this tree as an
  older version (`electron-builder --mac --dir --arm64 -c.extraMetadata.version=0.0.1
  -c.directories.output=/tmp/<dir>/build`), copy the app to `/tmp/<dir>/Applications`, and run its executable
  as a test instance; it updates itself to the latest release and restarts as it.
- **Fuses** (`electronFuses`): no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`; asar-only loading with
  integrity validation; encrypted cookies; no extra `file://` privileges. Check with
  `pnpm dlx @electron/fuses read --app "dist/mac-arm64/<name>.app"`. Cookie encryption keeps a key in the
  Keychain; an ad-hoc signature changes with every build, so macOS may ask to allow access after an update.
- **Renderer origin.** Outside the dev server the renderer is served from `app://pigna` (standard, secure, V8
  code cache) with a CSP header stricter than the `index.html` meta tag, which also allows Vite's `ws:`.
  localStorage is per origin, so the sidebar layout, pins and bookmarks saved by earlier `file://` builds reset once.
- **IPC** handlers only accept messages from the app window's own page (`trusted()` in `src/main/index.ts`); the
  default session grants only `clipboard-sanitized-write`; `<webview>` is refused.
- **Launch modes.** From a terminal, `PIGNA_CWD` carries the launch directory and the environment is the
  shell's. From Finder the cwd is `/` (new chats start in your home) and `shell-env.ts` runs `$SHELL -ilc` once
  (10 s timeout) in parallel with window creation; IPC that spawns pi or `rg` waits for it. To test a Finder
  launch, scrub the environment: `open` passes the caller's (including `PIGNA_CWD` from the pi-gna session an
  agent runs in), so use `env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" PATH=/usr/bin:/bin open -n -g <app>
  --env PIGNA_USER_DATA=/tmp/<dir> --env PIGNA_BACKGROUND=1 --args --remote-debugging-port=<port>`.
- **One instance per profile.** A second launch (another `pi --pigna`) passes its `PIGNA_CWD` to the
  running app, which opens a new chat there, and exits 0. Test instances have their own profile, so they are
  unaffected.
- **Rebuilding under a running checkout.** `bin/pi-gna.mjs` runs from `out/`, which every `pnpm build` (agents
  verifying a change) rewrites. Main is loaded once, but a reload reads the preload and renderer from `out/` again,
  so the page can call IPC the running main lacks ("No handler registered for 'board:get'"). Main and the preload
  share a build id (`__PIGNA_BUILD__`, stamped in `electron.vite.config.ts`, logged at launch); on a mismatch
  `studio.stale` is true and the window shows a notice with Restart (`app.relaunch()`). `pnpm start` while
  pi-gna runs does not restart it either: it rebuilds `out/`, then hands its cwd to the running (old) instance.
- **Measured** with `scripts/measure-startup.mjs` (Oct 2026, M-series, machine under heavy load, median of 7
  launches, spawn to first contentful paint / RSS of the app's processes): packaged 561 ms / 435 MB; the same code
  unpackaged 768 ms / 551 MB; before packaging (file://, node launcher) ~620 ms / ~500 MB. The main log prints
  `window ready <ms> after launch` on every start. App 242 MB (238 MB is Electron), asar 3.4 MB, arm64 dmg 112 MB.

## Browser (M2)

- **Tabs** are `WebContentsView`s in the persistent partition `persist:pigna-browser` (separate cookies and
  storage from the app; no camera, mic, location or notifications). The renderer draws the tab strip and toolbar
  and reports the viewport rect (`browser:layout`); main attaches the active tab's view over it. Native views
  paint above the DOM, so the renderer hides the view while a DOM overlay must cover it (address suggestions,
  image lightbox, the Kanban card dialog and menus). History lives in `userData/browser-history.json`.
- **Agent tools**: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`,
  `browser_screenshot`, `browser_evaluate`, `browser_console`. The extension calls `POST /browser` on a
  loopback HTTP server; each pi process gets its own bearer token (env `PIGNA_TOKEN`), and the token, never
  the body, decides which session acts. Each session drives its own tab (or adopts the one you are looking at),
  and its actions run through a per-session queue because pi executes one message's tool calls in parallel.
- **Input and screenshots go through CDP** (`webContents.debugger`), not `sendInputEvent`/`capturePage`: those
  need composited frames, which Chromium stops producing while the app window is hidden behind other windows
  (verified: the click did nothing and capture failed with "Current display surface not available").
- **Snapshots** run in an isolated world (shared DOM, separate JS globals) and tag interactive elements with
  `data-pi-ref` numbers that click/type use.
- **Policy** lives in the extension: loopback and `*.localhost` URLs are allowed; any other origin asks once per
  session through `ctx.ui.select`, which renders as a pi-gna approval card. Actions that navigate are re-checked
  afterwards and stepped back if denied. Stagehand's `run`, `snapshot` and `screenshot` are excluded with
  `--exclude-tools` (override with `PIGNA_EXCLUDE_TOOLS`). The extension imports `src/shared/browser.ts`
  directly (pi loads extensions with jiti and aliases `typebox`).
- **Annotations**: comment mode injects a picker (isolated world, closed shadow root) into the active tab; a
  long-pending promise resolves with the element, selector, HTML and comment, main crops the element, and the
  renderer shows it as a chip. The next prompt carries a `<browser-comments>` block plus the crops as images.

## Computer Use

pi can see and operate native macOS apps in the background (accessibility tree, window screenshots, clicks and
typing) with its own cursor, per-app approvals and Esc to stop, without taking the user's mouse or focus.
Behaviour and API shape follow the Codex app's Computer Use; no OpenAI code or binary is used.

- **Process model**: Electron cannot hold these permissions sensibly, so a Swift `LSUIElement` helper,
  `pi-gna Computer Use.app` (`native/computer-use/`, no third-party deps, ad-hoc signed), does the AX, ScreenCaptureKit,
  event and overlay work. It ships in the bundle (`Resources/computer-use/`, outside the asar) and main installs it to
  `~/.pi-gna/computer-use/` so a pi-gna update does not replace the binary macOS granted. Main reinstalls only when the
  bundled `helperVersion` (`native/computer-use/Sources/Protocol.swift`, also `PigCUHelperVersion` in its Info.plist) is
  greater, never because pi-gna's version changed. It is launched with `open -g -n -a … --args` (LaunchServices, so
  Accessibility and Screen Recording are attributed to the helper, not to Electron or the terminal that started
  pi-gna), lazily on the first call or when Settings asks for permissions, and quits with the last session, with
  pi-gna, or when its socket closes.
- **Protocol**: JSON-RPC over a Unix socket (`<userData>/cu-<id>.sock`, 0600, `tmpdir` fallback when the path is
  too long). The first message must be `hello` with a per-launch random token passed in argv. Methods mirror the
  tools (`list_apps`, `get_state`, `click`, `drag`, `scroll`, `type_text`, `press_key`, `set_value`, `select_text`,
  `perform_secondary_action`, `paste`, `screenshot`, `overlay_*`, `permissions`); errors carry helper codes
  (`permission_denied`, `stale_element`, `background_unsupported`, `cancelled`, …); types and the denylist are in
  `src/shared/computer.ts`, the client in `src/main/computer/rpc.ts` and `service.ts`. The helper runs one serial
  queue per app, so chats drive different apps in parallel and one app at a time.
- **Tools**: `computer_list_apps`, `computer_get_app_state` (indexed AX tree text, a diff against the previous read by
  default, plus a window screenshot), `computer_click`, `computer_drag`, `computer_scroll`, `computer_type_text`,
  `computer_press_key` (xdotool syntax), `computer_set_value`, `computer_select_text`,
  `computer_perform_secondary_action`, `computer_paste`. The extension is a thin call to `POST /computer`; actions wait
  for the app to settle (about 1 s, up to 5 s while it looks busy) and return the new state as text. Pointer and key
  events go to the target window through private SkyLight calls, so the user's frontmost app, key window and cursor
  stay put; what cannot be done in the background fails with `background_unsupported` and the helper never
  activates an app, warps the cursor or posts to the HID tap. The screenshot uses the AX tree's own window
  (`window_id`), so picture, indexes and x,y agree.
- **Policy** lives in main (`ComputerAgent`), not the extension, because `bash` inherits `PIGNA_TOKEN` and could call
  the bridge. Off by default (`enabled` in `userData/computer-use.json`, switch in Settings). Terminal apps, pi-gna,
  the helper and macOS security prompts are never operable (403, not listed, not launched), whatever was approved.
  Any other app asks once per chat with a card in the renderer: **Allow once** (until the run ends), **Always allow**
  (persisted, listed and revocable on the Computer Use page) or **Deny** (remembered for the chat). A second chat
  asking for an app another chat is driving gets 409 without an approval card. Run end, chat close, Stop and Esc
  release the chat's apps and its Allow once grants.
- **Overlay and Esc**: per driven app the helper shows a click-through cursor and a pill ("pi is using App · Esc to
  cancel") ordered just above the target window (not a screen-wide overlay, so whatever covers the window covers
  them). A global Esc monitor counts only when the user is evidently looking at that run (the app or pi-gna is
  frontmost, or the pointer is over the window); it hides the overlay and notifies main, which stops the run.
- **Permissions and install**: the helper needs Accessibility and Screen Recording (the Computer Use page, Cmd+Shift+U
  or the app menu, shows both and opens the panes). It is ad-hoc signed, so macOS ties each grant to one exact
  build: a new helper version, or any reinstalled build, needs both granted again. Stale entries with the same name
  can be cleared with `tccutil reset Accessibility|ScreenCapture io.github.manuelcecchetto.pigna.computeruse`. After
  a reset the helper is not listed under Screen & System Audio Recording until it asks; add it with **+** from
  `~/.pi-gna/computer-use/`. A release that does not touch `native/computer-use/` keeps `helperVersion`. macOS 26 may
  also show a one-off "bypass the system private window picker" prompt on the first screenshot; choose Allow.
- **Known limits**: the focused (main) window of an app only, so a multi-window app always acts on that window and,
  with every window off screen, a read falls back to another window of the app; minimized or other-Space windows
  fail with `background_unsupported`. Canvas and game apps that read only HID events cannot be driven. Background
  input relies on private SkyLight SPI and may break on a macOS update. Screenshots and AX text go to the model
  provider (secure field values are never read). Action-time confirmation is a prompt rule, not enforced in code.
  Verified live below the UI (real helper, agent and store with an approval stub: TextEdit and Calculator in
  parallel, approvals, refusals, no change to frontmost app or cursor); the real-chat path, the Esc key and the
  cursor look need a manual check (if Esc does nothing, grant Input Monitoring to the helper too). The long spec and
  its evidence notes are in git history (`docs/COMPUTER_USE.md`).

## Kanban (M3)

- **One board per project** (cwd). Cards are tasks (title, notes, tags, column, attached chats, reports), not threads: a
  chat is on at most one card, a card can have several chats, and a chat only joins cards of its own project.
  Columns are To do, In progress, In review and Done. A card moves only when you move it (drag, its menu, its
  dialog) or an agent does; what its chats are doing shows as the sidebar's pi-logo mark on the card
  (`cardAttention`, the strongest mark of its open chats), never as a column change.
- **Main owns the board** (`userData/board.json`, `BoardStore`), because agents change it too. Every change, from the
  window or an agent, is a `BoardOp` applied by the pure `applyOp` (`src/shared/board.ts`), which checks every
  field (ids, columns, absolute paths, title 300 / notes 20k / report 4k characters, at most 6 tags of 24 and 20
  GitHub links; the last 50 reports are kept). Tags are spelled one way (`normalizeTags`: "#UI Bug" is `ui-bug`); cards saved before tags
  load with none. Writes are serialized, tmp + rename; a file that does not parse moves to `board.corrupt-<ts>.json`, and
  skipped malformed cards keep a copy there. The renderer applies an op locally first (a drop lands at once), main
  applies it again and pushes the whole board (`board:changed`).
- **Agent tools** (`resources/kanban-extension.ts`): `kanban_list` (the chat's project; `card` shows one in full),
  `kanban_claim` (take a card by id or create one; the chat leaves its previous card) and `kanban_update` (move the
  chat's card, report, and/or rename and retag it). They call `POST /kanban` on the browser tools' bridge (`src/main/bridge.ts`, a route
  per path). The token gives the session; its card is found through pi's current session file, asked live with
  `get_state` (`/new` and forks switch files; pi answers RPC commands while one of its tools awaits the bridge,
  verified live), and its project is `projectOf` the cwd SessionHost started it in (a card's worktree counts as its
  project).
- **Card actions** (`state/card-actions.ts`, `registerCardAction`) fill the right-click menu, the card's "…" button
  and its dialog. Investigate, Resolve and QA start a chat in the background (you stay on the board), attach it when
  pi is ready (a new chat's session file is named before anything is written) and only then send the prompt, so
  the agent's first `kanban_update` finds its card; `set_session_name` names it "Investigate: …". QA (cards in
  In review, `qaPrompt`) reviews, tests and tries the change without fixing it, leaves a passing card in review and
  moves a failing one back to In progress. It runs where the change is: the card's worktree when a chat on the card
  worked in one (`hasWorktree`; `cardWorktree` reuses it or brings back the card's branch), else the project folder,
  since a new worktree from HEAD would not have the change. "Chat about it"
  (`discussCard`) opens a new chat with the card as a chip in its composer (`AppState.composerCards`), not as text
  you write under: `send` puts the card's block before your first message (a slash command does not take it) and only
  then attaches the chat. The chip's × drops both the details and the attach; a draft you leave is disposed with it. GitHub
  links are not card actions: they are made on the GitHub page and in the card dialog (see GitHub).
- **Resolve works in a git worktree** (`src/main/worktree.ts`, `studio:card-worktree`), on branch
  `pigna/<card id>-<title words>` from the checkout's HEAD, so its change stays off your checkout until you merge it;
  Investigate, Chat about it and triage stay in the checkout. The worktree is
  `~/.pi-gna/worktrees/<card id><repository path>` (`worktreeCwd`), and the chat runs in the project's folder in it
  (a project can be a subfolder of its repository). It is outside the project because pi loads the AGENTS.md of the
  cwd's parent folders too (twice, in a worktree inside the project) and test runners would find the copy.
  `projectOf` maps a worktree path back to its project for everything keyed by project: the attach check, the
  bridge's board, the session index's groups, the sidebar and the board page. A chat's own cwd stays the worktree, so
  it reopens there. pi keys project trust by the cwd's folders, which a worktree outside the project does not
  share: SessionHost passes `--approve`/`--no-approve` from your decision for the project (`projectTrust`, pi's
  `trust.json`). A second Resolve of the card reuses its worktree (main makes one at a time per card); after
  `git worktree remove`, the next one brings back the card's branch. The prompt says what the worktree lacks
  (ignored files such as dependencies and `.env`; the checkout's uncommitted changes, also a warning toast) and asks
  for a commit on the branch, no push or merge. A project outside git resolves in its folder; a git error starts no
  chat. Worktrees are never removed for you (the chat reopens there, and the branch may hold unmerged work): remove
  one with `git worktree remove <path>`.
- **Adding a card** takes one description in your own words (the inline input at a column's foot; the header's "New
  card" opens To do's), because a title has to be short. `addCard` puts it in the notes, titles the card with its
  start (`draftTitle`, 80 characters at a word) and starts a triage chat in the background like Investigate: a
  quick read-only look, then one `kanban_update` with a real title, one to three tags (reusing the board's,
  `boardTags`) and a short report. It runs on `TRIAGE_MODEL` (Sonnet 5.5, low thinking): `linkCard` sends
  `set_model` and `set_thinking_level` before the prompt, which pi applies to that session only (RPC never saves
  them as your defaults; checked in pi's `rpc-mode.js`). `pickModel` prefers the provider the chat started on, and
  a missing model leaves your default with a warning toast. Tags are edited in the card dialog. Triage chats are
  not listed in the sidebar: `projectViews` leaves out chats named `triageName` (live or indexed; `linkCard` names
  the live chat before pi confirms it), and projects with only triage chats; they are reached from their card.
  A triage that ends well closes (`CardLink.closeWhenDone`; its result is the card's report), so the card is not
  left marked unread. A failed run stays open, marked on the card; a triage you opened is not closed under you.
- **Screenshots on a new card** (`AddCard.tsx`): paste (⌘V), drop or pick ("Add screenshots") them into the add-card
  box, read like the composer's attachments (`readFiles`, `pickFiles`). `addCard` adds the card, saves each image
  with `board:save-image` (main checks the card exists, the type and 25 MB, `CardImages`), then lists them by path
  under `Attachments:` in the notes (`cardNotes`); dropped files that are not images keep their own path. Chats on
  the card get the notes, and pi's read tool shows an image file as an image, the way pi's own Ctrl+V puts a
  `pi-clipboard-*.png` path in the prompt; the triage prompt says to read them first. Images go to
  `userData/card-images/<card id>/`, not pi's `os.tmpdir()`, which macOS empties after three days, and are deleted
  with the card; a failed save removes the card again and keeps your input. Finder images are copied too (a dragged
  screenshot thumbnail is a temporary file). `splitAttachments` keeps the list out of the card's snippet (a
  paperclip count instead) and gives the card dialog its thumbnails; the dialog zooms them itself, since the app's
  lightbox would sit under the modal `<dialog>` (top layer).
- **The card in a prompt** is a `<kanban-card>` block (title, column, tags, its GitHub links as `refLine`, notes, the
  last 5 reports clipped to 600 characters); `kanban_list` shows the links too. `stripStudioBlocks` (renderer) and `textOf` (session index) leave it out of chat titles; the
  transcript shows it as a chip that opens the card (`splitCardBlock`).
- **Pages**: `AppState.page` replaces the chat area with the board of `page.cwd` (and `page.card` open). View >
  Kanban (⌘⇧K, a menu accelerator so it works while the browser has focus), the sidebar's Kanban row, a project's
  hover button and a chat's card chip open it; opening a chat leaves it. A chat under a page is not being looked
  at, so a run that settles meanwhile is marked unread. The card dialog is a native `<dialog>` (React's `autoFocus` runs before
  `showModal()`, which then focuses the first button: focus explicitly after it); it and the context menu set
  `overlay`, which hides the native browser view.
- **Drag and drop** is HTML5. A column cancels `dragenter` as well as `dragover`: a drop that follows entering
  without a `dragover` in between (CDP drags release at once) is refused otherwise.

## Laments

- **One Lamenting board per project**, beside Kanban: what agents could not do because a tool or capability was
  missing, unavailable, hard to find or failing, and how they worked around it. You read it to fix your tooling.
  The idea is Codex's lamenting reports (`~/.codex/lamenting-reports/`, a Markdown file per gap); pi-gna keeps
  its own store per project and does not read or write those files.
- **Agent tool** (`resources/lament-extension.ts`): `lament` with `title`, `body` (Markdown: the task, the
  friction and evidence, the tools checked, the operation wanted, the workaround and its cost) and `severity`:
  `annoying` 😒 (a workaround cost a few steps), `costly` 😠 (slow, manual or brittle) or `blocking` 🤬 (could not
  be done or verified). Its `promptGuidelines` say when: at the point of meaningful friction, observed rather than
  wished for, after looking for a tool, without secrets, then carry on; mention it to the user only when it blocks.
  The reply names the project's other open laments with their ids, and `repeats: <id>` adds a report to one of
  them instead of filing it twice (a resolved one reopens). It calls `POST /lament` on the bridge; the token gives
  the chat, which is recorded on the report so the page can open it, and `projectOf` its cwd the board.
- **Main owns the laments** (`userData/laments.json`, `LamentStore`). It and `BoardStore` are a `JsonStore`
  (`src/main/store.ts`): ops applied by a pure function that checks every field (`applyLamentOp`,
  `src/shared/laments.ts`: title 200 / report 8k characters, a known severity, absolute paths; the first report
  and the latest 29 are kept), serialized tmp + rename writes, a file that does not parse moved to
  `laments.corrupt-<ts>.json`. The whole value is pushed after each change (`laments:changed`); the renderer only
  sends resolve, reopen and remove (`applyLament`) and waits for the push.
- **The page** (`components/Laments.tsx`, `page.kind === "laments"`, keyed by project) lists open laments worst
  first (a lament is as bad as its worst report), then the most recent, with Open and Resolved tabs. A row shows
  the severity emoji, the title, ×n when it was hit again and the latest report; it expands to every report
  (Markdown) with the chat that filed it. Right-click, or the expanded row, resolves, reopens or deletes. View >
  Laments (⌘⇧L), the sidebar's Laments row (the worst open lament's emoji and the count, for the project it
  opens) and a project's context menu open it; switching between the two pages keeps the project (`showPage`).

## GitHub

- **A project's issues and pull requests, read with the GitHub CLI** (`src/main/github.ts`), beside Kanban and
  Laments. Read-only for now (list, look up one); no polling: the page asks when it opens and on Refresh. Creating,
  commenting and merging are later work.
- **The repository** is the project's git remote as gh would pick it (`pickRemote`, `src/shared/github.ts`): the
  remote `gh repo set-default` chose, else upstream, github or origin, on https, ssh or scp-style URLs; a GitHub
  Enterprise host works like github.com.
- **The account**: gh can be logged in to several accounts per host (here a work one for `CASUS-Tech` and a personal
  one) but has one active account, shared with your terminals and agents. pi-gna never runs `gh auth switch`,
  login or logout. It picks an account per repository, in order: the one you chose for the project (the page's
  account menu), the one that read it last time, the login named like the owner, a member of the owner
  organization (`user/orgs`), then any account that can read it (`repos/<owner>/<name>`; a 404 tries the next).
  The choice and the last working login per repository live in `userData/github.json` (`GithubStore`): logins,
  never tokens. A repository an account stops reading (GraphQL "Could not resolve to a Repository") is resolved
  again once, unless you chose that account; a 401 fetches the token again once.
- **Tokens stay in main**: each gh call gets its account's token in `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` on Enterprise
  Server hosts), from `gh auth token --hostname <host> --user <login>`, held in memory only. `ghEnv` drops inherited
  token variables, `GH_HOST`, `GH_REPO` and `GH_DEBUG` (the shell's must not override the account or print
  requests), and `scrub` masks anything token-shaped in errors and logs. The renderer gets logins, items and
  problems (`GithubProblem`: no gh, no GitHub remote, no account on the host, no account can read it, failed).
- **Card links** (`GithubRef` in `src/shared/board.ts`: kind, host, repo, number, url, title; not the account, which
  is chosen whenever pi-gna asks) are `link`/`unlink` board ops, at most 20 per card, keyed by `githubKey`
  (host/repo#number, lowercase); the url must be on its host. `add` takes links too.
- **The page** (`components/GitHub.tsx`, `page.kind === "github"`, keyed by project): Issues and Pull requests tabs,
  Open and Closed (closed PRs include merged ones), the latest 100 each (`GITHUB_LIST_LIMIT`; a link to the rest on
  GitHub), the repository, the account in use and why (its menu: Automatic or an account), Refresh. A row shows the
  state as GitHub draws it, number, author, branch and review for PRs, labels in their colors and the cards that
  link it; it expands to the body (Markdown, images as links: `imagesAsLinks`, since the CSP blocks remote images)
  with Open on GitHub, New card (a To do card with the body as notes, linked) and Link to card… (the project's
  cards not done). View > GitHub (⌘⇧G), the sidebar's GitHub row and a project's context menu open it.
- **On the board**: a card shows its links as badges (icon and number; a click opens it on GitHub), and the card
  dialog lists them with unlink and takes `#12` or a link to add one (`github:lookup` checks it with gh for its
  kind and title).

## ATP

- **What it is.** ATP (Agentic Task Protocol, github.com/manuelcecchetto/atp) breaks a big project into a DAG of
  small nodes in a `<name>.atp.json` plan, and runs each node in a fresh agent context with only the context its
  dependencies left, so a long project does not rot one context and a model cannot stop at "mostly done". It is for
  big projects; Kanban is for features and fixes. The two are separate: no card, board or `kanban_*` tool is
  involved, and a plan is not a card.
- **Bundled stack** (`resources/atp/`): the skills `atp-architect` (macro: a plan from a goal), `atp-micro-architect`
  (micro: a plan for one bounded change) and `atp-local-librarian` (the CLI, `atp_local_librarian.py`, which is the
  only thing that changes a plan: claim, complete, decompose, release, activate, future patches; writes take an
  fcntl lock on `<plan>.lock`). They are vendored from `~/.codex/skills` without their `agents/` and `tests/`
  folders; update them by copying again. The Codex-only Sol orchestrator skill is not bundled: pi-gna's runner
  replaces it. Never edit a `.atp.json` by hand or from pi-gna's code; `parsePlan` (`src/shared/atp.ts`) only reads.
- **Plans** are found per project (`Atp.watch`, `src/main/atp.ts`): `rg --files` for `*.atp.json` (depth 5, skipping
  `node_modules`, `.git` and build folders), then a non-recursive `fs.watch` on each folder holding a plan and on the
  project root (debounced 150 ms), so a plan created in a new subfolder shows after Refresh. `Atp.activate` runs
  `atp-activate-project` and adds `*.atp.json.lock` to the repository's `.git/info/exclude`, so `git add -A` never
  commits the lock.
- **The runner** (`state/atp.ts`, `startPlan`) is the renderer, not a scheduler, and nothing judges a node: like
  atp-runner, per plan it claims the next READY node (`atp-claim-task --agent-id pigna-w1`; `parseClaim` reads
  `TASK ASSIGNED`, `NO_TASKS_AVAILABLE` and "not ACTIVE"), starts a fresh worker chat with the worker prompt and
  the claim packet (`workerMessage`), waits for its run, then reads the plan. A worker completes, fails or decomposes
  its node itself through the librarian, and commits `node(<ID>): <title>`; if HEAD did not move and the tree is
  dirty, main commits what it left (`Atp.commit`, `git add -A`). A node still claimed after the run gets one
  nudge (`nudgeMessage`); after that the runner releases it, notes why on the page and stops. Stop aborts the
  worker and releases its node. A node held by `pigna-w1` while nothing runs (pi-gna quit mid-node) shows as
  Interrupted, and Start resumes it in a new worker that is told it is resuming. The worker's plan-file changes
  stay uncommitted (the worker commits before it completes, as with atp-runner).
- **Fixed config** (`ATP_CONFIG`): orchestrator `openai-codex/gpt-5.6-sol` at high thinking, workers
  `claude-sonnet-5-5` at medium (picked by id like the triage model, preferring the chat's provider; a node's `reasoning_effort` is ignored), one worker per plan, a commit
  per node. A settings page for these is later work.
- **ATP chats are hidden** threads: `--session-dir <userData>/atp-sessions` keeps them out of `~/.pi/agent/sessions`
  and the sidebar (`projectViews` skips them too). SessionHost (`atpArgs`) gives each role its skills (`--skill`),
  its prompt (`resources/atp/worker.md` or `orchestrator.md`, `--append-system-prompt`) and its plan's path. The page
  remembers which chat worked which node (localStorage) and opens them from the node panel. A worker chat closes
  once its node is done, unless you are looking at it.
- **The orchestrator** is one chat per plan, under the page: you ask it how the plan is going, or have it edit or
  extend the plan with the librarian (decompose, future patches). It never works a node. Its extension's
  `atp_pause` holds the plan in main (`Atp.setHeld`; the librarian has no pause) so the runner claims no new node,
  and waits up to 4 minutes for running nodes to finish; `atp_resume` lifts it (and so does the page's Resume). The
  librarian refuses future patches while any node is CLAIMED, SCOPE nodes included; the prompt says so. It starts
  (or resumes from its session file) when the page shows the plan, without a model call, and idle ones stop when
  the page closes. New ATP opens the same composer with the architect skills; the chat that writes the plan
  becomes its orchestrator.
- **The page** (`components/Atp.tsx`, `page.kind === "atp"`, keyed by project): a rail of the project's plans with
  their progress, the plan's bar (status counts that cycle through their nodes, Start/Stop/Resume, the run's last
  note), the graph, a docked node panel (instruction, context, report, its chats) and the orchestrator's transcript
  and composer. View > ATP (⌘⇧A) and the sidebar's ATP row open it.
- **The graph** (`components/AtpGraph.tsx`, `lib/atp-layout.ts`) is native SVG and HTML, no graph library: a
  layered layout (longest-path layers, barycenter ordering, then straightened), cards positioned in one transformed
  layer and edges as SVG paths with `vector-effect: non-scaling-stroke`. SCOPE nodes draw dotted edges to their
  `scope_children`. Status sets the card's look (`lookOf`): running cards glow and their incoming edges are animated
  dashes. Three levels of detail by zoom: cards, titles only, then status-colored blocks, so a 300-node plan reads as
  a progress map when fitted. `--k` (the zoom) keeps outlines and glow screen-sized; selecting a node lights its
  lineage. A canvas minimap shows only when zoomed well past fit.

## pi RPC notes (pi 1.0.0)

Docs live in the installed package: `$(npm root -g)/@earendil-works/pi-coding-agent/docs/` (`rpc.md`,
`rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `message-types.md`, `session-format.md`).

- Framing: one JSON object per LF. Never use Node `readline` (it also splits on U+2028/U+2029).
- Startup: `get_state` answers after ~1.4 s with the user's full extension set. Extensions emit `notify` and
  `setStatus` (ANSI-colored text) right away.
- Hydration: `get_entries` returns every entry plus `leafId`; walk `parentId` from the leaf to rebuild the active
  branch, including history before compaction (which `get_messages` drops).
- Streaming: `message_update` carries deltas only. Replace partial blocks on `*_end`, replace the whole message on
  `message_end`.
- Esc semantics: `clear_queue` (restore its text into the composer), then `abort`.
- While streaming, `prompt` needs `streamingBehavior` (`steer` or `followUp`).
- `edit` tool results: `details = { diff, patch, firstChangedLine }`; `diff` lines are ` 23 ctx`, `-27 old`,
  `+27 new`, `    ...`.
- Session files: `~/.pi/agent/sessions/--<cwd, / -> ->--/<ts>_<uuid>.jsonl`; header
  `{type:"session",version:3,id,timestamp,cwd,parentSession?}`; the latest `session_info` entry holds the name.
  The first user message sits ~100 KB in (after the system message), so the index streams the head and reads a
  64 KB tail for names instead of parsing whole (up to 50 MB) files.

Verified live (pi 1.0.0, Oct 2026):

- `toolResult` and `system` messages also arrive as `message_start`/`message_end`; system messages are ignored.
- Opening a session (`pi --mode rpc --session <file>`) and closing it without prompting leaves the file
  byte-identical, so "preview" opens are safe. Two pi processes prompting the same file are not; pi-gna does not
  warn about it (a "recently updated" banner was tried and removed as noise), so avoid prompting a session that
  is still open in a terminal pi.
- RPC never shows the project-trust prompt: a saved decision in `~/.pi/agent/trust.json` or
  `defaultProjectTrust` decides, and untrusted project resources are skipped silently.
- Every pi process re-emits the same extension startup notices; the renderer toasts each one once per app run
  (the terminal still logs all of them).

## UI model

- **Right-click works everywhere.** Text, links, images and fields get a native menu from main
  (`src/main/context-menu.ts`, on the app window and every browser tab): Copy Image, Save Image As… and the image
  address; open or copy links (the app window opens them in your browser or the browser pane, pages in a new tab);
  Copy, Look Up and Search Google for a selection; Undo to Select All and spelling guesses in fields; Back, Forward,
  Reload and Inspect Element on pages. A spot with none of these shows nothing. The window's own objects (cards,
  sidebar projects and chats, browser tabs) open the DOM `ContextMenu` (`useContextMenu`) with their actions
  instead; it cancels the DOM event, and Chromium then never asks main for a native menu. Chromium copies an SVG
  image as an `<img>` tag only, with no pixels (Chrome does too), so Copy Image draws an SVG into a PNG in an
  isolated world; a cross-origin SVG taints that canvas and keeps Chromium's copy.
- New chats are drafts (`isDraft`: started in pi-gna, nothing sent, not running or waiting) and stay out of the
  sidebar; the "New chat" row is highlighted instead, and clicking it again reuses the empty chat rather than
  spawning another pi. The chat gets its row once you send. (Not `sessionPath`: pi names the file when ready.)
- Sidebar layout (Codex-style): header with the logo and a hide button, "New chat" (⌘N), "Kanban" (⌘⇧K), "Laments" (⌘⇧L), "GitHub" (⌘⇧G) and "ATP" (⌘⇧A, with a count of running plans) rows, then a
  "Projects" title whose hover "+" opens a folder, then the folders. Resizable from its right edge (220-480px,
  never leaving the chat under 520px; double-click resets; dragging left of 120px snaps it collapsed, keeping the
  pre-drag width for when it reopens, and dragging back out in the same gesture reopens it), collapsible with ⌘⇧S (Codex's second binding; ⌘B is
  the browser here). Width and collapsed state persist in localStorage. Collapsed, the sidebar is `inert` (not `aria-hidden`, which
  Chromium blocks while a button inside still has focus). While collapsed, show-sidebar and
  new-chat buttons sit right of the traffic lights (x=88, y center 25, matching the lights) and the leftmost
  header gets `COLLAPSED_INSET` left padding.
- Sidebar order (`projectViews`): pinned projects first, in the order you pinned them (hover pin button; a pinned
  project keeps its pin visible, app-only state in localStorage), then the rest by latest activity: the index's
  file times, raised by messages you send from pi-gna so a chat and its project move up right away instead of
  after the run. Opening or switching chats must never reorder projects or chats (opening leaves the file
  untouched, and an opened chat closes again when you leave it, so "open chats first" made projects jump around).
- Sidebar marks: projects (cwd) -> sessions. Each chat's mark is the pi logo (`attention`): spinning while running, and
  one still logo color for what needs you: yellow (pulsing) waiting for you, coral failed (the run errored while you
  were not looking, or pi exited), blue finished but not seen yet. Idle chats get no mark; the highlighted row is
  the one you are in. Those three states also make the title bold, and a collapsed project shows its strongest
  mark. "Not seen" means the run settled while another chat was open or the app window was not focused (main
  reports BrowserWindow focus; `document.hasFocus()` would be false while you use the browser pane). It clears
  when you open the chat, or when the window regains focus with it open. Unread is in memory: a restart clears it.
- Transcript: a **run** is everything between two user messages. Your messages are right-aligned bubbles without
  an avatar, Codex-style; finished answers end with a Copy button. Times ("Yesterday 5:22 PM", full date in the
  tooltip) appear while hovering a message or answer; a centered time divider is always shown above the first
  message and above messages sent after a break of an hour or more, or on a new day (`needsTimeDivider`). Runs are separated by spacing. Each run splits (`layoutRun`) into a **work accordion**
  and the **final answer**: everything up to the last thinking/tool step (commentary, steps, notices) goes in the
  accordion, the text after it is the answer. Header: "Working for 13m 16s" (live) / "Worked for 22s", plus a
  tool summary ("Read 3 files · ran 2 commands"). It is open while working and closes itself once the answer is
  clearly streaming (message stopped, or over 300 characters, so short "Let me check…" commentary before the
  next tool does not collapse it) or the run ends. Your toggle is keyed per phase (working/done), so the answer
  still collapses it; closed while working, it shows only the active step. Each tool row expands to its details
  (bash output, edit diff, written file, read file, generic JSON); tool-result images render inline, and stay
  visible under a collapsed "Worked for" header. Ctrl+O expands everything (same key as the pi TUI).
- Thinking is shown in full inside the work, italic and muted like pi's terminal (no label, toggle or tail window);
  commentary between tool calls is normal (white) text, so the two stay distinct.
- Steering: queued messages sit in a card attached to the top of the composer (Codex-style). Steers say
  "Steering"; follow-ups (⌥⏎) have **Steer** to inject them now; each row has trash and "…" (edit in composer,
  send after the run instead). RPC can only clear both queues and append, so edits clear, transform
  (`applyQueueOp`, matched by text) and re-queue in order; images on re-queued messages are lost. A delivered
  steer is part of the running turn, shown as a "You steered" step in the work, not a new turn. Live, pi's queue
  says which messages were steers; sessions read from disk use the rule "a user message right after a
  tool-using assistant message is a steer" (true for every such message in 80 real sessions). Known gap: a steer
  delivered after a text-only answer (e.g. the second of two queued steers in one-at-a-time mode) shows as a new
  turn when the session is reopened.
- Scrolling (Codex-style, `useTurnScroll`): sending a message scrolls it to the top of the view and the answer
  streams in below. The newest turn gets a min-height of one viewport so that is possible even for short answers
  (sessions opened from disk keep their natural height until you send). Opening a session shows its end;
  "Show earlier turns" keeps your place; a ↓ button appears when content is below the fold. While a run is live
  the view follows it if you are at the end (`pinned`): opening a running chat, sending (your message at the top
  is the end until the answer outgrows the view) and ↓ pin; wheel up or any upward scroll unpins; scrolling back
  to the end re-pins. Following moves the view only when the content height changes, so it never fights the
  send glide, and it does not depend on scroll events (hidden windows get none).
- Turn rail (`TurnRail`, Codex's "user message navigation rail", read from the Codex app bundle's
  `thread-user-message-navigation-rail-app` chunk and its CSS): a 2px line per message you sent, vertically
  centered left of the transcript, shown from 4 messages on and only while the column leaves a 48px gutter.
  Lines are 6px at rest and 26px under the pointer, the three neighbours on each side magnified (0.7/0.4/0.2),
  Dock-style; lines of turns on screen (IntersectionObserver) are brighter. Hovering opens a 320px card with the
  message on one line, a bookmark button and the first three lines of the final answer (`railItems`, tables as
  fixed truncated columns). Click smooth-scrolls the turn to the jump position (`TOP_GAP`) and flashes its
  bubble; dragging scrubs instantly; ⌥↑/⌥↓ jump to the start of the current/previous or the next message
  (`adjacentTurn`; left to the caret while a text field has text). Turns on earlier pages are rendered first
  (`reveal`). Bookmarks are app-only state in localStorage, per session file, keyed by the message
  timestamp because item keys change on every load.
- Markdown: GFM via marked + DOMPurify, shiki highlighting, task lists rendered as styled boxes (the sanitizer
  strips `<input>`). pi-gna sessions get `--append-system-prompt resources/pigna-prompt.md`, which tells the
  model its replies render as Markdown here (tables, code fences, task lists; no remote images, HTML, math,
  footnotes or Mermaid). It only applies to pi-gna sessions; opening a terminal session in pi-gna adds that
  prompt section on its next request.
- Context meter (`ContextMeter`, Codex-style): a ring with the percent next to the send button; hover for a
  card with tokens in context / window, where pi auto-compacts (`contextWindow - reserveTokens`, read from
  `~/.pi/agent/settings.json` including per-model overrides; project settings are not read), cache hit
  (`cacheRead / (input + cacheRead + cacheWrite)` for the last request and the session), session token totals
  and Compact now. Colored by distance to auto-compaction (70% warn, 90% high), not to the window, because
  compaction is when context gets summarized. Stats refresh after every `turn_end` and `compaction_end`
  (`get_session_stats` takes a few ms even on a 40 MB session). Right after compaction pi does not know the
  size until the next response, shown as a dashed ring.
- Output speed (`TokenRate`, `lib/token-rate.ts`): tok/s beside the context meter, per response, from its first
  streamed block to its last (time to first token and tool runs do not count). Providers report output tokens
  only when a response ends (pi's `message_update` usage is not live), so while it streams the count is estimated
  from the streamed text, thinking and tool arguments (4 characters a token, shown as `~`), and `message_end`'s
  `usage.output` replaces it. The last response's rate stays, dimmed, after the run; responses read from a session
  file have no timings, so they show none.
- Compaction visibility: `compaction_start` adds a running transcript record; `compaction_end` updates that
  same keyed record to completed, failed or interrupted. Show one live indicator with elapsed time in the
  chat, including manual compaction outside an agent run; do not repeat it above the composer or beside the
  work header. Compaction records remain visible when work is collapsed; successful summaries expand on
  click. `tokensBefore` means **tokens before compaction**, not tokens summarized. Ready-state recovery and
  hydration retain active compaction; exit/settle clear pending spinners, and delayed ready snapshots cannot
  resurrect a finished compaction. Preview chats must not be disposed while compacting. Summarization retry
  events update the active record (waiting/retrying), separately from model `auto_retry` events;
  branch-summary retries do not start a compaction indicator. Stop/Esc aborts manual compaction through
  the same RPC action as an agent run. Pi still owns all compaction behavior.
- Live state: the loader is the pi logo with its three colors sweeping around the glyph (`PiSpinner`); it marks
  the "Working for" header, running tool rows and running chats in the sidebar. Waiting-for-you stays an amber
  dot, exited red, idle green. "waiting for you" or model "retrying" are called out next to the header;
  compaction has its own single inline record.
- Prompt bar: Enter sends (steers while running), Alt+Enter queues a follow-up, Esc clears the queue and aborts,
  `/` commands from `get_commands`, `@` files, model and thinking pickers, image paste.
- Composer: always at least 2 lines tall (like beautifului.dev's Chat composer). A soft blurred glow in the pi
  logo colors mixed with grey sits behind it, and its hairline border is grey with faint logo tints. On focus the
  border brightens (beautifului.dev's only focus change, measured: `line` -> `line-strong`) and becomes a slowly
  flowing coral/grey/blue/yellow gradient with a stronger glow (the Gemini-like part, ours). `.composer*` in
  `styles.css`; motion stops with reduced motion.
- `.prose` (Markdown) is plain CSS in `styles.css`, outside Tailwind's layers, so it beats any utility: a
  `text-[13px]` on a wrapper or `[&_.prose]:` variant does not resize it. Size it with a contextual rule beside it
  (`.thinking .prose`, `.lament-report .prose`).
- Attachments (Codex-style, verified against the Codex app bundle): "+" menu with "Add photos" and "Attach files
  and folders" (⌘U, native picker with files and folders), drop anywhere on the session pane, ⌘V. Files and
  folders are sent by path in a `# Files mentioned by the user:` block of `## name: /path` lines (pi reads them
  with its tools); images also go as image content (pi resizes them, `images.autoResize`). Dropped/pasted Files
  get their path through `webUtils.getPathForFile` in the preload; in-memory clipboard images are read at paste
  time. The transcript folds the block back into path chips (`splitFileMentions`).
- Empty state: the painted sky (see Visual language) above "What should we build?" and the project path; no
  suggestion chips (nobody used them). Only for chats that are really empty: a chat opened from the sidebar is
  shown before its file is read, so until then it is `loading` (blank transcript, the sidebar's title), never the
  empty state, which would flash while clicking through chats.
- Extension UI: `select`/`confirm`/`input`/`editor` become approval cards above the composer; `notify` -> toast;
  `setStatus` is tracked in session state but not shown (there is no status line); `setWidget` -> panel above the composer; `set_editor_text` -> composer text.

## Visual language

Inspired by beautifului.dev (no code copied; it has no public source or license): dark neutral surfaces
(~#1b1b1d), hairline borders, dashed dividers, system sans, mono only for code, paths and numbers, no eyebrow labels (small uppercase captions), muted grays, one blue accent,
light and dark themes, the pi-logo spinner with shimmer text, compact chips that expand.
Empty states sit on a painted 🤌 raised into a dusk sky (`assets/pigna-dusk.webp` dark, `pigna-day.webp` light;
Shinkai-style with a halftone texture, generated with GPT Image 2.5 and outpainted to 16:9 with the hand centered),
masked into the canvas above the text and composer. The spinner and the sidebar's state marks stay pi's pixel
logo in its coral/blue/yellow: they show pi working.

Brand: **pi-gna** (Italian *pigna*, the 🤌 "mano a pigna" gesture). The logo is 🤌i: Twemoji's pinched fingers
(CC-BY 4.0, credited in the README and About panel) mirrored and turned 90° (`matrix(0 -1 -1 0 36 36)` in its
36-unit box) so the hand reads as a P, then a white "i". Written out it is always `pi-gna` (package, bundle,
repo, docs); the 🤌i mark is visual only (sidebar header, icon). `resources/icon.svg` is the icon's source: dark
tile with blurred coral, blue and yellow glows in the corners; `pnpm icon` rasterizes it to `resources/icon.png`
(dev Dock icon) and `build/icon.icns`. `assets/pigna-hand.svg` is the same hand cropped for the UI.

## Verifying the UI

`scripts/cdp.mjs` drives a running app over CDP (screenshots, eval, typing, keys; it finds the `app://pigna` page); start it with
`node bin/pi-gna.mjs --remote-debugging-port=9333`. Give test instances `PIGNA_USER_DATA=/tmp/<dir>`, `PIGNA_BACKGROUND=1` (opens without taking focus; a
focused test window once swallowed the user's typing) and their own port, so they never share a profile, focus or
debugging port with the pi-gna you work in, and stop them by their PID, never with
`pkill -f bin/pi-gna.mjs`: the agent doing the testing may itself be running inside a pi-gna session, and a
pattern kill takes down the user's app and the agent with it. The main process is the one listening on the debugging
port (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`); `--user-data-dir` is only on its helpers, and a launch while it still
runs just opens a chat in it (old build and all). Check that the port is free first: other agents run test instances
too, and on a taken port Electron only logs "Cannot start http server for devtools" and runs without one, so
`scripts/cdp.mjs` would drive the other agent's window. `PIGNA_PI_BIN` can point at a wrapper that adds
`-e <extension>` (for example pi's `examples/extensions/rpc-demo.ts`) to exercise every extension UI method.
Chromium pauses `requestAnimationFrame` while the window is occluded, so the store also flushes on a 250 ms timer.
The same starvation hits CDP tests of background windows: mouse moves are dispatched with the next frame (hover
and IntersectionObserver lag until one is drawn), and a `drag` blocks waiting for frames. Force frames by taking
screenshots (`shot`) after a `move`, and in a parallel loop while a `drag` runs.
Background test windows are `document.visibilityState === "hidden"`: smooth scrolls never move, scroll events do not
fire, and CDP mouse/wheel input waits for a frame (one wheel notch took 38 s). Test
scroll logic by simulating the gesture in `eval` (dispatch `wheel`, set `scrollTop`, dispatch `scroll`) and stub
`Element.prototype.scrollTo` to `behavior: "auto"` where a glide matters. `scripts/fake-pi.mjs` (via
`PIGNA_PI_BIN`) streams a long answer to every prompt, for streaming UI checks without a model. For board checks, seed
`$PIGNA_USER_DATA/board.json` (`{ "version": 1, "cards": [...] }`) with cards of a throwaway git project under `/tmp`
(give cards its real path, `/private/tmp/…`: the launch cwd is resolved, so `/tmp/…` cards sit on another board):
the board's project picker lists every project with cards, and card actions then start fake-pi chats there. Tests with the real
pi write real session files: pi 1.0.0 ignores `PI_CODING_AGENT_SESSION_DIR` (only pi-gna's index reads it), so run
them in a throwaway project under `/tmp` and delete its folder in `~/.pi/agent/sessions` afterwards.
Your pi-gna may run from this checkout's `out/`, and other chats may build there too: test a change from a build of its
own (`npx electron-vite build --outDir /tmp/<dir>/app/out`, copy `package.json` and symlink `node_modules` and
`resources` into `/tmp/<dir>/app`, then start `$(node -e 'console.log(require("electron"))') /tmp/<dir>/app` with the
test-instance env). Set `PIGNA_CWD` in that env too (`PIGNA_CWD=/private/tmp/<project>`, or `env -u PIGNA_CWD`):
an agent's shell inherits it from the pi-gna session it runs in, so a test instance otherwise opens the agent's
own project (this repository) instead of the throwaway one. A pasted screenshot is a File without a path: dispatch `new ClipboardEvent("paste", { clipboardData })`
with a `DataTransfer` holding a canvas `File` in `eval`, so the test does not touch your clipboard; `drop` covers
Finder files.
Browser tabs are separate CDP targets: `CDP_URL=localhost:8765 node scripts/cdp.mjs shot` captures a tab, and
`click x y` sends real mouse input (useful for driving the annotation picker), `rightclick x y` right-clicks, `drag x1 y1 x2 y2` drags (resize
handles), `shot <path> x y w h scale` captures a close-up, and `CDP_FOCUS=1` emulates window focus so `:focus`
styles render in a background test window; `CDP_SCHEME=light|dark` renders the other theme for that command. CDP screenshots of the app window
do not include native tab views. `type … --enter` goes to whatever has focus, and a test instance starts in a new
chat: check `document.activeElement` first, or the text is sent to a model as a prompt.
CDP `shot` hung on background test windows (a packaged build, and a dev build after a few page switches) even
though `requestAnimationFrame` ran;
`screencapture -x -o -l <CGWindowID>` captures that window instead (the id is `kCGWindowNumber` from
`CGWindowListCopyWindowInfo` for the app's pid, for example through `osascript -l JavaScript`).
Native menus open on the real screen, where CDP cannot reach them: start the test instance with `--inspect=9334`
as well, and `node scripts/cdp.mjs menus` makes its `Menu.popup` record menus instead of showing them (and lists
what it recorded), `menu "Copy Image"` clicks an item of the last one, and `main "<expr>"` evaluates in the main
process with `require` (for example to read the clipboard). Save the user's clipboard before an item writes to
it and restore it afterwards.

Electron drag regions: `-webkit-app-region` rects are applied in document order, so a `no-drag` element that
overlaps a `drag` header must come later in the DOM (or be its descendant), or real clicks start a window drag.
CDP clicks bypass the OS drag layer, so tests cannot catch this; check DOM order instead.

Build notes: Electron 44 has no postinstall; it downloads its binary on the first `require("electron")`, which then
also prints "Downloading Electron binary..." on stdout: in a fresh worktree, run `node -e 'require("electron")'` once
before launching with `$(node -e 'console.log(require("electron"))')`, or the launch gets that line as the path.
Electron 44's `clipboard` is asynchronous and `ClipboardItem`-based (`read`, `write`, `readText`, `writeText`;
no `readImage`/`writeImage`).
electron-vite 5 does not minify the renderer unless `build.minify` is set. Sandboxed preloads must be CommonJS.
The checks are `pnpm typecheck` and `pnpm test`; the repo has no formatter or linter config (`npx biome` fetches an
unrelated npm package). To build and test without rewriting the `out/` a running pi-gna reloads from, build with
`npx electron-vite build --outDir /tmp/<dir>/out`, give `/tmp/<dir>` a copy of `package.json` and symlinks to
`resources`, `src` and `node_modules`, and launch Electron (`node -e 'console.log(require("electron"))'`) on it.

## Milestones

1. **Core (done):** RPC bridge, terminal logs, transcript with streaming, thinking and tool groups, prompt bar, sessions
   sidebar, approval cards, steer/follow-up/abort.
2. **Browser (done):** `WebContentsView` tabs with a persistent separate profile, address bar and history, split/full view,
   agent `browser_*` tools via a pi extension loaded with `-e` that calls a token-gated localhost bridge (CDP through
   `webContents.debugger`), annotation mode whose comments attach to the next prompt. Stagehand tools are excluded in
   pi-gna sessions; localhost is allowed, other sites ask once.
3. **Kanban (done):** a board per project of task cards that chats attach to, `kanban_*` tools for agents to take,
   move and report on their card, and card actions that start chats (investigate, resolve, chat about it).
4. **Polish:** session tree, changed-files review, Cmd-K, usage insights, selection actions, Adjust panel,
   dictation, task rows for subagents and workflows.
