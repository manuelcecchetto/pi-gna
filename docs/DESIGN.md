# pi-studio design

pi-studio is an Electron desktop UI for the [pi coding agent](https://pi.dev). pi is always the backend: every
model call, tool, extension, skill and setting runs inside a `pi --mode rpc` child process, exactly as the user
configured pi. pi-studio only renders and controls.

## Principles

- **Lean.** No dependency on the pi package (its tree is huge); the RPC types we use are vendored in
  `src/shared/protocol.ts` from the pi docs. No component library: native `<dialog>`, the popover API and
  Tailwind. No diff library: pi's `edit` tool already returns a rendered diff. A tiny custom store.
- **pi owns behavior.** Never reimplement agent features client-side. If RPC lacks something, read pi's own files
  (sessions) or add a pi extension; do not fork the runtime.
- **The terminal is the log.** `pi-studio` runs from a terminal; the main process logs there, along with every pi
  child's stderr (prefixed by session). `PI_STUDIO_DEBUG=1` also prints all RPC traffic.
- **Untrusted content.** Model output and web pages are untrusted: sanitize markdown, keep the renderer sandboxed
  (contextIsolation, sandbox, CSP), open links outside the app window.

## Architecture

```
terminal: pi-studio            -> logs (main + pi stderr), Ctrl-C quits
  Electron main
    PiProcess      one `pi --mode rpc` child per open session (LF-only JSONL, id-correlated commands)
    SessionHost    handle -> PiProcess, forwards events + extension UI requests to the renderer
    SessionIndex   lists ~/.pi/agent/sessions (pi has no list_sessions command)
    files          `rg --files` for @ mentions
    browser/       BrowserManager (WebContentsView tabs), BrowserAgent (CDP actions), AgentBridge (localhost)
  preload          typed contextBridge API (window.studio)
  renderer         React + Tailwind v4
resources/browser-extension.ts   pi extension loaded with `-e` into every studio session
```

## Browser (M2)

- **Tabs** are `WebContentsView`s in the persistent partition `persist:pi-studio-browser` (separate cookies and
  storage from the app; no camera, mic, location or notifications). The renderer draws the tab strip and toolbar
  and reports the viewport rect (`browser:layout`); main attaches the active tab's view over it. Native views
  paint above the DOM, so the renderer hides the view while a DOM overlay must cover it (address suggestions,
  image lightbox). History lives in `userData/browser-history.json`.
- **Agent tools**: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`,
  `browser_screenshot`, `browser_evaluate`, `browser_console`. The extension calls `POST /browser` on a
  loopback HTTP server; each pi process gets its own bearer token (env `PI_STUDIO_TOKEN`), and the token, never
  the body, decides which session acts. Each session drives its own tab (or adopts the one you are looking at),
  and its actions run through a per-session queue because pi executes one message's tool calls in parallel.
- **Input and screenshots go through CDP** (`webContents.debugger`), not `sendInputEvent`/`capturePage`: those
  need composited frames, which Chromium stops producing while the app window is hidden behind other windows
  (verified: the click did nothing and capture failed with "Current display surface not available").
- **Snapshots** run in an isolated world (shared DOM, separate JS globals) and tag interactive elements with
  `data-pi-ref` numbers that click/type use.
- **Policy** lives in the extension: loopback and `*.localhost` URLs are allowed; any other origin asks once per
  session through `ctx.ui.select`, which renders as a studio approval card. Actions that navigate are re-checked
  afterwards and stepped back if denied. Stagehand's `run`, `snapshot` and `screenshot` are excluded with
  `--exclude-tools` (override with `PI_STUDIO_EXCLUDE_TOOLS`). The extension imports `src/shared/browser.ts`
  directly (pi loads extensions with jiti and aliases `typebox`).
- **Annotations**: comment mode injects a picker (isolated world, closed shadow root) into the active tab; a
  long-pending promise resolves with the element, selector, HTML and comment, main crops the element, and the
  renderer shows it as a chip. The next prompt carries a `<browser-comments>` block plus the crops as images.

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
  byte-identical, so "preview" opens are safe. Two pi processes prompting the same file are not, hence the
  "updated recently" banner for files written in the last 3 minutes.
- RPC never shows the project-trust prompt: a saved decision in `~/.pi/agent/trust.json` or
  `defaultProjectTrust` decides, and untrusted project resources are skipped silently.
- Every pi process re-emits the same extension startup notices; the renderer toasts each one once per app run
  (the terminal still logs all of them).

## UI model

- Sidebar: projects (cwd) -> sessions; dots for open and running sessions.
- Transcript: a **run** is everything between two user messages. Your messages are plain text with a `›` marker
  (no bubbles); runs are separated by dashed dividers. Each run splits (`layoutRun`) into a **work accordion**
  and the **final answer**: everything up to the last thinking/tool step (commentary, steps, notices) goes in the
  accordion, the text after it is the answer. Header: "Working for 13m 16s" (live) / "Worked for 22s", plus a
  tool summary ("Read 3 files · ran 2 commands"). It is open while working and closes itself once the answer is
  clearly streaming (message stopped, or over 300 characters, so short "Let me check…" commentary before the
  next tool does not collapse it) or the run ends. Your toggle is keyed per phase (working/done), so the answer
  still collapses it; closed while working, it shows only the active step. Each tool row expands to its details
  (bash output, edit diff, written file, read file, generic JSON); tool-result images render inline, and stay
  visible under a collapsed "Worked for" header. Ctrl+O expands everything (same key as the pi TUI).
- Live state: pixel-grid loader and shimmer on the "Working for" header, with "waiting for you", "compacting
  context" or "retrying" called out next to it.
- Prompt bar: Enter sends (steers while running), Alt+Enter queues a follow-up, Esc clears the queue and aborts,
  `/` commands from `get_commands`, `@` files, model and thinking pickers, image paste.
- Extension UI: `select`/`confirm`/`input`/`editor` become approval cards above the composer; `notify` -> toast;
  `setStatus` -> status bar; `setWidget` -> panel above the composer; `set_editor_text` -> composer text.

## Visual language

Inspired by beautifului.dev (no code copied; it has no public source or license): dark neutral surfaces
(~#1b1b1d), hairline borders, dashed dividers, system sans with small mono labels, muted grays, one blue accent,
light and dark themes, pixel-grid loaders with shimmer text, compact chips that expand.

## Verifying the UI

`scripts/cdp.mjs` drives a running app over CDP (screenshots, eval, typing, keys); start it with
`node bin/pi-studio.mjs --remote-debugging-port=9333`. `PI_STUDIO_PI_BIN` can point at a wrapper that adds
`-e <extension>` (for example pi's `examples/extensions/rpc-demo.ts`) to exercise every extension UI method.
Chromium pauses `requestAnimationFrame` while the window is occluded, so the store also flushes on a 250 ms timer.
Browser tabs are separate CDP targets: `CDP_URL=localhost:8765 node scripts/cdp.mjs shot` captures a tab, and
`click x y` sends real mouse input (useful for driving the annotation picker). CDP screenshots of the app window
do not include native tab views.

Build notes: Electron 44 has no postinstall; it downloads its binary on the first `require("electron")`.
electron-vite 5 does not minify the renderer unless `build.minify` is set. Sandboxed preloads must be CommonJS.

## Milestones

1. **Core (done):** RPC bridge, terminal logs, transcript with streaming, thinking and tool groups, prompt bar, sessions
   sidebar, approval cards, steer/follow-up/abort, status bar.
2. **Browser (done):** `WebContentsView` tabs with a persistent separate profile, address bar and history, split/full view,
   agent `browser_*` tools via a pi extension loaded with `-e` that calls a token-gated localhost bridge (CDP through
   `webContents.debugger`), annotation mode whose comments attach to the next prompt. Stagehand tools are excluded in
   studio sessions; localhost is allowed, other sites ask once.
3. **Polish:** session tree, changed-files review, Cmd-K, usage insights, selection actions, Adjust panel,
   dictation, task rows for subagents and workflows.
