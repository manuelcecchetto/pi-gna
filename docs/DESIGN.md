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
    browser/       BrowserManager (WebContentsView tabs), BrowserAgent (CDP actions), preview-protocol (the pigna-file:// scheme: token registry and handler for file previews)
    computer/      ComputerService (installs, launches and talks to the native helper), ComputerAgent (policy, approvals, per-app locks), ComputerStore (userData/computer-use.json)
    board, kanban  BoardStore (userData/board.json) and the kanban_* tools' route
    laments        LamentStore (userData/laments.json) and the lament tool's route; both stores are a JsonStore (store)
    github         Github: a project's repository and gh account, its issues and PRs through gh (userData/github.json: logins only)
    atp            Atp: a project's ATP plans (watch, scan), the librarian CLI (claim, release, activate), commits, holds
    settings       SettingsStore (userData/settings.json: features, theme, task models); pi-settings writes pi's settings.json
    pi-auth        PiAuth: provider logins (pi's /login) through resources/pi-auth.mts, run with pi's SDK
    app-protocol   serves the built renderer on app://pigna with a strict CSP header
    visual-protocol / visual-frame   the pigna-visual:// scheme for inline-visual frames (own CSP), and the frame process kill (Visuals)
    shell-env      Finder/Dock launches: imports the login shell's environment (PATH for pi/node/rg, API keys)
    remote         RemoteHost (server lifecycle, keep-awake, Tailscale), RemoteServer (paired-device HTTP/SSE), HostCore (one method table for IPC and remote), EventHub, PushService (see Remote access)
    updater        checks GitHub releases, downloads and stages a newer build, swaps it in when pi-gna quits
    window-state   the main window's bounds and zoom (userData/window-state.json), restored only if they fit a connected display's work area, else the primary work area
  preload          typed contextBridge API (window.studio)
  renderer         React + Tailwind v4
  src/mobile       the phone's web app (PWA), served by RemoteServer from out/mobile
  src/preview      the file-preview viewer (markdown, docx, code, csv, image chrome...), built to out/preview and served by pigna-file://
resources/browser-extension.ts   pi extension loaded with `-e` into every pi-gna session: browser_* tools
resources/computer-extension.ts  the same for the computer_* tools, only while Computer Use is enabled
resources/kanban-extension.ts    the same for the kanban_* tools
resources/lament-extension.ts    the same for the lament tool
resources/atp-extension.ts       ATP orchestrator chats only: atp_pause, atp_resume
resources/atp/                   the ATP roles' system prompts and the vendored ATP skills (architects, librarian CLI)
resources/pi-auth.mts            login helper run by the PATH `node` with pi's SDK (see Settings, Providers)
native/computer-use/            Swift source of the helper app `pi-gna Computer Use.app` (built by `pnpm build:computer-use`)
resources/pigna-visual-prompt.md  the agent's instructions for inline visuals (kit vocabulary, when to draw one)
resources/visual-extension.ts    loaded only while Inline visuals is on: adds that prompt to the project context (AGENTS.md block)
resources/visual/                doc.html (frame shell), kit.css, kit.js (bundled visual kit), gallery.html (every component, for eyeballing)
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
  the sidebar header (`--pigna-version`, `StudioApi.version`). Before cutting a release, compare `git tag -l` with
  `git ls-remote --tags origin`: a cut whose push failed (v0.9.1 sat unpublished for a day; the active GitHub account
  could not push) stays local. Push pending tags one at a time and let each release.yml run finish, since the
  release that finishes last becomes GitHub's Latest, which the updater and the website's download links follow.
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
- **Computer Use helper.** `pnpm dist` runs `build:computer-use` first (Swift, universal; plain
  `pnpm build` and `pnpm dev` never need Swift). electron-builder copies `build/computer-use/pi-gna Computer Use.app`
  to `Contents/Resources/computer-use/` via `extraResources` (outside the asar); a checkout reads
  `build/computer-use/`. release.yml builds it, verifies it with `codesign --verify --deep --strict` and fails
  the release if the packaged app lacks it. A missing helper surfaces as `app_not_found` on the Computer Use page.
- **Signing.** There is no Developer ID certificate, so builds are ad-hoc signed (`identity: "-"`, no hardened
  runtime, no notarization) and macOS asks once before opening a downloaded build (README). The one exception is the
  Computer Use helper: macOS checks its Accessibility and Screen Recording grants against the designated requirement
  recorded when they were given, and an ad-hoc requirement is one build's cdhash, so every helper update silently
  voided them (System Settings still showed them on). release.yml imports a self-signed certificate from the
  `SIGNING_CERT_P12`/`SIGNING_CERT_PASSWORD` secrets (made once by `scripts/make-signing-cert.mjs`; the key lives in
  `~/.config/pi-gna/signing/`), trusts it for code signing on the runner and passes it to `build:computer-use` as
  `PIGNA_SIGN_IDENTITY`, which makes the requirement `identifier "…computeruse" and certificate leaf = H"…"`, the
  same for every release. Users' Macs never trust the certificate and need not: `codesign --verify --deep --strict`
  and TCC only check the signature against the requirement. `mac.signIgnore` stops electron-builder re-signing the
  helper ad-hoc (it otherwise signs every binary in the bundle); release.yml fails if the helper is not
  certificate-signed or its requirement changed in packaging. Replacing the certificate resets every user's grants
  once. Checkouts without `PIGNA_SIGN_IDENTITY` build an ad-hoc helper. Squirrel.Mac
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
  `pnpm dlx @electron/fuses read --app "dist/mac-arm64/<name>.app"`. Cookie encryption uses Chromium's mock keychain
  (`use-mock-keychain`, a fixed key) rather than a Keychain item: an ad-hoc signature changes with every build, so
  macOS asked for "pi-gna Safe Storage" again after each update. The browser profile's cookies are therefore only
  as private as the profile folder. Only packaged builds encrypt cookies (the fuse), so check this on an
  `electron-builder --dir` build, not `pnpm dev`.
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

**The browser belongs to a chat.** Every tab has an owner (`BrowserTab.agent`, the chat that opened it, the user's own tabs included).
Main keeps all tabs; the renderer tells it which chat is on screen (`browser.focus`) and main draws and addresses only that
chat's tabs, remembering each chat's last tab. The renderer scopes `state.browser` to the active chat (`scopeBrowser`) and keeps
the pane (open/full), and the browser comments, per chat; a page (Kanban, Settings, ...) hides the pane. An agent acting in a chat
that is not on screen keeps working (its view is held while it acts) and opens that chat's pane for when you return. A chat's
tabs close when its session ends. The phone still lists every chat's tabs.

- **Tabs** are `WebContentsView`s in the persistent partition `persist:pigna-browser` (separate cookies and
  storage from the app; no camera, mic, location or notifications). The renderer draws the tab strip and toolbar
  and reports the viewport rect (`browser:layout`); main attaches the active tab's view over it. Native views
  paint above the DOM, so the renderer hides the view while a DOM overlay must cover it (address suggestions,
  image lightbox, the Kanban card dialog and menus); it first takes a still of the page (`browser:still`) and shows
  that in its place, so the page does not blank out behind a menu. History lives in `userData/browser-history.json`.
- **Tab icons** (`main/browser/favicon.ts`): on `page-favicon-updated` main fetches the page's own icon through the
  tab's session (so local dev servers get theirs; inline `data:` icons are decoded without the network), shrinks
  bitmaps to 32 px with `nativeImage` (SVG and undecodable ICO stay raw up to 32 KB) and puts the data URL in
  `BrowserTab.favicon`; a navigation to another origin drops it. Without one, public sites fall back to the chat-link
  icon service (`site-icons.ts`). The strip shows it instead of the globe, and instead of the agent's icon unless the
  agent is driving the tab right now; the phone shows it too.
- **Agent tools**: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`,
  `browser_screenshot`, `browser_evaluate`, `browser_console`, `browser_viewport`, `browser_window`. The extension calls `POST /browser` on a
  loopback HTTP server; each pi process gets its own bearer token (env `PIGNA_TOKEN`), and the token, never
  the body, decides which session acts. Each session drives its own tab (or adopts the one you are looking at),
  and its actions run through a per-session queue, because a page is sequential.
- **Call order**: every browser tool is `executionMode: "sequential"`, so pi runs a message's tool calls in the order
  the agent wrote them (by default it runs them in parallel). Ordering by arrival at the bridge is not enough:
  `browser_open` checks the URL policy before its request, so a `browser_screenshot` sent in the same message
  overtook it and captured the previous page (verified with gpt-5.5 issuing both in one message; a unit test keeps
  every tool sequential). `browser_viewport` resolves after the reload a new User-Agent causes.
- **Evaluate** uses CDP `Runtime.evaluate` in REPL mode (like the DevTools console: top-level `await`, `const`
  redeclared across calls, the last statement's value); an object result goes through `Runtime.callFunctionOn`,
  which awaits a returned promise and serializes it. `executeJavaScript` ran a classic script, where `await` is a
  syntax error that Electron reports only as "Script failed to execute".
- **Input and screenshots go through CDP** (`webContents.debugger`), not `sendInputEvent`/`capturePage`: those
  need composited frames, which Chromium stops producing while the app window is hidden behind other windows
  (verified: the click did nothing and capture failed with "Current display surface not available").
- **Snapshots** run in an isolated world (shared DOM, separate JS globals) and tag interactive elements with
  `data-pi-ref` numbers that click/type use.
- **Policy** lives in the extension: loopback and `*.localhost` URLs are allowed; any other origin asks once per
  session through `ctx.ui.select`, which renders as a pi-gna approval card (with Yolo on, `SessionHost` allows it
  without a card; see Computer Use's policy). Actions that navigate are re-checked afterwards and stepped back if
  denied. Stagehand's `run`, `snapshot` and `screenshot` are excluded with
  `--exclude-tools` (override with `PIGNA_EXCLUDE_TOOLS`). The extension imports `src/shared/browser.ts`
  directly (pi loads extensions with jiti and aliases `typebox`).
- **Annotations**: comment mode injects a picker (isolated world, closed shadow root) into the active tab, a web page
  or a rendered Markdown/HTML preview (the preview's toggle sits in the tab strip). A long-pending promise resolves
  with the element (selector, label, HTML, box and viewport, key computed styles), the comment and the button: **Add**
  (Enter) keeps it as a composer chip for the next prompt, **Send** (⌘Enter) adds it and sends the chat's comments at
  once (`browser.annotation` with `send`; empty text, steering a running chat; the composer's draft stays). Main crops
  the element and, on a preview, swaps the token URL for the file path and line (`annotation-source.ts`: the Markdown
  viewer's `data-source-line` blocks, or a rendered HTML file's tag matched by id or by index when the page and the file
  have as many of that tag). The prompt carries a `<browser-comments>` block (`formatAnnotations`) plus the crops.
- **Responsive viewport and device windows**: a tab can emulate a device (measurements and rejected options in
  `docs/RESPONSIVE_BROWSER.md`).
  - *Mechanism*: CDP on the tab's debugger sets metrics (size, DPR, `mobile`, screen), touch emulation and the
    User-Agent together; Electron sends no `Sec-CH-UA*` headers, so a session `onBeforeSendHeaders` hook adds them
    for emulated tabs. Only mobile presets change the UA; Laptop and Desktop keep the native one. A spec keeps its UA
    profile through edits: the Dimensions bar sends it (`ViewportRequest.userAgent`) and pop-out moves the spec as is,
    so a rotated iPhone stays an iPhone and a Pixel stays Android (re-deriving it from the width made them an iPad and
    an iPhone). Emulation survives navigation, reload and renderer crashes, so it is applied once and re-applied only
    on debugger detach.
  - *Shared math*: `src/shared/viewport.ts` (presets, `resolveViewport`, clamping to 200-3840 px and DPR 1-4,
    `fitViewport`, `toInputCoords`, UA profiles) is used by main, renderer and the extension. A viewport larger
    than the pane is shown with CDP `scale` (fit), never clipped: the view is `size*scale`, centred in the pane;
    CDP input takes scaled coordinates, so the agent's click passes its CSS px through `toInputCoords`. Under touch
    emulation it taps (`Input.dispatchTouchEvent`): with `setEmitTouchEventsForMouse` on, a `mousePressed` is never
    acknowledged, and the hung call wedged every later browser tool of that chat.
    Screenshots (`Page.captureScreenshot`) stay emulated size x DPR.
  - *Persistence*: the spec lives per tab in `BrowserManager`, not in the agent session. Releasing control or
    ending a run does not clear it; only the user's Reset / Responsive or closing the tab does. When pi set it the
    Dimensions bar stays visible with a "Set by pi" badge (a user change removes it). Neither side needs approval:
    it is not a navigation.
  - *Who*: the user through the Dimensions toolbar (presets, width x height, DPR, rotate, mobile, pop-out);
    the agent through `browser_viewport` (set, read, reset; preset, width/height, aspect with one edge, dpr,
    mobile, orientation) on its own or an adopted tab.
  - *Windows*: `browser_window` (open, list, close) or the user's pop-out put a tab in a `BrowserWindow`
    (`showInactive`, content size, `setAspectRatio` when an aspect was asked) with the same emulation. At most
    4 are open at once (`WINDOW_LIMIT`; the next is refused). A window cannot exceed the display work area, so a
    larger request is emulated at full size inside a smaller window. Its title follows the spec. An open whose page
    fails to load closes its window again before throwing, so it never holds a slot. Closing a window closes its
    tab; "Return to pane" is the way back. A session's windows close when it ends. Never minimize them: captures hang.
  - *Codex lessons*: Codex's iPhone preset left the HTTP UA alone, so SSR served the desktop page
    (openai/codex#35576): we switch viewport, DPR, touch and UA together. Its agent-set viewport was lost when the
    agent released control (#35756, #34335): ours persists with a badge.
  - *Electron gotcha*: `Emulation.setDeviceMetricsOverride` on a view that never navigated crashes the main
    process (Electron 44.5.1, macOS), so `BrowserManager.emulate` loads `about:blank` first.
  - Verified end to end by `pnpm verify:responsive` (real built app, local fixture server).
  - *Phone browser (T36)*: `src/mobile/Browser.tsx` streams a tab (`GET /api/browser/view/<tab>`, see docs/REMOTE.md) with the window hidden by holding its view in an invisible second window (`BrowserManager.hold`); a viewport-less tab is parked at 1280x800. Pop-out windows are host-only: the phone lists them as tabs marked "window".

### File preview

A file preview is an ordinary browser tab (same strip, activation, pop-out, agent tools, DevTools and phone stream) that
loads `pigna-file://<token>/<path>`. Full decisions, spike evidence and limits: `docs/FILE_PREVIEW.md`.

- **Scheme and tokens**: `pigna-file` is registered in the one `registerAppScheme()` call (`standard`, `secure`,
  `supportFetchAPI`) and handled only on the `persist:pigna-browser` session (`servePreview`). Main mints a random
  128-bit token per preview root (the project directory when the file is inside it, else the file's directory); the
  token is the only capability, lives in memory, and is revoked when the last tab of the root closes.
- **Kinds**: PDF, HTML and media bytes are served raw (Range supported; Chromium's own PDF viewer, no pdf.js). Everything
  else (markdown, docx, pptx, xlsx, code/text, json, csv, images, media wrapper, info card) loads the bundled viewer from
  `src/preview` (separate Vite build, `vite.preview.config.ts` -> `out/preview`; Office files paint on canvas with the
  BetterOffice wasm engines, docs/FILE_PREVIEW.md "Office formats"),
  which fetches the bytes from the same origin with `?raw=1`. Rendered/Raw toggles per tab (`?view=raw`).
- **Security**: file contents are untrusted. The viewer gets a strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no network), no preload
  and no Node; markdown goes through DOMPurify; SVG is shown through `<img>`. The handler realpath-confines every request
  to its root, denies dotfiles and directories, and `BrowserManager` cancels navigation and popups to the scheme from any
  tab that is not itself a preview, because Chromium only blocks `fetch` reads, not img/iframe/navigation, from a web tab.
  Rendered HTML runs like a web page and is never auto-opened.
- **Live reload**: main watches the opened file and reloads the tab (150 ms debounce, scroll kept).
- **Entry points**: file links and bare paths in chat and tool details, the address bar (paths and `file://`), Open
  file... (start page), drag and drop onto the pane, and the agent's `browser_open` with a path, all through
  `BrowserManager.openPreview` (`browser.preview` in `host-core.ts`). The tab's `preview` field carries the real path, kind and mode.
- **Start tabs**: `+` (and `browser.newTab` without a URL) opens a start tab (`BrowserTab.start`), not a blank web page:
  like a card tab, its native view stays hidden and the renderer draws `StartPage`, modelled on the Codex app's new tab:
  the address bar focused, a Tools grid (Files ⌘P, Open file... ⌘O, New page (about:blank), then the enabled pages
  with their menu shortcuts, the rest behind More tools) and Suggested (recent localhost URLs). Files is `FileFinder`, a
  folder picker over the chat's project files (`listFiles`; folders are derived from the file paths in `lib/file-tree.ts`,
  so the shared list stays files-only for the composer's @ menu): it browses one folder at a time (folders first,
  breadcrumbs, Backspace in an empty search goes up) and typing fuzzy-searches the files and folders below it; ⌘P (`showFileFinder`) opens it in the active start tab or a
  new one. Whatever is picked fills that tab: a URL goes through `navigate` (`BrowserManager.load` clears `start`), a file through `openPreview` with
  `into: <tab id>`, which only accepts a start tab. Closing a chat's last pane tab (user, agent or pop-out to a window) closes its pane (`emptiedPanes` in `syncBrowser`); ⌘B on an empty pane opens it with a start tab.
- **Verified** end to end by `pnpm verify:preview` (after `pnpm build`).

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
- **Key focus**: keys and Paste go to the app's keyboard focus, which a click does not always move: a web view
  embedded in a background window (an Office add-in task pane) takes the click and claims `AXFocused`, while Word
  keeps routing keys to its document and reports no focused element. So the helper remembers the text element the
  agent last clicked (element or x,y hit-test), selected in or set, and `type_text`, `press_key` and `paste` send
  nothing and fail with `background_unsupported` (cause `key_focus_elsewhere`) unless the app's focused element is
  that element, inside it, or a text element at the same spot (after trying `AXFocused`). Focus that the agent's own
  keys move (Tab) becomes the new target; with no text target, keys go as before. Results name the element the keys
  went to (`target`). Text for such panes goes in with `set_value`. The fixture's web pane covers this in
  `scripts/computer-use-smoke.mjs --fixture`.
- **Policy** lives in main (`ComputerAgent`), not the extension, because `bash` inherits `PIGNA_TOKEN` and could call
  the bridge. Off by default (`enabled` in `userData/computer-use.json`, switch in Settings). Terminal apps, pi-gna,
  the helper and macOS security prompts are never operable (403, not listed, not launched), whatever was approved.
  Any other app asks once per chat with a card in the renderer: **Allow once** (until the run ends), **Always allow**
  (persisted, listed and revocable in Settings > Computer use) or **Deny** (remembered for the chat). A second chat
  asking for an app another chat is driving gets 409 without an approval card. Run end, chat close, Stop and Esc
  release the chat's apps and its Allow once grants. **Yolo** (`yolo` in `userData/settings.json`, Settings > Agent,
  switchable from the desktop only) answers approvals in `SessionHost`, read at each one so open chats follow it:
  main's choices (`requestChoice`) and pi's `confirm`/`select` dialogs get their first Allow/Approve/Yes option
  (`yoloOption`, so Allow once, never Always allow) or a yes, with no card; selects without one and inputs still
  ask. The denylist and a chat's earlier Deny still apply. Phones answer the same cards (first answer wins) and get a
  read-only `computer.preview` (one JPEG of an app the chat holds, 1/s per client; `ComputerAgent.preview`); operating
  Mac apps from the phone is a non-goal (docs/REMOTE.md section 8).
- **Overlay and Esc**: per driven app the helper shows a yellow-glowing pigna hand cursor, coral/yellow/blue
  click ripples, an outward-glowing window frame and a glowing pill ("pi is using App · Esc to cancel"). Three
  click-through, nonactivating, capture-excluded windows stack target → frame → cursor → pill; whatever covers
  the target also covers them. Reduce Motion keeps static glows and fading click feedback, without cursor travel,
  ring expansion or breathing/flow animations. Cursor travel is planned once per move as timed samples
  (`Motion.swift`, a port of Cua Driver's six motions: signature_arc, spring_settle, magnetic, comet_swoop, adaptive,
  classic; MIT) and played by a 120 Hz main-run-loop timer that moves the cursor window and leans the hand (at most
  30°, drawn around the fingertips: `frameCenterRotation` drifts the tip off the hotspot). Moves take about 0.3-1.3 s
  by distance and element size (Fitts); the action waits only until the tip arrives, a settle keeps playing. The style
  is `cursorMotion` in the Computer Use policy (Settings > Computer use), sent with `overlay_show` as `motion`.
  The fixture smoke checks successive click positions and overlay stacking.
  For a visual check, `node scripts/computer-use-overlay-preview.mjs [parentDir] [motion]` builds a standalone preview and
  saves idle/ripple/moved/mid-glide PNGs in a new unique subdirectory (requires Screen Recording). Only the preview makes
  overlays capturable; it does not install or replace the helper. A global Esc monitor counts only when the user
  is evidently looking at that run (the app or pi-gna is frontmost, or the pointer is over the window); it hides the
  overlay and notifies main, which stops the run.
- **Permissions and install**: the helper needs Accessibility and Screen Recording (Settings > Computer use, Cmd+Shift+U
  or View > Computer Use, shows both and opens the panes). Grants are tied to the helper's designated requirement
  (Packaging and release, "Signing"): stable across releases, new on every ad-hoc checkout build. When main installs
  a newer helper whose requirement differs from the installed one, it runs `tccutil reset Accessibility|ScreenCapture
  io.github.manuelcecchetto.pigna.computeruse`, so macOS asks again instead of showing a switch that is on but no
  longer applies; the same command clears stale entries by hand. macOS 26
  never prompts for Screen Recording from the helper (tccd: "kTCCServiceScreenCapture does not allow prompting;
  returning denied") and the pane does not list it, so that row's Request opens the pane and reveals the installed
  helper (`~/.pi-gna/computer-use/`) in Finder to add with **+** or drag in. A release that does not touch `native/computer-use/` keeps `helperVersion`. macOS 26 may
  also show a one-off "bypass the system private window picker" prompt on the first screenshot; choose Allow.
- **Known limits**: the focused (main) window of an app only, so a multi-window app always acts on that window and,
  with every window off screen, a read falls back to another window of the app; minimized or other-Space windows
  fail with `background_unsupported`. Canvas and game apps that read only HID events cannot be driven. Background
  input relies on private SkyLight SPI and may break on a macOS update. Screenshots and AX text go to the model
  provider (secure field values are never read). Action-time confirmation is a prompt rule, not enforced in code.
  Verified live below the UI (real helper, agent and store with an approval stub: TextEdit and Calculator in
  parallel, approvals, refusals, no change to frontmost app or cursor); the real-chat path and the Esc key still
  need a manual check (if Esc does nothing, grant Input Monitoring to the helper too). The long spec and
  its evidence notes are in git history (`docs/COMPUTER_USE.md`).

## Kanban (M3)

- **One board per project** (cwd). Cards are tasks (title, notes, tags, column, attached chats, reports), not threads: a
  chat can be on several cards and a card can have several chats, but a chat only joins cards of its own project.
  The chat header and menus show the card it joined last (`cardOfChat`); `kanban_update` takes a card id and needs
  one only when the chat is on several cards.
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
- **Chat tasks run on the host** (`src/main/chat-tasks.ts`, `ChatTasks`; methods `chat.startTask`, `board.addCard`,
  `chat.send`): the chat a card's triage, Investigate, Resolve or QA, a lament's Fix or a pull request's Review starts
  is set up in main, so it works from any client and with no window. `start` opens the chat under a host lease
  (`SessionHost.open`'s `hold`, so it survives a closing window), waits for pi (`get_state`), puts it on the card or
  lament by its session file (`board` `attach`, lament `fix` with the branch), switches the model (`pickModel`,
  `set_model` + `set_thinking_level`), sends the prompt and names the chat; it returns `{ handle, snapshot, notices }`
  (the notices are the toasts: what it works on, the worktree's dirty warning, a model that is not available). The
  lease ends when the chat's first run settles (`SessionHost.onSettled`): a triage (`closeWhenDone`) that ends well
  and that no client is viewing closes; any other, or a failed one, stays open, marked unread. The desktop calls
  `studio.startTask` / `studio.addCard` and joins the chat (`adopt`); the prompts and names are pure functions in
  `src/shared/task-prompts.ts`. `addCard` adds the card, saves its images, lists them in the notes and starts the
  triage without waiting for it. "Chat about it" stays client-side (the composer chip); `chat.send` composes the
  card's block host-side from a `cardId` (attachments and annotations follow with the phone's uploads); the desktop
  still composes its own send. ATP workers start through the same setup (`ChatTasks.launch`).
- **Card actions** (`state/card-actions.ts`, `registerCardAction`) fill the right-click menu, the card's "…" button
  and its dialog. Investigate, Resolve and QA start a chat in the background (you stay on the board; `startCardTask`
  keeps `AppState.cardTasks`: the card, its menu item and its dialog button show "Starting …" while main sets the chat
  up, which a worktree makes take seconds, then "… started" for a moment; asking again while it starts does nothing,
  so a double click starts one chat; the phone's card page disables its button the same way; a lament's Fix and a
  pull request's Review go through the same `trackStart`, kept in `AppState.taskStarts` by `taskKey`), attach it when
  pi is ready (a new chat's session file is named before anything is written) and only then send the prompt, so
  the agent's first `kanban_update` finds its card; `set_session_name` names it "Investigate: …". QA (cards in
  In review, `qaPrompt`) reviews, tests and tries the change without fixing it, leaves a passing card in review and
  moves a failing one back to In progress. It runs where the change is: the card's worktree when a chat on the card
  worked in one (`hasWorktree`; `cardWorktree` in main reuses it or brings back the card's branch), else the project folder,
  since a new worktree from HEAD would not have the change. "Chat about it"
  (`discussCard`) opens a new chat with the card as a chip in its composer (`AppState.composerCards`), not as text
  you write under: `send` puts the card's block before your first message (a slash command does not take it) and only
  then attaches the chat. The chip's × drops both the details and the attach; a draft you leave is disposed with it. GitHub
  links are not card actions: they are made on the GitHub page and in the card dialog (see GitHub).
- **Resolve works in a git worktree** (`src/main/worktree.ts`, made by `ChatTasks`), on branch
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
  `boardTags`) and a short report. It runs on `TRIAGE_MODEL` (Sonnet 5.5, low thinking): `ChatTasks` sends
  `set_model` and `set_thinking_level` before the prompt, which pi applies to that session only (RPC never saves
  them as your defaults; checked in pi's `rpc-mode.js`). `pickModel` prefers the provider the chat started on, and
  an explicitly selected provider must match exactly. A missing model, rejected switch or mismatched switch response
  stops setup before the task prompt is sent; it never silently uses your default. Tags are edited in the card dialog. Triage chats are
  not listed in the sidebar: `projectViews` leaves out chats named `triageName` (live or indexed; `ChatTasks` names
  the live chat as soon as its prompt is sent), and projects with only triage chats; they are reached from their card.
  A triage that ends well closes (`Setup.closeWhenDone`; its result is the card's report), so the card is not
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
  sends resolve, reopen, remove and fix (`applyLament`), applied locally first like `applyBoard` (checked against
  the revision it was made on; when main refuses, its laments replace the local ones, or the ones from before when
  it cannot answer).
- **The page** (`components/Laments.tsx`, `page.kind === "laments"`, keyed by project) lists open laments worst
  first (a lament is as bad as its worst report), then the most recent, with Open and Resolved tabs. A row shows
  the severity emoji, the title, ×n when it was hit again and the latest report; it expands to every report
  (Markdown) with the chat that filed it. Right-click, or the expanded row, fixes, marks resolved, reopens or
  deletes. Mark resolved is manual: no chat runs, the lament moves to Resolved (a repeat reopens it). View >
  Laments (⌘⇧L), the sidebar's Laments row (the worst open lament's emoji and the count, for the project it
  opens) and a project's context menu open it; switching between the two pages keeps the project (`showPage`).
- **Fix** (`fixLament`, `state/app.ts`) is a card's Resolve for a lament: main makes the lament's git worktree
  (`cardWorktree` keyed by the lament's id, branch `pigna/<lament>-fix-<title>`; reused by later
  Fixes), and a background chat there gets `fixPrompt` (`src/shared/task-prompts.ts`): the lament (`lamentBlock`: the first
  report and the latest two, whole), find and fix the cause, verify by doing what the lament wanted, leave fixes that
  belong outside the project (`~/.pi/agent`, another repository, an app) to you, commit on the branch. Once pi knows
  the chat's session file (`ChatTasks`), the `fix` op records it and the branch on the lament (`fixes`, the
  latest ten): the row shows a wrench while it is open, and its details link to each Fix chat. The chat does not
  resolve the lament; you mark it resolved once you merged the fix.

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
- **Review a pull request**: a PR's Review button (and "Review in a new chat" in its menu) opens a new chat in the
  project whose first message (`reviewPrompt`, `lib/github.ts`) names the PR, its branches and the gh account the
  page reads it as, and asks for a review with `pr-review`. That skill is bundled (`resources/skills/pr-review`) and
  every chat opened while GitHub is on gets it (`--skill`, `SessionHost.piArgs`), so you can also ask any chat to
  review a PR. It reads the PR with gh and its head with `git fetch <remote> pull/<N>/head` (a temporary detached
  worktree to run checks), never checking out in your folder, and posts nothing to GitHub unless you ask in the chat.
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
  `node_modules`, `.git` and build folders), then a non-recursive `fs.watch` on each folder holding a plan and on
  `NEW_PLAN_DIR` (`docs/plans/draft`, where the orchestrator prompt tells the architect to write new plans, never the
  root) and each existing folder above it, which rescan when the next one appears (debounced 150 ms); a plan created
  anywhere else shows after Refresh. `Atp.activate` runs
  `atp-activate-project` and adds `*.atp.json.lock` to the repository's `.git/info/exclude`, so `git add -A` never
  commits the lock.
- **The runner** (`AtpRuns`, `src/main/atp-runner.ts`) lives in main, so a plan keeps running with no window (a hidden
  one included) and any client can start, stop and watch it (`atp.start`, `atp.stop`, `atp.state`; its runs, run notes
  and orchestrator chats go out whole as the `atp.runners` global event). It is not a scheduler, and nothing judges a node: like
  atp-runner, per plan it claims the next READY node (`atp-claim-task --agent-id pigna-w1`; `parseClaim` reads
  `TASK ASSIGNED`, `NO_TASKS_AVAILABLE` and "not ACTIVE"), starts a fresh worker chat with the worker prompt and
  the claim packet (`workerMessage`), waits for its run, then reads the plan. A worker completes, fails or decomposes
  its node itself through the librarian, and commits `node(<ID>): <title>`; if HEAD did not move and the tree is
  dirty, main commits what it left (`Atp.commit`, `git add -A`). A node still claimed after the run gets one
  nudge (`nudgeMessage`); after that the runner releases it, notes why on the page and stops. Stop aborts the
  worker and releases its node. A node held by `pigna-w1` while nothing runs (pi-gna quit mid-node) shows as
  Interrupted, and Start resumes it in a new worker that is told it is resuming. The worker's plan-file changes
  stay uncommitted (the worker commits before it completes, as with atp-runner). The worker chat is started by
  `ChatTasks.launch` (model, prompt, name, as for card tasks); its settles come from `SessionHost.onSettled`. A
  finished worker chat closes unless a client has it in the foreground (`presence`), and then once none does
  (`SessionHost.onPresence`). The ATP page is a view of this state (`state/atp.ts`); `scripts/fake-pi.mjs` with
  `FAKE_ATP=1` completes the nodes it is assigned, to run a throwaway plan end to end.
- **Models** (Settings > Models): each fresh worker reads the configured worker model and thinking level at node
  startup. Explicit provider selections are exact; id-only defaults prefer the chat's provider, then any provider
  serving that id. Missing models and failed or unconfirmed switches stop setup before a prompt is sent; the runner
  releases the claim and shows the setup failure. New orchestrators follow the configured orchestrator model and
  are published to clients only after selection succeeds; resumed orchestrators retain their session's model.
  A node's `reasoning_effort` is ignored. `ATP_CONFIG` keeps one worker per plan and a commit per node.
- **ATP chats are hidden** threads: `--session-dir <userData>/atp-sessions` keeps them out of `~/.pi/agent/sessions`
  and the sidebar (`projectViews` skips them too). SessionHost (`atpArgs`) gives each role its skills (`--skill`),
  its prompt (`resources/atp/worker.md` or `orchestrator.md`, `--append-system-prompt`) and its plan's path. The page
  remembers which chat worked which node (`AtpThreads`, `<userData>/atp-threads.json`, `atp.threads`; the window's
  older localStorage copy is merged in once, `atp.importThreads`) and opens them from the node panel. A worker chat
  closes once its node is done, unless you are looking at it.
- **The orchestrator** is one chat per plan, on the plan's page: you ask it how the plan is going, or have it edit or
  extend the plan with the librarian (decompose, future patches). It never works a node. Its extension's
  `atp_pause` holds the plan in main (`Atp.setHeld`; the librarian has no pause) so the runner claims no new node,
  and waits up to 4 minutes for running nodes to finish; `atp_resume` lifts it (and so does the page's Resume). The
  librarian refuses future patches while any node is CLAIMED, SCOPE nodes included; the prompt says so. It starts
  (or resumes from its session file) when a client shows the plan (`atp.orchestrator`, a client lease on the chat),
  without a model call, and idle ones stop when that client leaves (`atp.releaseOrchestrators`; busy ones once they
  finish, unless a client is back in them). New ATP opens the same composer with the architect skills; the chat that writes the plan
  becomes its orchestrator. That chat works in a git worktree of its own (`Atp.newPlanCwd`; `atpWorktree` in
  `worktree.ts`, branch `pigna/atp-<id>`, laid out like a card's under `~/.pi-gna/worktrees/<id>/`), reusing one that
  holds no plan and no change (fast-forwarded to the checkout's HEAD); outside git or before a first commit it writes in
  place. The project's plans include those worktrees' plans that the checkout has no copy of at the same relative path
  (a worktree's copies of committed plans are the checkout's), and their `NEW_PLAN_DIR` is watched too. A plan's run and
  orchestrator work where the plan is (`checkoutOf` in `shared/board.ts`), so a worktree plan's workers commit on its
  branch; merging it back is yours.
- **The page** (`components/Atp.tsx`, `page.kind === "atp"`, keyed by project): a header breadcrumb (project, then
  the plan; `PlanSwitch` opens a menu of the project's plans with their progress, in place of an always-on rail), the
  plan's bar (status counts that cycle through their nodes, Start/Stop/Resume, the run's last note), the graph, a
  side column and the orchestrator (`OrchestratorDock`). Until you talk to a plan's orchestrator only its translucent
  composer (`Composer floating`) floats over the graph; its height goes to `AtpGraph` as `inset`, which fits and centers
  the plan above it and lifts the zoom controls and minimap, and only the composer takes the pointer, so the graph pans
  around it. Once the chat has a message (or runs) it moves into the side column (`docked`), with the whole `Transcript`
  and its composer, and the graph gets the rest of the width. The column's tabs: the orchestrator (a pulse while it
  runs, a dot when it settled while another tab was in front: `useUnread`), the selected node (instruction, context,
  report, its chats; its X or Esc closes it and the chat comes back; selecting a node brings its tab to the front), and
  worker chats: the node panel's and the plan bar's worker buttons open the worker as a tab (`threadHandle` in
  `state/atp.ts` joins or starts it without leaving the page; X closes the tab, and leaving the plan closes them all,
  `releasePageChat`). The chat tab in front is the one the host is told this window looks at (`showPageChat` in
  `state/app.ts`), so a finished worker you watch is not closed under you and an answer you see is read. "Open as a
  chat" leaves the page for that chat; the chevron folds the column to a strip that keeps the pulse and the dot. When
  the inset refit and the column change the graph's width in one go, the resize observer starts from the size the
  refit placed it for (`placedFor`), so the plan is not shifted twice. The architect's chat for a new plan is the page
  until it writes the plan: it stays floating, the whole `Transcript` in a panel above the composer. View > ATP (⌘⇧A)
  and the sidebar's ATP row open the page. The side column and the architect's panel resize from their inner edge
  (`ResizeHandle`, double-click resets; bounds `ATP_DETAIL`/`ATP_DOCK` in `lib/layout.ts`, persisted as
  `pigna:atp-panels`). A drag stops before the graph gets under `ATP_GRAPH_MIN` (280×160; the conversation stops
  short of the canvas's top); on a smaller window the remembered sizes give way the same way (the column's CSS
  `clamp`, the conversation panel shrinking) without changing what is remembered.
- **The graph** (`components/AtpGraph.tsx`, `lib/atp-layout.ts`) is native SVG and HTML, no graph library: a
  layered layout (longest-path layers, barycenter ordering, then straightened), cards positioned in one transformed
  layer and edges as SVG paths with `vector-effect: non-scaling-stroke`. SCOPE nodes draw dotted edges to their
  `scope_children`. Status sets the card's look (`lookOf`): running cards glow and their incoming edges are animated
  dashes. Three levels of detail by zoom: cards, titles only, then status-colored blocks, so a 300-node plan reads as
  a progress map when fitted. `--k` (the zoom) keeps outlines and glow screen-sized; selecting a node lights its
  lineage. A canvas minimap shows only when zoomed well past fit.

## Remote access

An iPhone (Safari or the Home Screen app) can use the pi-gna running on the Mac, over Tailscale. Agents, tools,
repositories, the browser and Computer Use stay on the Mac; the phone is a second client of the same host. The contract
of record (method table, SSE framing, error codes, limits) is `docs/REMOTE.md`; the threat model is
`docs/REMOTE_THREAT_MODEL.md`; the real-device runbook is `docs/REMOTE_VERIFICATION.md`; iOS platform notes are
`docs/REMOTE_IOS.md`.

```
iPhone (Safari / Home Screen PWA, src/mobile)
  -- https, tailnet only --> tailscale serve :443 -> 127.0.0.1:<port>   (default 4517)
Electron main
  RemoteServer   static app (out/mobile), POST /api/call/<method>, GET /api/events (SSE), /api/browser/view, PUT /api/uploads
  HostCore       one method table: name -> { scope, mutates, validate, run }
     ^ IPC (desktop window)      ^ RemoteServer (paired devices; scope "remote" only)
  EventHub       every push, one seq counter; the desktop window and each SSE stream are subscribers
  SessionHost, BoardStore, LamentStore, SettingsStore, ComputerAgent, BrowserManager, Atp, AtpRuns, ChatTasks, ...
AgentBridge      127.0.0.1, token-gated, for pi's extensions; never exposed, never reachable from the remote server
```

- **The desktop renderer was not rewritten.** It keeps IPC and reduces events locally. What changed is behind IPC: the
  handlers are thin adapters over HostCore, and the orchestration that used to live in the renderer (the ATP runner,
  card, lament and review chat setups, queue operations, composing a prompt from card, comments and file mentions)
  moved to main, so a phone can start the same work with ids. Extensions stay for agent-facing tools only.
- **HostCore** (`src/main/host-core.ts`, types in `src/shared/host-api.ts`): `name` is `<area>.<verb>`, args are one JSON
  object, `validate` throws `bad_request`. `scope: "desktop"` methods (native pickers, `openExternal`, window focus,
  `remote.*`, pairing, `revokeAll`, `update.restart`, `chat.rawCommand`, `fs.describePaths`) answer `403 scope_denied`
  remotely. Mutating calls need an `Idempotency-Key` remotely (10 min cache; a retry after a host restart fails
  `409 host_restarted`). `chat.command` takes only the RPC allowlist (`RPC_ALLOWLIST`); there is no raw RPC
  passthrough. Areas (REMOTE.md section 1.1):

| Area | Methods |
|---|---|
| `chat` | list, open, attach, detach, viewing, live, close, snapshot, send, command, interrupt, editQueue, respondDialog, startTask, files, compactionSettings |
| stores | `board`, `laments`, `settings`, `computer`, `ui` (`get`/`apply`; every value carries `rev`, free-text edits `baseRev`) |
| `atp` | plans, read, start, stop, releaseInterrupted, liftHold, threads, orchestrator, state |
| `browser`, `fs`, `github`, `providers`, `update` | tabs, input and view stream; folder browsing and uploads; gh reads; provider sign-in; update state and download |
| `devices`, `remote`, `push`, `app` | device list/revoke (pairing and enable are Mac-only), status, Web Push, hello/info |

- **EventHub** (`src/main/event-hub.ts`): topics `global` and `chat:<handle>`; envelope `{ bootId, seq, topic, event }`
  with one host-wide `seq`; snapshots are `{ seq, value }` taken atomically with the counter, and a client applies only
  events past its snapshot. One ring (2000 events or 8 MiB). A reconnect sends `Last-Event-ID`; a gap, a new `bootId` or
  backpressure (1 MiB queued, closed at 4 MiB after 10 s) ends in a `resync` and the client refetches snapshots. The
  reducer runs in main (`src/shared/session-state.ts`), so `chat.snapshot` (last 40 turns, older ones paged) is always
  authoritative. Browser frames and `computer.preview` never enter the ring.
- **Leases.** `chat.open` and `chat.attach` take a lease `(handle, clientId)`; the desktop is `desktop`, a phone is its
  stream id. A lease whose stream closed lives 60 s. pi stops only with no leases and a disposable chat (not prompted,
  running, compacting, holding a dialog or unread), or on an explicit `chat.close`: closing or suspending a client never
  cancels host work. Subscribing never leases. Background chats (triage, ATP workers) check presence, not "active".
- **Many clients.** Prompts from two clients arrive in order (a send while running is a steer). Dialogs and approvals:
  first answer wins, the rest get `already_answered` and drop the card on `dialog_resolved`. Store text edits conflict by
  `baseRev` (`409 conflict`); structural ops are last-writer-wins.
- **Auth** (REMOTE.md 11). Off by default: with `remote.enabled` off nothing listens. The server binds `127.0.0.1` only;
  `tailscale serve` (never Funnel; refused when Funnel is on) is the only way in. A phone pairs inside the Home Screen
  app with a one-time code (8 characters, 5 min, 5 tries) that the Mac approves (device name, user agent, Tailscale
  login), and gets a 400-day `HttpOnly; Secure; SameSite=Strict` cookie; the host keeps only its sha256 in
  `userData/remote-devices.json`. Every request checks `Host`, POSTs check `Origin` and `X-Pigna-Client`;
  `Tailscale-User-Login` must match the pairing login (defense in depth, forgeable by a local process). Any device may
  revoke any device (closing its streams at once); pairing, enabling remote and revoke-all are Mac-only. Credentials
  (provider keys, gh tokens, browser cookies) never leave the Mac; the phone can send an API key but never read one.
- **Host mode** (`RemoteHost`, `src/main/remote.ts`; settings `remote.*`): while on, closing the window hides it
  (`window-all-closed` does not quit, the Dock `activate` shows it) so the BrowserManager keeps its window, and Quit asks
  first when chats are running. `remote.keepAwake` (`off`, `while-working`, `always`) holds
  `powerSaveBlocker('prevent-app-suspension')`: it stops idle sleep, never closed-lid sleep, and no privileged sleep
  tricks are used. `openAtLogin` uses `app.setLoginItemSettings` (never from test instances).
  Tailscale is read through its CLI (`src/main/tailscale.ts`, pure parsing in `src/shared/tailscale.ts`); reading
  changes nothing, **Serve over Tailscale** runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` only on a
  click and never replaces another service on :443. The pairing code and the approval prompt go to the window only,
  never through the hub. Test instances: `PIGNA_REMOTE_LOOPBACK=1` also accepts `Host: 127.0.0.1:<port>`; curl then
  needs `Origin: https://127.0.0.1:<port>`, `X-Pigna-Client: 1` and a `Tailscale-User-Login` header.
- **Phone attachments** (`src/main/uploads.ts`, `src/main/browse.ts`, `src/shared/uploads.ts`): `PUT /api/uploads` streams a phone's file to `userData/remote-uploads/<device>/<uuid>/<sanitized name>` (25 MiB cap, 30-day prune at startup); `chat.send` takes `{ upload }` or `{ path }` refs and `ChatTasks.send` composes the file-mention block and image content host-side. See docs/REMOTE.md.
- **Web Push** (off by default, per device; `docs/REMOTE.md` 13a): `src/main/push-service.ts` keeps the VAPID key and one subscription per device in `userData/remote-push.json` (0600), watches the hub's `global` events (attention summaries for approvals after a 10 s grace, runs that settle unread or failed, ATP runner notes, quit) and sends through `src/main/web-push.ts` (RFC 8291/8292 on `node:crypto`, vector-tested). Rules in `src/shared/push-rules.ts`. Payloads carry no chat text. Subscriptions go when a device leaves the device list. The phone's `sw.js` shows the notification and `notificationclick` opens `#/chat/<handle>`. Pushes need the Mac awake and online.
- **The mobile app** (`src/mobile`, built by `vite build -c vite.mobile.config.ts` into `out/mobile` as the second half of
  `pnpm build`, one `PIGNA_BUILD` id for both; `pnpm dev:mobile` rebuilds on change). It has feature parity, not the same
  layout: projects and chats, composer (models, thinking, commands, mentions, queue, attachments), transcript with tool
  sheets, lightbox and visuals, Kanban, Laments, GitHub, ATP, Browser, Settings (except Shortcuts). `src/mobile` may bundle
  devDependencies through Vite; main and preload still import only Node and Electron. The service worker caches the app
  shell by build id, never `/api`; a `buildId` mismatch in `hello` reloads. Shared renderer components take props
  instead of forks (`ChatUiActions`, `ContextMeter`, `QueueCard`).
- **Not on the phone:** operating Mac apps (Computer Use is a view-only preview with approvals and Stop), pop-out browser
  windows, native pickers, `update.restart`, enabling remote access, pairing, Shortcuts, `pi --pigna`. No native iOS app.
- **Verifying.** `pnpm typecheck` and `pnpm test` (HostCore, EventHub, RemoteServer, security, multi-client, push and the
  mobile helpers have vitest tests). `pnpm e2e:remote` (`scripts/remote-e2e/`, small scenarios that each launch their
  own test instance as 'Verifying the UI' describes: own `PIGNA_USER_DATA`, `PIGNA_BACKGROUND=1`, `scripts/fake-pi.mjs`)
  pairs devices behind a proxy that fakes an https origin and drives the phone screens at the iPhone 15 preset; name
  scenarios to run only those (`pnpm e2e:remote mobile-board --keep --shots <dir>`), see docs/REMOTE.md "Automated
  end-to-end tests". `scripts/remote-browser-check.mjs` covers the browser stream.
  Everything a real iPhone adds (pinch, long-press, push, Home Screen behavior) is the runbook in
  `docs/REMOTE_VERIFICATION.md`.

## Project themes

`src/shared/theme-presets.ts` defines ten paired light/dark palettes plus Original.
No preset (and explicit `original`) contributes zero CSS overrides, retaining the pre-theme appearance.
An explicit project preset replaces global fonts/colors; otherwise those inherit. Custom edits layer over
its palette. The picker sends `{preset, font:null, colors:null}` for a clean switch while preserving mode,
wallpaper and logo. The Applies to dropdown includes known projects, normalized worktree roots, and
stored project themes; changing its target never navigates or changes another project's appearance.
An agent's preset-only patch still preserves omitted custom edits. Presets must retain
readable text and link contrast against both surfaces (covered by the registry test).

`src/shared/themes.ts` is the validated patch/merge contract; `main/themes.ts` owns
`userData/themes.json` (revisioned JsonStore). Project keys use `projectOf(cwd)`, so card worktrees
share their original project's theme. Resolution is project fields over global fonts/colors over
built-in settings/default tokens. Omitted fields stay unchanged; null removes the override and
inherits again. Theme files are local preferences, not executable project configuration.

Settings > Appearance and the agent's `set_theme` extension reach the same main-owned validator.
The token-gated `/theme` bridge obtains the project from the calling session, never an agent-supplied
absolute path. Global mode/built-in wallpaper remain in settings for compatibility; image wallpapers
and logos belong to projects. Images are project-relative files, realpath-contained, size-limited
(12 MB wallpaper, 2 MB logo) and delivered as data URLs. Missing images show no replacement, not a
filesystem URL. Fonts are installed family names only: no downloads; a phone without that font uses
the fallback stack. `set_theme` reports the effective values, including inherited fields.

`ThemeRoot` in each client resolves its own foreground project. The shared `useThemeAppearance`
hook sets explicit light/dark mode and CSS variables; system mode follows that device. Only desktop
may call `themes.active` to set native macOS appearance. Paired phones read `themes.get`/`themes.image`
and receive revisioned theme events, including resync; they never change the Mac's foreground project.
Project wallpaper overrides suppress wallpaper looping. VisualFrame forwards colors, fonts and mode
on the `pigna-theme` event, so existing sandboxed inline visuals update without re-running scripts.

Regression lesson: use explicit theme mode rather than only `prefers-color-scheme`: a phone's OS
mode can differ from a project's mode. Keep the host allowlist, mobile snapshot/event handling and
frame token propagation covered together (the `themes` scenario in `scripts/remote-e2e/`).

## Settings

Codex-style: a Settings row is fixed at the foot of the sidebar (⌘, or pi-gna > Settings…). While the page is open the
sidebar is its nav (`SettingsNav`): sections grouped as pi-gna (General, Appearance, Keyboard shortcuts), pi
(Providers, Plugins, Models, Agent) and Integrations (Features, Remote access, Computer use), with a search over their labels and keywords.
Holding ⌘ for 300 ms shows ⌘1–⌘9 on those sections, and on the visible chat rows everywhere else
(`useCommandDigits`). ⌘⇧U opens the Computer use section.

- **Remote access** (Settings > Remote access, `remote.enabled`, off by default): see the Remote access section below.
- **pi-gna's settings** are `userData/settings.json` (`SettingsStore`; every change goes through `applySettingsOp` in
  `src/shared/settings.ts`) and apply to every project: the feature switches, the theme (`nativeTheme.themeSource`)
  and the models of the chats pi-gna starts itself (card triage, ATP orchestrator and worker; `pickModel` tries the
  task's provider exactly when one is specified; id-only selections prefer the chat's provider, then any provider
  with that model id). Computer Use keeps its `enabled` in
  `computer-use.json`, next to its policy.
- **Features** (Kanban, Laments, GitHub, ATP, Computer use): off hides the page, its sidebar row and its menu items, and
  new chats start without its extension (`SessionFeatures`). Chats already open keep their tools, so the bridge route
  is gated too (`SettingsStore.gate`: 403 "… is turned off in pi-gna's Settings"). ATP stays on while a plan runs.
- **Inline visuals** (Agent > Beta, `visuals`, off by default): read when a chat starts, like the features. It loads
  `resources/visual-extension.ts` into that chat (`SessionFeatures.visuals`), which adds `resources/pigna-visual-prompt.md`
  to the prompt's project context beside the AGENTS.md files; the renderer reads the same setting live, so flipping it renders or hides visuals in existing transcripts at once. See Visuals.
- **pi's settings** (Models, Agent): a fixed list of keys (`PI_SETTINGS` in `src/shared/pi-settings.ts`) in pi's global
  `settings.json` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). `writePiSettings` changes only those keys, refuses a
  file that is not a JSON object, takes pi's own proper-lockfile lock (a `<file>.lock` folder) and writes through a
  temp file beside the target, so a symlinked settings.json stays a symlink. pi reads the file when a chat starts:
  changes apply to new chats, and a project's `.pi/settings.json` can still override them.
- **Providers** (pi's `/login` and `/logout`): RPC mode, the extension ModelRegistry and the `pi auth` CLI cannot log
  in, so main (`PiAuth`, `src/main/pi-auth.ts`) runs `resources/pi-auth.mts` with pi's SDK: the
  `@earendil-works/pi-coding-agent` package `pi` (or `PIGNA_PI_BIN`) resolves into, run by the `node` on the PATH
  with type stripping. Not Electron's Node or a utilityProcess: the SDK needs Node ≥ 22.19 and has native modules.
  JSONL both ways (`AuthRequest`/`AuthReply`, `src/shared/auth.ts`); a fresh `ModelRuntime` per operation, so logins
  made in a terminal show up; one login at a time; the helper stops after a minute idle and logs nothing that
  passes through (answers can be API keys). Account (OAuth) providers are cards, subscriptions first; API keys are a
  searchable list. A login's prompts (select, text, secret, manual code) are answered inline under its row;
  `auth_url` opens in your browser as in pi, with Open again and Copy link; device codes get Copy and Open page;
  ✕ or Esc cancels.
- **Claude plans go through Claude Code.** pi-claude-bridge's `claude-bridge` provider runs Claude via Claude Code, so
  it uses Claude Code's own login (the macOS keychain item every Claude Code shares), never pi's `auth.json`. Its
  Claude Code card shows on every install (any pi whose SDK has `DefaultPackageManager`, through which the bridge is
  found, user scope). Without the bridge, Sign in first runs `pi install npm:pi-claude-bridge` with the pi
  whose SDK the helper loaded (its `bin`, run by the helper's node, npm's folder put first on the PATH; a child
  process because npm writes to stdout, the helper's JSON channel), which brings the Agent SDK's Claude Code along.
  Unpinned, unlike the Plugins catalog: pi pins a versioned npm source, so `pi update --extensions` (and an agent
  asked to update the bridge) would never move it, and the bridge has to keep up with Claude Code.
  After the login, a Max plan (`claude auth status`) sets `provider.plan: "max"` in `claude-bridge.json` unless a plan
  is set there, which gives Opus 1M context. pi's own Anthropic account login never gets a card (the Anthropic API
  key row stays); a notice offers to sign out of it while one is saved. A sign-in or sign-out marks the renderer's
  model list stale (`modelsChanged`), so the next chat to start lists models again. The helper runs the bridge's Claude Code (`pathToClaudeCodeExecutable` in `claude-bridge.json`, else the
  Agent SDK's platform binary beside the bridge, else `claude` on the PATH): `claude auth status --json` (exit 1 when
  signed out), `claude auth login --claudeai` and `claude auth logout`. The login opens its page itself (it calls back
  to a local port), so its `auth_url` is marked `opened` and main does not open it again; the printed link (an OSC 8
  hyperlink) is the fallback, whose page shows a `code#state` that the paste prompt writes to Claude Code's stdin
  ("Invalid code" on stderr asks again). Sign out signs Claude Code out on the whole Mac, the terminal included.
- **Logos** are real brand marks: `src/renderer/src/lib/provider-logos.ts`, generated by
  `node scripts/provider-logos.mjs` from pinned LobeHub icons (MIT), drawn as LobeHub's Avatar draws them; Radius,
  TypeSafe and Ant Ling come from the companies' own sites. A provider pi adds later shows its initial until it is
  mapped in the script's `BRANDS`. Gradient ids get a per-instance prefix (`useId`), because a logo can show twice.
- **Plugins** (desktop only: installs run code, sign-ins open the Mac's browser). pi-gna has no plugin system of its
  own: pi's `settings.json` (`packages` and the `extensions`/`skills`/`prompts`/`themes` filters) and `mcp.json` are
  the state, so the terminal and pi-gna agree and new chats load every change. `PiPlugins` (`src/main/plugins.ts`)
  runs `resources/pi-plugins.mts` once per request with pi's SDK (found as for Providers), the request on stdin and the
  reply on fd 3 (pi's `npm install` inherits stdout), one change at a time. Toggles drive `pi config`'s own list
  (`ConfigSelectorComponent`'s `resourceList`: `toggleResource` for Personal, `setProjectResourceOverride` for This
  project, which pi offers only when the project is trusted, `ProjectTrustStore`); state reads resolve with
  `onMissing` "skip", so reading never installs. A whole package off in Personal is all four filters `[]`, on drops
  them (back to a plain string); in This project it is one override per resource, and pi then lists the package as a
  project group with a source relative to `.pi/`. Installs (`installAndPersist`) and connections take a catalog id,
  never a source or URL from the window. MCP status, sign-in and sign-out are pi's own `pi mcp list --json` (exit 1
  on a failed server, JSON still valid; it connects to every enabled server, about a second), `pi mcp login`
  (prints the URL, opens the browser itself, waits for the loopback callback; ✕ kills it) and `pi mcp logout`.
  A catalog connection that takes a token (Brevo) keeps it in the login Keychain (`security -i` on stdin, item
  `pi-gna.mcp.<server>`), and its `mcp.json` header is `!echo "Bearer $(security find-generic-password …)"`, which
  pi runs through the shell when it connects; Remove deletes the item. With pi-mcp-adapter loaded, chats reach
  `mcp.json`'s servers through it and it keeps its own sign-ins (`/mcp-auth`), so the page says so and offers no
  pi sign-in. The catalog (`resources/plugins/catalog.json`, `parseCatalog` in `src/shared/plugins.ts`: https only,
  logos as base64 SVG/PNG `data:` URLs drawn with `<img>`, npm packages pinned to an exact version) is fetched from
  this repository's `main` once per launch and kept in `userData/plugins-catalog.json`; a failed or invalid fetch
  falls back to that copy, then to the bundled one. Logos: Notion, Intercom and Brevo from simple-icons (CC0), Attio's
  mark from attio.com, Granola's app icon from granola.ai.

## Setup

The first-run flow (`components/Setup.tsx`, `src/main/setup.ts`, `src/shared/setup.ts`): a native `<dialog>` (modal,
`setOverlay` so the browser view does not draw over it) with five animated steps: You, pi, Providers, Plugins & MCP,
Done. It opens by itself when pi is missing or broken (`piReady`), or on a first launch (localStorage
`pigna:setup-done` unset until you close it), even when pi already has a provider signed in; Settings > General > Run
setup opens it again. Step one picks a persona by clicking a card, the nerd 🤌 or the cool 🤌 (`Settings.persona`; only Setup reads it so far): the nerd sees
commands, versions and npm's log, the cool one plain words, a progress bar and funny lines, and the `simple` Providers
(no file or environment notes, no "(legacy)" logins, API keys behind a button) and Plugins (app connections only).
Not installed yet is a dashed to-do check; red is for a Node.js that is too old, a broken pi or a failed install.

- `setup.status` runs `node --version`, `npm --version` and `pi --version` and looks for pi's package (`findPiSdk`)
  with the login shell's PATH. A pi that is there but fails or does not answer is `{ error }`, not missing: Setup never
  installs over it. Next needs a pi that answers; the package only gates the Providers and Plugins steps.
- `setup.installPi` runs pi's README command, `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
  (desktop-only, refused when pi is there), streams its lines (`setup:line`, one decoder per stream), stops after 10
  minutes or when pi-gna quits, then appends `npm prefix -g`/bin to main's PATH when it is missing. No Node.js (or one
  older than 22.19) gets a link to nodejs.org and Check again; pi-gna does not install Node. Known gap: Node from
  nodejs.org's installer has a root-owned global prefix, so the install fails with EACCES and Setup says so.
- Checks and the install live in a module store, so closing Setup mid-install keeps npm running and reopening shows
  it. The chat behind Setup, which failed while pi was missing, gets a fresh pi on close or when the install finishes
  after you closed Setup (`reviveChat`), never while pi is still missing.
- Esc closes Setup only when nothing inside wanted it: login prompts (window capture + `preventDefault`), search
  fields (`stopPropagation`) and fields with text keep theirs; the dialog's own `cancel` is always prevented.
- Sprites (`assets/setup/`): nerd, cool, hammer, joy, shock and plug were generated with GPT Image from the
  pigna-video model sheet `pigna-poses.png` (always the pinched 🤌, never an open hand); bow and conduct are video
  sprites. Each was cut out with the light paper fringe outside the outline peeled off and resized with premultiplied
  alpha; a plain alpha threshold leaves a jagged cream halo on dark surfaces. Size them with `h-full` inside a flex box:
  `max-h-full` does not resolve inside an auto-sized grid row, and the sprite overflows.
- Test with `PATH` holding only `node` and `npm` (symlinks) and `npm_config_prefix` in a scratch folder, so the real
  install goes there; `src/main/setup.test.ts` fakes node, npm and pi as shell scripts (use `exec` in a fake that
  sleeps, or `execFile`'s timeout waits for the orphaned child's pipes). A hidden test window can be recorded to video
  by looping `webContents.capturePage(undefined, { stayHidden: true })` in main (`scripts/cdp.mjs main`) and joining the
  frames with ffmpeg's concat demuxer using the capture times as durations.

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
- Sidebar layout (Codex-style): header with the logo and a hide button, "New chat" (⌘N), "Kanban" (⌘⇧K), "Laments" (⌘⇧L), "GitHub" (⌘⇧G) and "ATP" (⌘⇧A, with a count of running plans) rows
  (each only while its feature is on), then a "Projects" title whose hover "+" opens a folder, then the folders,
  and "Settings" fixed at the foot. Holding ⌘ numbers the first nine chat rows you can see; ⌘1–⌘9 opens one. Resizable from its right edge (220-480px,
  never leaving the chat under 520px; double-click resets; dragging left of 120px snaps it collapsed, keeping the
  pre-drag width for when it reopens, and dragging back out in the same gesture reopens it), collapsible with ⌘⇧S (Codex's second binding; ⌘B is
  the browser here). Width and collapsed state persist in localStorage. Collapsed, the sidebar is `inert` (not `aria-hidden`, which
  Chromium blocks while a button inside still has focus). While collapsed, show-sidebar and
  new-chat buttons sit right of the traffic lights (x=88, y center 25, matching the lights) and the leftmost
  header gets `COLLAPSED_INSET` left padding.
- Title bar and zoom: the traffic lights are native and keep their size and place at every page zoom (⌘+/⌘−), so
  whatever lines up with them is sized in screen px through `--unzoom` (1 / `webFrame.getZoomFactor()`, set in
  `main.tsx` and refreshed on `resize`, which every zoom change fires): the `titlebar` band (52 screen px, growing only
  when zoomed-in content needs more), the sidebar header's 86px lights reserve, the collapsed controls' x=88 and the
  lights part of `COLLAPSED_INSET`. The content in the band still zooms. A new pane header uses `titlebar`, not `h-[52px]`.
- Chat header (`SessionPane`): title, then the card chip, the browser toggle (⌘B) and expand-all (Ctrl+O). It has
  no close button: closing a chat stops its pi process and is rarely wanted mid-work, so it lives in the sidebar
  row's right-click menu ("Close chat").
- Sidebar order (`projectViews`): pinned projects first, in the order you pinned them (hover pin button; a pinned
  project keeps its pin visible, app-only state kept by the host in `ui-state.json`, same on every client; the window migrates its old localStorage pins once), then the rest by latest activity: the index's
  file times, raised by messages you send from pi-gna so a chat and its project move up right away instead of
  after the run. Opening or switching chats must never reorder projects or chats (opening leaves the file
  untouched, and an opened chat closes again when you leave it, so "open chats first" made projects jump around).
- Hidden projects ("Hide project" in a project's menu, `UiState.hidden`): left out of the sidebar and the phone's
  list, their chats untouched on disk and in the index. Hiding unpins. "Show N hidden projects" under the list reveals
  them, dimmed and last, with "Unhide project"; the phone finds them through search. Starting a new chat in one
  (`newSession`) shows it again.
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
  (bash output, edit diff, written file, read file, generic JSON); tool-result images render inline under their
  tool row (the collapsed "Worked for" header hides them; the answer shows the images it embeds, docs/FILE_PREVIEW.md, Chat links). Ctrl+O expands everything (same key as the pi TUI). A running
  tool row ticks a faint 10px run time ("14s"); with a timeout, a tiny pie next to it fills toward it (amber past
  80%, exact numbers in its tooltip). A finished row shows its duration and timeout on hover. The timeout comes only from the call's arguments (`toolTimeoutMs`: bash `timeout` in seconds,
  `timeoutSeconds`, `timeoutMs`): pi exposes no per-tool defaults, and bash runs unbounded without one.
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
  "Show earlier turns" keeps your place. While a run is live the view follows it if you are at the end (`pinned`):
  opening a running chat, sending (your message at the top is the end until the answer outgrows the view) and ↓
  pin; wheel up, a finger dragging down or any other upward scroll unpins; being at the end (within `END_SLACK`,
  2 px for iOS's fractional offsets, or past it) re-pins, checked before the upward test so iOS's rubber band
  bouncing back to the end keeps following (`followsAfterScroll` in `lib/turn-scroll.ts`). The ↓ button shows
  exactly while the view is off the end and not pinned, so without it output keeps you at the end. Following
  moves the view only when the content height changes, so it never fights the send glide, and it does not
  depend on scroll events (hidden windows get none). `followChecks` in `pnpm e2e:remote` checks it on the phone.
- Turn rail (`TurnRail`, Codex's "user message navigation rail", read from the Codex app bundle's
  `thread-user-message-navigation-rail-app` chunk and its CSS): a 2px line per message you sent, vertically
  centered left of the transcript, shown from 4 messages on and only while the column leaves a 48px gutter.
  Lines are 6px at rest and 26px under the pointer, the three neighbours on each side magnified (0.7/0.4/0.2),
  Dock-style; lines of turns on screen (IntersectionObserver) are brighter. Hovering opens a 320px card with the
  message on one line, a bookmark button and the first three lines of the final answer (`railItems`, tables as
  fixed truncated columns). Click smooth-scrolls the turn to the jump position (`TOP_GAP`) and flashes its
  bubble; dragging scrubs instantly; ⌥↑/⌥↓ jump to the start of the current/previous or the next message
  (`adjacentTurn`; left to the caret while a text field has text). Turns on earlier pages are rendered first
  (`reveal`). Bookmarks are app-only state kept by the host (`ui-state.json`, `src/shared/ui-state.ts`), per session file, keyed by the message
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
- Output speed (`TokenRate`, `lib/token-rate.ts`): tok/s beside the context meter, per response, over the time it
  spent streaming text and thinking only. Tool calls do not count, neither their arguments nor their time: providers
  often buffer the arguments and deliver them in one burst, which read as ~300 tok/s. A `StreamClock` on the
  assistant item starts at the first streamed text or thinking block (time to first token does not count) and
  advances with each text or thinking event by the gap since the last one, capped at `STALL_MS` (1s): longer
  pauses inside a response (a tool call in between, reasoning the provider does not stream, a stall) are waits, so
  the live readout holds instead of dropping; it also holds while a tool call streams, and tool runs fall between
  responses. A response that only calls tools has no rate. Providers report output tokens only when a response ends
  (pi's `message_update` usage is not live), so while it streams the count is estimated from the streamed text and
  thinking (4 characters a token, shown as `~`), and `message_end`'s `usage.output` replaces it, unless the response
  has tool calls: that count includes their arguments, which cannot be split off reliably, so the estimate stays.
  When the provider reports `usage.reasoning`, the reasoning tokens are swapped for the estimate of the reasoning
  that streamed (summaries), since the rest was produced during waits that do not count. The last response's rate stays, dimmed, after the run; responses read from a session file
  have no timings, so they show none.
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
- Prompt bar: Enter sends (steers while running), Alt+Enter queues a follow-up. Esc while running arms the stop
  button (it reads "esc", replacing the send button if there is a draft, for 2.5 s); a second Esc clears the queue
  and aborts (no separate "esc stop" hint: the toolbar has no room for it). `/` commands from `get_commands`, `@` files, model and thinking pickers, image paste.
- Composer: always at least 2 lines tall (like beautifului.dev's Chat composer). A soft blurred glow in the pi
  logo colors mixed with grey sits behind it, and its hairline border is grey with faint logo tints. On focus the
  border brightens (beautifului.dev's only focus change, measured: `line` -> `line-strong`) and becomes a slowly
  flowing coral/grey/blue/yellow gradient with a stronger glow (the Gemini-like part, ours). `.composer*` in
  `styles.css`; motion stops with reduced motion.
- `.prose` (Markdown) is plain CSS in `styles.css`, outside Tailwind's layers, so it beats any utility: a
  `text-[13px]` on a wrapper or `[&_.prose]:` variant does not resize it. Size it with a contextual rule beside it
  (`.thinking .prose`, `.lament-report .prose`).
- Attachments (Codex-style, verified against the Codex app bundle): "+" button (⌘U) opens one native picker for
  files and folders (no separate "Add photos": photos are files, images among the picks still go as images), drop anywhere on the session pane, ⌘V. Files and
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
Empty states sit on a wallpaper picked in Settings > Appearance (`settings.wallpaper`, default `monet`; `none` leaves
the canvas plain), masked into the canvas above the text and composer. Each puts Pigna, the mascot, into a
public-domain painting in its own brushwork: Monet's *Impression, Sunrise* (Pigna in the rowing boat), Van Gogh's
*The Starry Night* (on the hill) and Hokusai's *Great Wave* (on the crest). Pigna is itself a hand, so it makes no hand
gestures there (no waving or pointing; arms down), and it is painted in the medium, never a cartoon sticker. Image
moderation refuses paintings with nudes (*The Birth of Venus*, *The Creation of Adam*) unless every figure is clothed.
Each has a dusk image (dark theme) and a day image (light), the one generated from the other as a reference so the
scene stays the same (each painting starts from its own light: Hokusai by day, the others at dusk); GPT Image 2.5 at
2560 × 1440, high, then `cwebp -q 72 -m 6 -sharp_yuv` (thumbnails: `-q 75 -resize 480 270`). Try compositions first
at 1536 × 864, medium, in a mock of the empty state (canvas, `.hero` mask, layout). They replaced, in 0.9.2, a set of
seven where the 🤌 itself took another form (sky, constellation, Dolomites, pine forest, shadow, ink wash, fresco): a
removed id in settings falls back to the default, and in a saved theme it unsets the wallpaper (`parseThemes`) instead
of dropping the theme. Files are `assets/wallpapers/<id>-<dusk|day>.webp` and `thumbs/`, found by `import.meta.glob`
in `lib/wallpapers.ts`, whose test fails when one is missing; keep Pigna in the upper middle and the bottom third calm
and dark (dusk) or pale (day), since the mask fades it out under the text. With Loop on (`settings.wallpaperLoop`),
each new empty state (and so each launch) shows the next wallpaper; where the loop is stays in localStorage
(`pigna:wallpaper-loop`). The spinner and the sidebar's state marks stay pi's pixel
logo in its coral/blue/yellow: they show pi working.

Brand: **pi-gna** (Italian *pigna*, the 🤌 "mano a pigna" gesture). The logo is 🤌i: Twemoji's pinched fingers
(CC-BY 4.0, credited in the README and About panel) mirrored and turned 90° (`matrix(0 -1 -1 0 36 36)` in its
36-unit box) so the hand reads as a P, then a white "i". Written out it is always `pi-gna` (package, bundle,
repo, docs); the 🤌i mark is visual only (sidebar header, icon). `resources/icon.svg` is the icon's source: dark
tile with blurred coral, blue and yellow glows in the corners; `pnpm icon` rasterizes it to `resources/icon.png`
(dev Dock icon) and `build/icon.icns`. `assets/pigna-hand.svg` is the same hand cropped for the UI.

Icons: pi-gna draws its own set, `components/icons.tsx` (renderer and mobile import it; no icon library). One
style: 24-unit grid, 2px round strokes and joins, 3-4 unit corner radii, the fewest strokes that still read at
12-16px. Exports keep the names of the lucide-react icons they replaced (`X`, `SquareKanban`, `Settings`), each
renders `<svg class="icon icon-<name>">`, and props pass through, so `fill="currentColor"` fills a Square or Play
and `strokeWidth` thickens one. A new icon is a new `icon()` entry drawn in that style, not a dependency. The
markdown link icons in `styles.css` (`--file-icon` data URIs) reuse the same paths. That class is what scripts select
an icon by (`svg.icon-pin` in the remote e2e): renaming an icon means grepping `scripts/` too, which typecheck does not
cover (the pin check still looked for `svg.lucide-pin` after the switch).

## Visuals

Optional inline HTML visuals in assistant replies (Settings > Agent > Beta > Inline visuals, off by default). The agent
writes a fenced block tagged `visual` holding an HTML fragment; pi-gna renders it in a sandboxed, offline iframe. The fence
stays in the session JSONL, so a visual survives resume and history (unlike Codex's file-per-visual `::codex-inline-vis`,
which fails silently on path mismatches, and whose frame CSP allows CDN scripts). `scripts/visual-isolation-spike.mjs`
(`node_modules/.bin/electron scripts/visual-isolation-spike.mjs`) measured the isolation claims below (Electron 44, macOS).

### Fence contract

- An HTML **fragment** (no `<html>`/`<head>`/`<body>`, no external URLs). Inline `<script>`, `<style>` and `<svg>` are allowed;
  the frame CSP confines them, not sanitising.
- The prose around the fence must answer the question alone; the visual only supplements it (the prompt says so).
- Cap **64 KB** (`VISUAL_MAX_BYTES`, `lib/markdown.ts`): larger blocks stay a code block with a "too large" note.
- `markdown.ts` pulls a complete fence out before DOMPurify and leaves `<div class="visual" data-visual>` holding the source in
  a hidden `.visual-src`; `Markdown.tsx` hydrates it into `VisualFrame`. Setting off, or a fence still open while streaming:
  a plain code block (streaming shows a skeleton, with "Drawing visual…" for screen readers, instead of partial source).
- The prompt (`resources/pigna-visual-prompt.md`) lists the kit classes, tokens and helpers, when exactly one visual is
  warranted and when not, and SVG rules. It reaches the agent as a context file, not `--append-system-prompt`:
  `visual-extension.ts` pushes it onto `systemPromptOptions.contextFiles` in `before_agent_start`, so it renders as a
  `<project_instructions>` entry right after the AGENTS.md files pi found (verified with a probe extension reading
  `event.systemPrompt`). Nothing is written to disk, so a terminal `pi` never sees it. `src/main/visual-kit.test.ts` fails if
  a class, token or `kit.*` helper it names is missing from the kit, and checks the extension. Prompt quality was tuned
  against real models with `docs/visual-evals.md`.

### Scheme, CSP and frame document

- Scheme `pigna-visual`, registered `{ standard: true, secure: true }` before ready together with `app` (one
  `registerSchemesAsPrivileged` call). `standard` is needed for relative URLs and `script-src 'self'`; nothing else (no fetch).
- One host per frame: `pigna-visual://<frameId>/doc`, `<frameId>` random per `VisualFrame`. `visual-protocol.ts` serves only
  `/doc`, `/kit.css`, `/kit.js` (from `resources/visual/`) and 404s the rest. The fragment never goes in the URL.
- The phone loads the same document from the remote server at `/visual/<frameId>/doc` (`visualRemoteAsset`,
  `RemoteServer.serveVisual`): same three files, same `VISUAL_CSP`, no credentials (a sandboxed frame has an opaque origin and
  sends no cookie) and `doc.html` links `kit.css`/`kit.js` relatively so both schemes resolve them. The iframe is
  `sandbox="allow-scripts"`, tap to render (`ChatUiActions.visualFrames.tapToRender`); the same heartbeat watchdog, on error,
  removes the iframe (a remote client cannot kill its process) and shows the source. A frame that blocks the page's thread
  outright cannot be caught by any watchdog in that page; the 64 KB cap and the CSP are what bound a hostile one.
- `/doc` CSP: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:;
  font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors app://pigna` (`VISUAL_CSP`,
  `visual-frame.ts`). `unsafe-inline` is acceptable: opaque origin, no network, navigation or parent access.
- Renderer CSP (`app-protocol.ts` header, `index.html` dev meta tag): `frame-src pigna-visual:` (was `'none'`; with `'none'`
  the frame fails with `ERR_BLOCKED_BY_CSP`).
- `<iframe sandbox="allow-scripts">`: no `allow-same-origin`, popups, forms, top-navigation or modals. Main's
  `will-frame-navigate` refuses any subframe navigation outside `pigna-visual://`.
- srcdoc/data:/blob: frames cannot run scripts under the parent's `script-src 'self'`, which is why a dedicated scheme exists.
- Measured in the sandbox: origin `"null"`; fetch, XHR, WebSocket, remote images/CSS and storage blocked; `top`/`parent`
  access throws; `window.open` returns null; form submits are blocked. An `<a href>` click would navigate the frame itself,
  so the shell intercepts anchors and sends `open-link`.
- Theme: `prefers-color-scheme` in the frame follows `nativeTheme`; the parent also sends the current token values.

### postMessage protocol

Plain objects `{ type, ... }`; unknown types and malformed payloads are ignored. The parent trusts a message only if
`event.source === iframe.contentWindow` (`origin` is `"null"`); the frame only accepts `event.source === parent`. The parent
posts with target `"*"`; nothing secret goes through it.

Parent to frame: `render { html, tokens }` (replace the container with the fragment and re-create `<script>`s; resent until the
frame answers `rendered`), `tokens { tokens }` (re-sent when the OS theme changes).
Frame to parent: `ready`, `rendered`, `height { px }` (ResizeObserver, per animation frame), `open-link { href }` (only
`http(s)` goes to `window.studio.openExternal`), `error { message }` (`onerror`/`unhandledrejection`), `heartbeat` (every second).

### Lifecycle, size and freeze mitigation

- The frame is created once per `VisualFrame` and memoised by source: streaming prose around it does not reload it.
- Presentation follows T3 Code's in-thread visualizations: no box, header or label around the frame, so a visual reads as
  part of the reply. The iframe inherits the app's `color-scheme` (with `normal` it painted an opaque canvas, because an
  iframe whose scheme differs from its document's gets one). Under it, a row of actions appears on hover (always on touch):
  Expand, Source, Copy.
- Height follows `height` messages from 40 px (sent right after a render too: the observer waits for a frame, which a
  hidden window never draws). The height is the document's, or the bottom of a visible `.popover` when that is lower: an
  absolute popover is out of flow and would be clipped, and the observer does not see it open, so kit.js re-reports after
  every click and Escape. No inner scroll in the shell and no clamp in the parent: like T3 Code's inline HTML, a visual
  shows at its full height (a 720 px clamp with a fade and Show all was removed on request). Expand restyles the same iframe to fill the window over a backdrop (Esc, Close or a click outside returns it);
  moving the iframe would reload it and lose its state. Width is the message column.
- The kit (`kit.css`, `kit.js`) is bundled: pi-gna's theme tokens, a categorical palette (`--c1`…`--c8`) and a heat ramp
  (`--heat-0`…`--heat-4`), both with light variants, and the component vocabulary (`stack row grid card stats stat head tabs
  bars bar split scale legend badge callout table num steps timeline controls hint muted mono`, plus UI-mock pieces `mock field
  btn chip kbd banner menu anchor popover switch`), so the agent writes structure, not styling. Its look follows T3 Code's
  `html_render` guide: text at the app's font size, sans tabular numbers (28 px headline stats), 10 px rounded bars, section
  subtitles inline after the title, and filled boxes without borders; nothing frames the whole visual. UI mocks follow T3 Code's
  in-thread mocks of UI treatments: the prompt asks for one `mock` per treatment of a UI change, with the real copy, so they
  can be compared and clicked in the reply. A mock pictures the product being changed, not pi-gna, so `.mock` redeclares the
  kit tokens with a neutral light product look (theme pushes on `:root` never reach inside), and the agent sets the
  product's real values from its code on the `.mock` (same token names plus `--radius`, `--accent-fg`, `color-scheme`);
  literal colors and a scoped `<style>` are allowed there only (`visual-eval.mjs` does not flag them in a mock). A
  `.popover` floats only from an `.anchor`; elsewhere it stays in the flow, so a stray one cannot cover the previous mock. `kit.js` wires `.tabs` (`.on`, `data-show` panels, a `tab` event), mock
  interactions without script (`data-toggle="id…"` flips `hidden`, an outside click or Escape closes an open `.popover` that
  has an id, `data-dismiss` hides the nearest banner/popover/menu/card, `.switch` flips `.on` and fires `switch`), `data-tip` tooltips, and
  `window.kit` (`color(i)`, `heat(t)`, `fmt(n)`, `tip(html, x, y)`) for scripted charts, plus `along(path, f)` and
  `player(el, stages, draw, opts)` for animated flows: one `requestAnimationFrame` clock per player with a toolbar (pause,
  restart, 0.5/1/2x) before `el`'s content and numbered stage chips (jump) after it. `draw` receives the time as `{ ms, stage,
  p, at(i), done }` and owns no state, so seeking is a redraw. It plays once (`opts.loop` repeats), so a transcript does not
  keep animating, and under `prefers-reduced-motion` it opens paused on the last frame. It renders a fragment once: the
  parent re-sends `render` until acked, and a second run would redeclare the fragment's top-level `const`s and throw.
  `resources/visual/gallery.html` shows every component.
- A runaway fragment (`for(;;){}`) cannot freeze the transcript (the frame has its own process), but it keeps burning a core
  and survives removal of the iframe. Each frame has its own host so it is its own site and process. **Watchdog**: no message
  (heartbeats included) for **8 s** (`WATCHDOG_MS`) shows "Visual stopped responding" with the source, and `studio.killVisual(id)`
  asks main to `SIGKILL` the frame's process (`visualFrameToKill`: found through `framesInSubtree` by URL, never the app
  window's own process). The same kill runs when the frame unmounts. A killed frame is not retried.

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
Providers and Plugins find pi's SDK by walking up from that executable to the pi package, so a bare wrapper loses
it: put the wrapper in `<dir>/bin/pi` with `<dir>/package.json` naming `@earendil-works/pi-coding-agent` and
`<dir>/dist` symlinked to the real package's `dist` (that is how the Plugins sign-in was tested with a fake
`pi mcp login` that prints a URL and waits). Point `PI_CODING_AGENT_DIR` at a scratch folder for anything that
writes pi's settings, and launch from the project folder you want as the page's project (`launchCwd`).
Chromium pauses `requestAnimationFrame` while the window is occluded, so the store also flushes on a 250 ms timer.
Timers are throttled in those windows too: a toast (4.5-9 s `setTimeout`) can stay in screenshot after screenshot of a
background instance or the e2e's offscreen phone window, which is the test window, not a toast that never dismisses.
A `PIGNA_BACKGROUND=1` instance never paints for `scripts/cdp.mjs shot` (it hangs); start it with `--inspect=<port>`
too and use `capture`, and wait a few seconds after opening a page (its enter animation captures blank).
The same starvation hits CDP tests of background windows: mouse moves are dispatched with the next frame (hover
and IntersectionObserver lag until one is drawn), and a `drag` blocks waiting for frames. Force frames by taking
screenshots (`shot`) after a `move`, and in a parallel loop while a `drag` runs.
Background test windows are `document.visibilityState === "hidden"`: smooth scrolls never move, ResizeObserver callbacks
never run (even after a `shot`), scroll events do not fire, and CDP mouse/wheel input waits for a frame (one wheel notch took 38 s). Test
scroll logic by simulating the gesture in `eval` (dispatch `wheel`, set `scrollTop`, dispatch `scroll`) and stub
`Element.prototype.scrollTo` to `behavior: "auto"` where a glide matters. `scripts/fake-pi.mjs` (via
`PIGNA_PI_BIN`) streams a long answer to every prompt (Stop/Esc abort ends it), for streaming UI checks without a model; it names a session file
(never written, so relaunching on the same `PIGNA_USER_DATA` fails to reopen remembered ATP orchestrator chats with
ENOENT and the page shows no composer: start each run with a fresh profile), so a card's or lament's chats link as with pi.
Under fake-pi the ATP orchestrator and worker defaults do not exist ("… is not available"): point them at it first,
`window.studio.settings.get().then((s) => window.studio.settings.apply({ type: "model", task: "orchestrator", model: { provider: "fake", id: "fake", thinking: "off" } }, s.rev))`
(again with `task: "worker"`, and `FAKE_ATP=idle` for a worker that streams). An unfocused (`PIGNA_BACKGROUND=1`) window
never tells the host it views a chat, so presence-driven behavior (a finished worker closing unless looked at, unread
marks) cannot be checked there: unit-test what the renderer reports (`studio.viewing`) instead. Close Setup by its
button, not Esc: Esc reaches a focused composer, and two stop its run. For board checks, seed
`$PIGNA_USER_DATA/board.json` (`{ "version": 1, "cards": [...] }`) with cards of a throwaway git project under `/tmp`
(give cards its real path, `/private/tmp/…`: the launch cwd is resolved, so `/tmp/…` cards sit on another board):
the board's project picker lists every project with cards, and card actions then start fake-pi chats there. Tests with the real
pi write real session files: pi 1.0.0 ignores `PI_CODING_AGENT_SESSION_DIR` (only pi-gna's index reads it), so run
them in a throwaway project under `/tmp` and delete its folder in `~/.pi/agent/sessions` afterwards.
Your pi-gna may run from this checkout's `out/`, and other chats may build there too: test a change from a build of its
own (`npx electron-vite build --outDir /tmp/<dir>/app/out`, copy `package.json` and symlink `node_modules`, `resources`
and `src` into `/tmp/<dir>/app` (the extensions import `../src/shared`: without `src` a real pi cannot load them),
then start `$(node -e 'console.log(require("electron"))') /tmp/<dir>/app` with the test-instance env). Set `PIGNA_CWD` in that env too (`PIGNA_CWD=/private/tmp/<project>`, or `env -u PIGNA_CWD`):
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
though `requestAnimationFrame` ran: `CDP_MAIN=<inspect port> node scripts/cdp.mjs capture <path>` asks main for the
frame instead (`capturePage` with `stayHidden`, device pixels; needs `--inspect`), and
`screencapture -x -o -l <CGWindowID>` captures the window as the screen shows it (the id is `kCGWindowNumber` from
`CGWindowListCopyWindowInfo` for the app's pid, for example through `osascript -l JavaScript`, or the number in
`BrowserWindow.getMediaSourceId()` (`window:<id>:0`) through `cdp.mjs main`); it includes the native tab views and
device windows. A tab under touch emulation (a phone preset) never acknowledges CDP mouse presses, so `click` on its
target hangs: click its elements with `eval` instead.
A card worktree (`~/.pi-gna/worktrees/…`) may have no Electron binary (`pnpm install` there skipped the download): launch
it with the main checkout's `require("electron")` path. Start a test instance in a detached subshell
(`(… nohup "$ELECTRON" . … & disown)`): a tool call that times out kills its process group, the instance included. Once
a background window stops drawing, CDP `click`, `type` and `key` queue forever; the comment picker still opens on
mousemove/click events dispatched with `eval` (its isolated-world listeners see them), but its card's keys need frames.
Provider logins (Settings > Providers) write `auth.json`: give test instances `PI_CODING_AGENT_DIR=/tmp/<dir>/agent`,
never the real one. Flows that open a browser or ask a provider for a device code should not run for real in a test:
put a fake SDK where `PIGNA_PI_BIN` resolves (a folder whose `package.json` is named `@earendil-works/pi-coding-agent`,
with `dist/index.js` exporting `ModelRuntime`, `SettingsManager` and `getAgentDir`, as `src/main/pi-auth.test.ts`
builds one) and give it an `auth_url` that is not http, so main opens no browser. For the Claude Code card, give the
throwaway agent dir a `settings.json` installing `npm:pi-claude-bridge` and an `npm` symlink to the real one (a
symlink to the package alone hides its hoisted dependencies from pi), and point `claude-bridge.json`'s
`pathToClaudeCodeExecutable` at a fake `claude` (the test's `FAKE_CLAUDE`): the real `claude auth login` opens the
browser. A synthetic `KeyboardEvent` needs `cancelable: true`, or `preventDefault` does nothing and Esc also leaves
Settings; `node scripts/cdp.mjs key Escape` sends a real one.
Native menus open on the real screen, where CDP cannot reach them: start the test instance with `--inspect=9334`
as well, and `node scripts/cdp.mjs menus` makes its `Menu.popup` record menus instead of showing them (and lists
what it recorded), `menu "Copy Image"` clicks an item of the last one, and `main "<expr>"` evaluates in the main
process with `require` (for example to read the clipboard). Save the user's clipboard before an item writes to
it and restore it afterwards.

### Verifying inline visuals

`FAKE_FIXTURE=<name>` makes `scripts/fake-pi.mjs` reply with a fixed text from `scripts/fake-pi-visuals.mjs`, `FAKE_CHUNK`
characters per delta every `FAKE_DELAY` ms: `architecture`, `comparison`, `dashboard` (the richer kit: stats, tabs, a scripted
treemap and heat grid with tooltips, bars, split, table; the tallest fixture), `slider`, `two` (two visuals), `stream` (use a small
`FAKE_CHUNK`, 25, to watch the placeholder), `oversized` (70 KB, use `FAKE_CHUNK=2000`), `hostile` (nine fences: fetch, `<img>`,
`top.location`, `window.open`, form submit, `alert`, `parent.studio`, a `javascript:` link, an http link; they point at
`http://127.0.0.1:$FAKE_HOSTILE_PORT`) and `loop` (`while(true){}`). Start a test instance as above, with fresh
`PIGNA_USER_DATA` containing `settings.json` `{"version":1,"visuals":true}`, `PIGNA_CWD`, `PIGNA_BACKGROUND=1`,
`--remote-debugging-port=<p>` and `--inspect=<q>`, and run a tiny counting HTTP server for the hostile port. Then
(`CDP_PORT=<p> CDP_MAIN=<q>`), after `node scripts/cdp.mjs type "go" --enter`:
- **Renders and sizes**: `eval "[...document.querySelectorAll('iframe.visual-frame')].map(f=>f.style.height)"` (above 40px once
  the frame reported its height); `nativeTheme.themeSource='light'|'dark'` through `main`, then `capture` for both themes.
- **Streaming**: poll `document.body.innerText.includes('Drawing visual')` (the skeleton's screen-reader text) while a
  small-chunk `stream` runs; it turns into an iframe when the reply ends.
- A fresh `PIGNA_USER_DATA` opens Setup over the chat, and it comes back on a delay: click `[aria-label="Close setup"]`
  right before each `capture`.
- **Frame contents**: `node scripts/cdp-frame.mjs "<expr>" [n]` evaluates inside the nth frame (the slider: set `#w`, dispatch
  `input`, read `#out`; hostile: `window.__parentAccess` is `blocked`).
- **Containment**: the counting server saw no request; `location.href` is unchanged; `main "webContents.getAllWebContents()"`
  and `BrowserWindow.getAllWindows()` show no new window. `window.studio` is frozen, so stub nothing: a click on the http link
  really opens your browser (the only request the server may see, and only from a click); the `javascript:` link opens nothing.
- **Loop**: a 100 ms timer in the page keeps ticking (max gap ~100 ms), the watchdog shows "Visual stopped responding" after
  8 s, and the frame's process is gone from `main "...mainFrame.framesInSubtree"` (check `top` that no helper stays at 100%).
- **Setting**: Settings > Agent > Inline visuals (`[role=switch]` next to that label) flips live: off turns visuals into
  `visual` code blocks and drops the frame processes, on brings the frames back.
- Two lessons from the first run: the streaming placeholder must not delete the hidden `.visual-src` (the source was lost when
  streaming ended without the html changing: blank 40px frame), and the frame's first `render` can be missed if it loads before
  the parent listens (the frame now acks with `rendered`; heartbeats re-send until then).

Electron drag regions: `-webkit-app-region` rects are applied in document order, so a `no-drag` element that
overlaps a `drag` header must come later in the DOM (or be its descendant), or real clicks start a window drag.
CDP clicks bypass the OS drag layer, so tests cannot catch this; check DOM order instead.

Build notes: Electron 44 has no postinstall; it downloads its binary on the first `require("electron")`, which then
also prints "Downloading Electron binary..." on stdout: in a fresh worktree, run `node -e 'require("electron")'` once
before launching with `$(node -e 'console.log(require("electron"))')`, or the launch gets that line as the path.
Electron 44's `clipboard` is asynchronous and `ClipboardItem`-based (`read`, `write`, `readText`, `writeText`;
no `readImage`/`writeImage`).
An effect must never return what `scrollIntoView` returns (`useEffect(() => el.scrollIntoView(…))`): with
`behavior: "smooth"` current Chromium returns a Promise, React calls it as the cleanup ("M is not a function") and
the window goes blank. Give such effects a block body.
electron-vite 5 does not minify the renderer unless `build.minify` is set. Sandboxed preloads must be CommonJS.
The checks are `pnpm typecheck` and `pnpm test` (some tests run real git, python3 and rg, so ci.yml and release.yml
install ripgrep on their runners); the repo has no formatter or linter config (`npx biome` fetches an
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
4. **Polish:** session tree, changed-files review, Cmd-K (done: `CommandPalette`, ranked by `lib/palette.ts`), usage insights, selection actions, Adjust panel,
   dictation, task rows for subagents and workflows.
