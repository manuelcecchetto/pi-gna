# Computer Use (design)

pi-gna gives pi a Codex-Computer-Use-like ability to see and operate native macOS apps in the background: read an
app's accessibility tree and a screenshot of its window, then click, type and press keys in it, through pi's own
virtual cursor — never the user's real mouse. This document is the design, grounded in spikes run on this Mac
(macOS 26.4.1, Apple M2, Swift 6.3.1); it is folded into `docs/DESIGN.md` once implementation starts. Read
`docs/DESIGN.md` first (principles, bridge, `JsonStore`, packaging) — this feature follows the same shape as the
Browser (M2) tools: a native backend behind pi-gna's bridge, discrete `computer_*` tools, policy enforced in main.

Codex's own shipped service was inspected for API shape only (never copy or ship its code or binaries):
`~/.codex/computer-use/Codex Computer Use.app`, bundle id `com.openai.sky.CUAService`, an `LSUIElement` app
installed under `~/.codex` (outside `ChatGPT.app`) so a TCC grant survives an app update, built with
`AXUIElement`/`AXObserver`, `ScreenCaptureKit`, and overlay windows (`CUALockScreenGuardian.app` suggests it also
hides itself during a locked screen). The `@oai/sky` and `@oai/cua` doc paths named in this node's packet
(`docs/skills/oai_sky_lib/macos/SKILL.md`, `sky-window2-api.md`, `tinysky-alt-core-cua-repl.md`,
`tinysky-alt-confirmations.md`) do not exist on this machine — only the installed `.app` bundle and its
`AppInstructions/*.md` (per-app usage notes for Slack, Notion, Spotify, etc., not an API reference) are present.
The tool surface and semantics below come from the packet's own description of Codex's tools (`list_apps`,
`get_app_state`, `click`, `drag`, `scroll`, `type_text`, `press_key`, `set_value`, `select_text`,
`perform_secondary_action`, `paste`, the ~1 s/5 s auto-wait, and the hard limits on terminals/security prompts/the
agent's own app), not from reading those missing files; this is recorded as a gap, not papered over.

## Evidence (spikes)

All spikes ran as throwaway Swift scripts under `/tmp/cu-spike` (not committed), with TextEdit and Calculator as
target apps, this process AX-trusted (`AXIsProcessTrusted() == true`). Every probe used `CGEvent(...).postToPid`
or `AXUIElement*`, never `CGEvent(...).post(tap:)`, which would hit the real event stream and the user's frontmost
app.

- **(a) `CGEventPostToPid` on a backgrounded, fully occluded window — confirmed working.**
  With TextEdit running but Finder (then Calculator, moved to fully overlap TextEdit's window) frontmost,
  `CGEvent(keyboardEventSource:virtualKey:keyDown:).postToPid(textEditPid)` delivered `a`, `b`, `c` into
  TextEdit's `AXTextArea` (read back via `AXUIElementCopyAttributeValue(kAXValueAttribute)` as `"abc"`), and a
  `leftMouseDown`/`leftMouseUp` pair posted to a point inside TextEdit's window moved AX focus to its
  `AXTextArea` (`AXFocusedUIElementAttribute` read `AXTextArea` afterwards). In every case `NSEvent.mouseLocation`
  was unchanged and `NSWorkspace.shared.frontmostApplication` stayed the other app throughout — the real cursor
  never moved and TextEdit was never raised. Repeated with Calculator's window moved on top of TextEdit's exact
  frame (so TextEdit was 100% covered on screen, `SCWindow.isOnScreen` still read `true` — that flag means "not
  minimized", not "not covered"): clicking and typing into the covered window still worked (`"tdf"` landed in the
  text area). `CGEventPostToPid` routes to the pid's own window/responder, not through the window server's z-order
  hit-testing, so occlusion by other apps is irrelevant to delivery.
  No menu-bar/system-UI app was spiked (Codex's own denylist already excludes `SecurityAgent`-class prompts); treat
  "which apps ignore postToPid" as unresolved beyond this: **hypothesis** — apps with their own low-level input
  filtering (games, some DRM'd media apps, remote-desktop clients) may ignore synthetic events the same way they
  block real ones, and Electron/Chromium-hosted apps (not tested here) may need the window frontmost because they
  gate input on `isKeyWindow`/focus rather than `postToPid`'s target pid; verify per-app at implementation time, and
  fall back to a brief, reversible activate-and-restore when an app visibly ignores background input.
- **(b) `AXUIElementPerformAction(kAXPressAction)` and `AXUIElementSetAttributeValue(kAXValueAttribute)` on a
  background app — confirmed working.** With Finder frontmost, `AXUIElementSetAttributeValue` on TextEdit's
  `AXTextArea` set its value to `"AX background test"`, confirmed by read-back, with TextEdit never raised.
  `AXUIElementPerformAction(kAXPressAction)` on a button was exercised in the same backgrounded state (see
  `ax_probe2.swift`); it returned `kAXErrorSuccess` (`0`) without raising the app. AX actions are therefore the
  preferred first path (instant, immune to window position/occlusion, cheap to target by `AXUIElement` reference)
  with `CGEventPostToPid` as the fallback when an element exposes no useful AX action (custom-drawn controls,
  canvases, most Electron/Chromium content) or when AX write access errors (`kAXErrorAttributeUnsupported` for
  read-only controls).
- **(c) `SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow:))` on an
  occluded window — confirmed working, with one sharp edge.** `SCShareableContent.excludingDesktopWindows(false,
  onScreenWindowsOnly: false)` lists every window of a pid, including off-screen phantom windows (an invisible
  `Untitled` window at `(0, 33, 1470, 923)`, likely a cached/background scene) alongside the real, visible one
  (`"Untitled 2"` at `(175, 100, 586, 488)`); picking the largest by area is wrong — filter to `isOnScreen == true`
  and prefer the window whose AX frame (`kAXPositionAttribute`/`kAXSizeAttribute` on the matching `AXUIElement`)
  matches, since `SCWindow.frame` and the AX frame are both **points, top-left origin**, and agree exactly (both
  read `(175.0, 100.0, 586.0, 488.0)` for the same window) — no coordinate conversion is needed between AX and
  ScreenCaptureKit. The sharp edge: `SCScreenshotManager.captureImage` with a default `SCStreamConfiguration()`
  (no explicit `width`/`height`) returned a **1920×1080** image for a 586×488-point window — an unrelated default
  size, not the window's content. Setting `config.width`/`config.height` explicitly to
  `window.frame.width/height * NSScreen.main!.backingScaleFactor` (`2.0` on this Retina display) produced the
  correct `1172×976` pixel image (exactly `2×` the point size). **Always set `width`/`height` on the
  `SCStreamConfiguration`**; never rely on its default. Capturing the same window while it was fully covered on
  screen by Calculator's window (moved to the identical frame) succeeded identically (`1172×976`), confirming
  capture is independent of on-screen occlusion, matching (a). A bare CLI process must call
  `_ = NSApplication.shared` before using ScreenCaptureKit (`CGS_REQUIRE_INIT` otherwise aborts); the shipped
  helper is a full `.app` (`LSUIElement = true`, has an `NSApplication`), so this is a non-issue there, but
  matters for any throwaway spike or a future unit-test harness.
- **(d) TCC attribution (direct spawn vs `open -g -a`, ad-hoc signing and rebuilds) — labeled hypothesis, not
  directly observed.** This spike was not run: it needs clicking a real Accessibility/Screen Recording grant in
  System Settings and would mutate this dev machine's TCC database, which is a real, shared, hard-to-reverse
  system change for a throwaway test, not local file state. The design below instead relies on two things that
  are each independently solid:
  1. Apple's documented TCC model attributes a permission request to the "responsible" process for events
     generated by code that has no bundle identity of its own (scripts, raw executables spawned as a child), and
     to the app bundle itself for a process launched through LaunchServices with its own `Info.plist`
     (`CFBundleIdentifier`). Spawning the helper directly from Electron main (`child_process.spawn` on its Mach-O
     binary) risks the "responsible" app resolving to pi-gna itself (or being ambiguous) rather than the helper's
     own bundle id; launching it through LaunchServices (`open -g -a "<path>/pi-gna Computer Use.app"`, or
     `NSWorkspace.openApplication` from a small Swift/ObjC shim if main needs the result) is the documented way to
     make System Settings list a distinct helper app with its own Accessibility/Screen Recording row — exactly
     why Codex's own service ships as a separate `.app` outside `ChatGPT.app` rather than a spawned binary.
  2. This repository's own `docs/DESIGN.md` **already verifies** that an ad-hoc signature's designated requirement
     is the build's own `cdhash` (`electron-builder.yml` `identity: "-"`, no Developer ID; see DESIGN.md's Updates
     section: "Squirrel checks an update against the running app's designated requirement, which for an ad-hoc
     signature is that one build's cdhash, so every update would fail validation"). TCC grants are keyed to a
     requesting app's code identity the same way code-signing requirements are; an ad-hoc-signed helper's grant is
     tied to its current `cdhash` (confirmed here: `codesign -dv` on the installed Codex helper shows
     `CDHash=f3f22a62...`, `TeamIdentifier=2DC432GLL2` — Codex ships with a real Developer ID team, which is why
     *its* grants survive updates; pi-gna's ad-hoc helper does not have that luxury).
     **Consequence for this design:** rebuilding the helper binary changes its `cdhash`, which a TCC grant is
     keyed to, so **the helper must only be reinstalled into `~/.pi-gna/computer-use/` when its own embedded
     version changes** (a version file next to the binary, compared before copying), never on every pi-gna launch
     or app update — otherwise every pi-gna update would silently revoke the user's Accessibility/Screen Recording
     grant and the feature would stop working with no clear error. This mirrors the project's updater problem
     exactly (ad-hoc cdhash churn) and should be verified for real once the helper exists, by granting it
     Accessibility, rebuilding it, and checking whether System Settings still shows it as granted (expected: no,
     confirming the hypothesis) before shipping.

## Process model

- **The helper** is a small native macOS app, `pi-gna Computer Use.app` (Swift, `LSUIElement = true` so it has no
  Dock icon or menu bar), built from `native/computer-use/` and shipped inside the pi-gna app bundle
  (`Contents/Resources/`, unpacked like `resources/**` in `electron-builder.yml`'s `asarUnpack`/`files`, since the
  OS must load and codesign-check an `.app`, not an asar entry). It never runs from inside the asar.
- **Install.** On first use (lazily, not at every pi-gna launch) main copies the bundled helper to
  `~/.pi-gna/computer-use/pi-gna Computer Use.app` if that path is missing or its `CFBundleVersion` is older than
  the bundled one (string compare of the bundled `Info.plist` vs the installed one; a missing or unreadable
  installed plist counts as older). This is the same "versioned reinstall" shape as `~/.pi-gna/worktrees/` — a
  per-user cache outside the app bundle — chosen specifically so the TCC grant (keyed to the installed binary's
  `cdhash`, evidence (d)) is not invalidated by every pi-gna update, only by a Computer Use version bump.
- **Launch.** Main launches the installed helper through LaunchServices (`NSWorkspace.shared.openApplication`,
  called from a tiny helper or via `open -g -a "<path>" --args <socket-path> <token>` if main prefers a plain
  spawn+LaunchServices hybrid) — never `child_process.spawn` on its Mach-O executable directly, so System Settings
  attributes Accessibility/Screen Recording to `pi-gna Computer Use` and not to pi-gna's own Electron process
  (evidence (d)). `-g` (do not bring to front) keeps it an invisible background agent, matching `LSUIElement`.
  One helper process serves every pi-gna session; main starts it lazily on the first `computer_*` call and keeps
  it running until pi-gna quits (or restarts it if it crashes, logged like a `PiProcess` exit).
- **Transport.** JSON-RPC 2.0 over a Unix domain socket at
  `<app.getPath("userData")>/computer-use/<pid>.sock` (userData, not `/tmp`, for the same reason card images avoid
  `os.tmpdir()` — no silent OS cleanup). Main passes the socket path and a random per-launch token (like
  `AgentBridge.register`) as CLI args; the helper refuses any connection that does not send the token as the first
  message. One socket for the whole helper process; main multiplexes pi sessions over it by JSON-RPC `id`, the way
  `PiProcess` multiplexes RPC commands — the helper itself is single-session-at-a-time per app (see Policy) but
  the transport does not need to be.

## JSON-RPC protocol (main ↔ helper)

Methods (requests expect a JSON-RPC `result` or `error`; `cancelled` is a notification, no response expected):

| Method | Params | Result |
|---|---|---|
| `list_apps` | `{}` | `{ apps: [{ bundleId, name, pid }] }` — running, regular (not background-only) apps |
| `get_app_state` | `{ bundleId, diff?: boolean }` | `{ tree: string, treeChanged: boolean, screenshot: string (base64 JPEG), windowFrame: {x,y,w,h} }` |
| `click` | `{ bundleId, elementIndex? , point? , button?, clickCount? }` | `{ tree, treeChanged, screenshot, windowFrame }` |
| `drag` | `{ bundleId, from: elementIndex|point, to: elementIndex|point }` | same shape |
| `scroll` | `{ bundleId, target: elementIndex|point, direction, pages? }` | same shape |
| `type_text` | `{ bundleId, text, elementIndex? }` | same shape |
| `press_key` | `{ bundleId, key }` (xdotool syntax, e.g. `Return`, `super+c`) | same shape |
| `set_value` | `{ bundleId, elementIndex, value }` | same shape |
| `select_text` | `{ bundleId, text?, prefix?, suffix?, selectionType }` | same shape |
| `perform_secondary_action` | `{ bundleId, elementIndex, action }` | same shape |
| `paste` | `{ bundleId, text, format: "text"|"md"|"html" }` | same shape (clipboard is saved and restored) |
| `end_session` | `{ bundleId }` | `{}` — releases the app, removes the overlay |

Error codes (JSON-RPC `error.code`): `-32001 app_not_found`, `-32002 app_denied` (denylisted or not approved),
`-32003 element_not_found` (stale index — the caller must call `get_app_state` again), `-32004 action_failed`
(AX and CGEvent both failed), `-32005 busy` (another session owns this app), `-32006 cancelled` (the user pressed
Esc after the call started).

Notifications (helper → main, no reply expected): `cancelled { bundleId }` (user pressed Esc; main cancels the
in-flight pi tool call and replies with `-32006` if the RPC race loses), `app_closed { bundleId }` (the target app
quit; main ends the session).

## AX tree text format

Each app state response is a flat, indexed text listing of the AX tree (depth-first), not raw AX dumps: one line
per element with an increasing `[n]` index local to that app's session (`get_app_state` and every action response
carry the current indexes), e.g.:

```
[0] AXWindow "Untitled 2" (175,100,586,488)
[1]   AXTextArea (text: "Hello world", focused)
[2]   AXScrollBar
[3] AXButton "Save" (enabled)
```

- **Indexes are cached per app** in the helper, invalidated on the next AX tree read for that app (every action
  response re-walks and re-numbers, since AX elements themselves (`AXUIElement`) stay valid references but their
  on-screen order/count can change). A stale index from an older response returns `-32003`.
- **Diffing** (`diff: true`, the default per the Codex tool shape): the helper keeps the previous rendered text per
  app and returns only the changed lines (unified-diff-style `+`/`-` prefixed) plus `treeChanged: boolean`, so a
  no-op poll (nothing changed since the last read) is cheap for pi to skip. `diff: false` (or no prior state)
  returns the full tree.
- Only elements with a non-empty role/title/value or at least one exposed action are listed (skip bare
  `AXGroup`/`AXUnknown` containers with no useful attributes), capped at the tool's text budget (clip with a
  trailing count like the browser tools' `clip()` in `src/main/browser/agent.ts`).

## Screenshot format

JPEG (quality ~75, matching `browser_screenshot`'s `toJPEG(75)`), resized so the longer edge is at most 1280 px
(same cap as the browser tools), base64-encoded in the JSON-RPC result. Coordinates reported alongside it
(`windowFrame`, and any point params accepted by `click`/`drag`/`scroll`) are **window-relative logical points**,
not screen-absolute and not device pixels — evidence (c) showed AX frames and `SCWindow.frame` already agree in
that space, so the helper subtracts the window's AX origin before reporting a point and multiplies by the window's
backing scale factor only when calling ScreenCaptureKit's `width`/`height` (evidence (c)'s sharp edge). pi (and any
UI overlay in main) works entirely in window-relative points; only the helper ever touches pixels.

## Input strategy

1. **AX action first**: `AXUIElementPerformAction` for buttons/menu items/checkboxes (`kAXPressAction`), and
   `AXUIElementSetAttributeValue(kAXValueAttribute)` for text fields and `set_value`/`type_text` when the element
   supports it (evidence (b): both work on a backgrounded, unfocused app, with no risk of hitting the wrong
   on-screen point).
2. **`CGEventPostToPid` fallback** when the element exposes no matching AX action (custom-drawn controls, canvas
   content, most web content inside Electron/Chromium — not spiked directly here, flagged as a per-app risk in
   evidence (a)) or an AX call errors. Clicks target the point relative to the window's AX frame, translated back
   to the window's current screen position (re-read fresh each time, since the user can move the window) only to
   compute the `CGEvent` point — never to decide whether to activate anything.
3. **When to activate the window**: never, by default (evidence (a) and (c) show both input and capture work fully
   backgrounded and fully occluded). The one case that needs it is an app that empirically ignores
   `postToPid`/AX writes while backgrounded (the (a) hypothesis) — detected by the action's own before/after AX
   state read failing to change as expected twice in a row; only then does the helper raise the window
   (`AXUIElementPerformAction(kAXRaiseAction)` on it, not full app activation when avoidable) as a narrow,
   one-element fallback, never moving the user's cursor.

## Settle-wait rules

Mirrors Codex's auto-wait: after every action, the helper waits ~1 s before taking the "after" state read, and up
to 5 s total if the app's own busy signaling (`AXUIElement` such as a progress indicator present in the tree, or
the app's `NSRunningApplication.isAppRestartOnly`-style "not responding" check is false but the window is still
animating) suggests it is not settled, polling the tree every 250 ms and returning as soon as two consecutive
reads match or the 5 s cap is hit. No fixed sleep longer than that; a genuinely slow operation (a large file
export) is the agent's problem to notice and wait out with another `get_app_state` call, not the helper's.

## Overlay

A single borderless, click-through `NSWindow` per active session, `.screenSaver`-level (above normal windows,
`NSWindow.Level` high enough to sit over the target app without needing to be key or activate pi-gna), drawn by
the helper (it already has the window references and coordinates) rather than Electron, since Electron windows
cannot float above arbitrary other apps without their own activation dance:

- **Virtual cursor**: a small cursor-shaped glyph drawn at the current action's point, animated to the next
  point before each click/drag so the user can watch it move without their real cursor doing anything.
- **Pill**: "pi is using `<App name>` · Esc to cancel" docked near the top of the target window's frame. A
  global Esc key listener (local `NSEvent` monitor scoped to when a session is active, not a system-wide tap) ends
  the session: sends `cancelled` to main, removes the overlay, and does not change the app's state further.

## `computer_*` tools (pi extension, mirrors Codex's parameter shapes)

`resources/computer-extension.ts`, loaded like `browser-extension.ts`, calling `POST /computer` on the bridge:

- `computer_list_apps()` → running, user-facing apps (name, bundle id), minus the hard denylist.
- `computer_get_state({ app: string })` → AX tree text (diffed by default) + screenshot of `app`'s frontmost
  window. `app` is matched the way Codex's tools take an app name/bundle id loosely (case-insensitive name match,
  falling back to bundle id).
- `computer_click({ app, elementIndex? , x?, y?, button?: "left"|"right"|"middle", clickCount? })`
- `computer_drag({ app, fromElementIndex?, fromX?, fromY?, toElementIndex?, toX?, toY? })`
- `computer_scroll({ app, elementIndex?, x?, y?, direction: "up"|"down"|"left"|"right", pages? })`
- `computer_type_text({ app, text, elementIndex? })`
- `computer_press_key({ app, key: string })` (xdotool syntax, e.g. `"Return"`, `"super+c"`)
- `computer_set_value({ app, elementIndex, value })`
- `computer_select_text({ app, text?: string, prefix?: string, suffix?: string, selectionType: "exact"|"range" })`
- `computer_perform_secondary_action({ app, elementIndex, action: string })`
- `computer_paste({ app, text, format?: "text"|"md"|"html" })`

Every tool's `description` states the AX-tree-index contract explicitly ("use the `elementIndex` from the latest
`computer_get_state`/action result; indexes change after the tree changes") the way `browser_click`'s description
tells the model to re-snapshot, so the model does not need to be told this separately in a system prompt.

## Policy

- **Enable flag.** Off by default, a settings toggle ("Computer Use", with the explanation that pi can see and
  control other apps in the background); when off, `resources/computer-extension.ts` does not register any
  `computer_*` tool at all (same pattern as the browser extension's `if (!BRIDGE || !TOKEN) return;` early-out),
  so a model with the feature off never sees the tools exist.
- **Per-app approval**, enforced in **main**, not only the extension: the bridge route itself checks the app's
  bundle id against policy before forwarding to the helper, because (per the plan-wide decision) the bash tool
  inherits `PIGNA_TOKEN` and could call `POST /computer` directly, bypassing an extension-only check. Three
  states per `(project? no — this is cross-project, like gh accounts) ` app, stored in main:
  - **Allow once**: the extension's `ctx.ui.select` approval card (like the browser tools' origin prompt), valid
    only for the rest of this chat's session (cleared on session end, not persisted).
  - **Always allow**: persisted in `userData/computer-use.json` (a `JsonStore` like laments/board: `{ allowed:
    string[] /* bundle ids */ }`), revocable from the settings page (a list with a "Remove" per app, mirroring
    how browser's per-origin `approved` set works but durable instead of per-session).
  - **Hard denylist** (never asked, always `-32002`, enforced before any approval check, in main, not editable
    from settings): `com.apple.Terminal`, `com.googlecode.iterm2`, `com.mitchellh.ghostty`, terminal bundle ids
    for WezTerm, kitty, Alacritty, Warp, pi-gna's own bundle id (`io.github.manuelcecchetto.pigna`, from
    `electron-builder.yml`'s `appId`) and its helper's bundle id, and any bundle id matching Apple's
    security-prompt UI processes (`com.apple.SecurityAgent`, `com.apple.coreauthd`,
    `com.apple.UserNotificationCenter` and its modern equivalents) — the same "never operate the agent's own app,
    a terminal, or a security prompt" rule the context specifies, kept as an explicit list rather than a heuristic
    so it cannot be approved around.
- **One session per app at a time**, across all of pi-gna's chats: the helper's `-32005 busy` and main's own
  bookkeeping (a `Map<bundleId, handle>`) refuse a second session on an app another chat is already driving, the
  way `BrowserAgent` gives each chat its own tab but an app has only one AX/window state to mutate.
- **Cleanup** on run end (the pi session's tool loop finishing) and on Esc: `end_session` to the helper, which
  removes the overlay and clears its per-app tree/diff cache; main clears the busy-map entry and any "allow once"
  is already scoped to end there too.

## Settings page

A "Computer Use" section (new or under an existing Advanced/Integrations page): the enable toggle, the always-
allowed apps list with Remove, and a short note on the hard denylist (not editable) and that pi-gna will ask once
to open Accessibility/Screen Recording settings the first time the feature is used (the OS permission prompt
itself is outside pi-gna's control; a "Open System Settings" button can deep-link
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` the way macOS apps commonly do).

## Risks and non-goals

- **macOS only**, same as the rest of pi-gna; no Windows/Linux equivalent is in scope.
- **No locked-screen use.** The helper must not operate (or even hold AX/ScreenCaptureKit handles that could leak
  content) while the screen is locked; watch `NSWorkspace` lock/unlock-style distributed notifications
  (`com.apple.screenIsLocked`/`com.apple.screenIsUnlocked`) and end every active session when the screen locks,
  mirroring Codex's own `CUALockScreenGuardian.app` existing as a dedicated safeguard (evidence it treats this as
  a real risk, not a theoretical one).
- **No JS REPL batching in v1.** Codex's own "core-cua-repl" doc (named in the packet) was unavailable to read
  (see the Evidence preamble), so no batched/scripted multi-step execution is designed here; v1 is one JSON-RPC
  call per tool call, matching the discrete `computer_*` tool list already specified. Revisit only if a concrete
  need for batching appears once the discrete tools are shipped and measured.
- **Unverified**: evidence (d) (TCC attribution and ad-hoc cdhash survival) is a labeled hypothesis, not an
  observed result (see above) — the implementation node should verify it for real (grant, rebuild, re-check) before
  shipping the versioned-reinstall logic as final.
- **Unverified**: evidence (a)'s per-app "which apps ignore postToPid" question is answered only for TextEdit and
  Calculator (both native AppKit); Electron/Chromium-hosted target apps and games/DRM'd media were not tested.
- **Missing source material**: the `@oai/sky`/`@oai/cua` doc paths named in this node's packet do not exist on
  this machine (only the installed Codex Computer Use app and its per-app `AppInstructions/*.md` usage notes are
  present, not an API reference) — the protocol and tool shapes above come from the packet's own prose description
  of Codex's tools, not from reading those files.
