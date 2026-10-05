# Remote browser frame source: spike results

Decides how the host streams a browser tab to a phone (T35). Measured with `scripts/remote-browser-spike.mjs`
(`node_modules/.bin/electron scripts/remote-browser-spike.mjs`; own session, bare Electron 44 window, one
`WebContentsView` sized 390x844 with `backgroundThrottling: false` like `BrowserManager.makeTab`, animated rAF + canvas
fixture, macOS, one run on the dev Mac, so treat numbers as orders of magnitude). No production code changed.

## Measurements

`rAF/s` = page animation rate (60 = page still renders). Screencast: `Page.startScreencast` jpeg q60, maxWidth 1170,
everyNthFrame 1, 3 s. Shots: sequential `Page.captureScreenshot` jpeg q60 with `clip.scale` 3 (1170x2532) or 2
(780x1688), 20 shots. `TIMEOUT` = no answer within 4 s. Input: CDP `Input.dispatchMouseEvent` click, `dispatchTouchEvent`
tap, `Input.insertText`.

| State | rAF/s | Screencast fps (KB/frame) | Shot @3x fps / p50 (KB) | Shot @2x fps / p50 (KB) | Mouse | Touch | insertText |
|---|---|---|---|---|---|---|---|
| 1 visible | 61 | 53-60 (18) | 11.9 / 83 ms (103) | 15.4 / 67 ms (50) | ok | ok | ok |
| 2 window hidden (`win.hide()`) | 60 | 48-55 (18) | **TIMEOUT** | **TIMEOUT** | ok | ok | ok |
| 3 minimized | 60 | 49-55 (34) | 12 / 83 ms (102); @2x TIMEOUT | TIMEOUT | ok | ok | ok |
| 4 occluded (opaque always-on-top window above) | 61 | 57-59 (36) | 11.9 / 83 ms (103) | 16.2 / 67 ms (50) | ok | ok | ok |
| 5 view detached (`removeChildView`) | **1** | 56-59 (36) | **TIMEOUT** | **TIMEOUT** | ok | **TIMEOUT** | ok |
| 6 emulated 390x844@3 mobile, visible | 60 | 59-60 (18) | 6.7 / 150 ms (215) | 10.2 / 100 ms (103) | ok | ok | ok |
| 7 emulated, window hidden | 60 | 50-56 (18) | **TIMEOUT** | **TIMEOUT** | ok | ok | ok |
| 8 emulated, view detached | **0** | **0 frames** | **TIMEOUT** | **TIMEOUT** | ok | **TIMEOUT** | ok |
| 9 emulated, attached but `setVisible(false)` | 1 | 54 (38) | 0.3 / 3100 ms (225) | 0.3 / 3100 ms (111) | ok | ok | ok |
| 10 emulated, attached at bounds (-5000,-5000) | 1 | 17 (9) | 0.4 / 3100 ms | 0.9 / 1100 ms | ok | ok | ok |
| 11 as 10 plus window hidden | 1 | 17 (9) | **TIMEOUT** | **TIMEOUT** | ok | ok | ok |

Also confirmed in state 2: `webContents.capturePage()` times out (hidden window), while `sendInputEvent` mouse events
did land (one click counted). So DESIGN.md's "sendInputEvent fails when hidden" is not reproduced for plain mouse
clicks here; CDP input stays the choice because it works in every attached state.

Notes and caveats:

- Screencast frames were all distinct hashes in states 1-4 and 6-7 (real new content, near 60 fps). In 5 and 9 the
  page's rAF drops to ~1/s while frames still arrive (distinct hashes, probably compositor/jpeg noise or cursor-like
  chrome, not animation); treat 5, 9, 10 as "frames arrive but content is throttled", state 8 as dead.
- `touchSeen` in the harness was unreliable (the page's touchstart counter only fired once, in state 1); for touch
  the signal is only whether the CDP call returns. It hangs when the view is detached and returns otherwise.
- `Input.dispatchMouseEvent` and `insertText` returned ok in every state, including detached (a click still reached the
  page in state 5/8, `mouseSeen` 1 of 2).
- State 3: shots at @2x timed out right after the first batch worked; minimized captureScreenshot is flaky.
- Bytes: a 390x844@3 screencast frame is ~18 KB when mostly static fixture content (up to ~36 KB when the compositor
  keeps larger surfaces); screenshots are 100-225 KB each. At 30 fps that is ~0.5-1 MB/s for screencast, which is fine over
  Tailscale; screenshot polling is 5-10x heavier per frame and slower.

## Recommendation for T35

1. **Primary frame source: CDP `Page.startScreencast`** (jpeg, quality ~60, `maxWidth` = phone viewport x DPR, ack
   every frame with `Page.screencastFrameAck`, `everyNthFrame` 2 to cap at ~30 fps for the phone). It keeps producing
   real frames at 50-60 fps when the window is hidden, minimized or occluded, with or without mobile emulation.
   Start it only while a remote viewer subscribes; stop it on unsubscribe.
2. **Input: CDP `Input.dispatchMouseEvent` / `dispatchTouchEvent` / `insertText`** (as the agent tools already do).
   Works in every attached state.
3. **Not a fallback: `Page.captureScreenshot` polling.** It times out whenever the window is hidden (states 2, 7, 11)
   and is slower and heavier even when visible. Use it only for a one-off thumbnail while the window is shown. There is
   no hidden-window fallback to it; if screencast fails, report "stream unavailable" to the viewer.
4. **Detached view (pane closed) is the one state that must be handled.** A view removed from the window gives 0 frames
   under emulation, ~1 fps page animation and hanging touch input. T35 must keep the tab in the window's view tree while
   a remote viewer needs it. Parking measured as: `setVisible(false)` (page ~1 rAF/s, input ok, screencast frames arrive) or
   off-screen bounds (17 fps, 1 rAF/s). Both throttle page rendering, so the best approach is an `ensureVisible`-like
   attach: when a viewer subscribes and the pane is closed, attach the tab at bounds inside the window (same size as the
   emulated viewport, under the desktop UI or at a tiny rect, to be verified by T35 against real pages), and detach again
   when the last viewer leaves. Do not reveal the pane (`events.reveal()`) for this: that changes the desktop UI.
   Untested here and left to T35: a 1x1 or fully covered attached rect, to see whether rendering stays at 60 fps.
5. Window hidden/minimized/occluded needs no attaching, as long as the view stays in the tree.

Limits: one run, synthetic page, no real sites; the CDP debugger is shared with the agent tools (one client per
`webContents.debugger`, multiplex commands through BrowserManager); screencast resolution should follow the viewer's
reported viewport, not a fixed 390x844.

## Parking result (T35)

`scripts/remote-browser-park.mjs` and a follow-up: a tab loaded detached and then added to the app window **while that
window is hidden** never renders (rAF 0, `dispatchTouchEvent` hangs), at any bounds. A 1px edge rect renders at 60 fps
only while the window is shown; an edge rect in a hidden window throttles to ~1 fps; 1x1 and far-offscreen rects do not
hit-test. A second `BrowserWindow` (`frame:false`, `transparent`, `focusable:false`, `setOpacity(0)`,
`setIgnoreMouseEvents(true)`, `showInactive()`) holding the view at full size rendered at 61 fps and took touches while the
app window was hidden. T35 parks watched tabs there (`BrowserManager.hold`/`release`) and destroys it when the last viewer leaves.
