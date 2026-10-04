# Responsive browser: measured design

Evidence for the responsive mode (user Dimensions toolbar, agent viewport API, agent-spawned windows). Measured on
Electron 44.5.1 (Chromium 152), macOS, 2x Retina display (1470x956 points), with `scripts/responsive-spike.mjs`
(`node_modules/.bin/electron scripts/responsive-spike.mjs`; prints `R <name> <json>`). A `WebContentsView` in
partition `persist:pigna-spike` with `webContents.debugger` attached ("1.3"), fixture served from a local http server.

## Measured results

| # | Assumption | Result |
|---|---|---|
| a | `Emulation.setDeviceMetricsOverride` once persists across navigation, reload, cross-origin navigation (127.0.0.1 -> localhost) | **Yes.** After 393x852@3 mobile: `innerWidth/Height` 393/852, `devicePixelRatio` 3, `(max-width:480px)` true, `screen` 393x852, unchanged after each of them. Also unchanged after DevTools open and close, and after `forcefullyCrashRenderer()` (`render-process-gone` reason `killed`) plus reload. The debugger stayed attached. No re-apply needed. Still re-apply on `debugger` `detach` events (user cancelled via DevTools banner / target closed) and when a tab's webContents is replaced. |
| a' | Fixture needs `<meta name=viewport content="width=device-width">` with `mobile:true` | Without it `mobile:true` gives the legacy 980px layout viewport (`innerWidth` 980, `innerHeight` 2125). That is real mobile behaviour, not a bug; do not "fix" it. |
| b | UA override + client hints + touch | `Emulation.setUserAgentOverride {userAgent, platform, userAgentMetadata}` changes the HTTP `User-Agent` on navigation, reload and cross-origin navigation (server saw the iPhone UA 3 of 3), `navigator.userAgent`, and `navigator.userAgentData` (`mobile:true`, `platform:"iOS"`, `model:"iPhone"`). `Emulation.setTouchEmulationEnabled {enabled:true,maxTouchPoints:5}` gives `maxTouchPoints` 5, `(pointer:coarse)` true, `(hover:none)` true. Reset (`userAgent:""`, touch off) restores the Electron UA and touch 0 on the next request. |
| b' | `Sec-CH-UA-Mobile` header seen by the server | **No, not from Chromium.** Electron 44 sends *no* `Sec-CH-UA*` request headers at all, even unemulated and with `Accept-CH` set; `--enable-features=UserAgentClientHint` changes nothing. **Alternative (measured yes):** `session.webRequest.onBeforeSendHeaders` adding `Sec-CH-UA-Mobile: ?1` and `Sec-CH-UA-Platform: "iOS"` for `details.webContentsId === tab.id` reached the server on navigation, reload and cross-origin navigation. `navigator.userAgentData` is already right via `userAgentMetadata`. |
| c | Fit-to-pane | **Use `scale`.** 1200x800 emulated into a 600x400 view with `scale:0.5`: page reports `innerWidth` 1200 / DPR 2, the whole viewport is visible in the view (native `capturePage` 1200x800 px = 600x400 pt at 2x, button drawn), real OS input (`sendInputEvent` at view x,y 63,63) hit the button at page clientX/Y 126,126 and `elementFromPoint` found it, and a `mousemove` gave the same, so the annotate picker (which uses `event.clientX/Y` and `elementFromPoint`) works unchanged. With scale 1 in the same small view, the page is laid out 1200x800 but the view is 600x400: the right/bottom three quarters are unreachable and Chromium resized the surface (native capture 2400x1600 px) instead of clipping, so clip/scroll is rejected. |
| c' | CDP `Input.dispatchMouseEvent` coordinates | **Contradiction with the plan's premise.** Coordinates are in *view (scaled) pixels*, not emulated CSS px, when `scale != 1`: x=125 landed at clientX 250 with `scale:0.5`. With `scale:1` they are CSS px (125 -> 125). The agent layer must send `x*scale, y*scale` (and `sendInputEvent` likewise). Snapshot/`getBoundingClientRect` coordinates stay in emulated CSS px, so conversion is one multiplication in `cdp()` input helpers. |
| d | `Page.captureScreenshot` size | `captureScreenshot` without clip returns the emulated viewport x DPR regardless of `scale` and of the view's bounds: 390x600 at DPR 1/2/3 gives 390x600, 780x1200, 1170x1800; 1200x800@2 with `scale:0.5` gives 2400x1600. Works with the window visible, with `win.hide()`, and with the view removed from the window. **Minimized window: every capture hangs** (4 s timeout, 3 of 3). `wc.capturePage()` while hidden also times out (known, matches DESIGN.md). After changing metrics while hidden, the first capture can still carry the previous metrics (first hidden capture returned 1170x1800 for DPR 1); take one throwaway capture or wait a frame after changing. |
| e | DevTools detached coexists with debugger | **Yes.** `openDevTools({mode:'detach'})` with the debugger attached: `isDevToolsOpened()` true, `Runtime.evaluate` works, emulation unchanged; unchanged after closing. |
| f | Detached window | `new BrowserWindow({useContentSize:true, show:false})` + `setAspectRatio(w/h)` + `showInactive()`: window did not take focus (`isFocused()` false, main window still focused). Moving the existing view with `removeChildView`/`addChildView` kept the debugger attached. In the new window the real `devicePixelRatio` is the display's (2), `screen` is the display's (1470x956), `maxTouchPoints` 0, so **DPR, screen and touch must be emulated**; after `setDeviceMetricsOverride {375x813, dpr 3, mobile}` the page reported them, CDP mouse click landed on the right element and `captureScreenshot` was 1125x2439 while the window was unfocused. `setContentSize(375,667)` gave exactly 375x667; with `setAspectRatio(16/9)`, `setContentSize(1280,720)` gave 1280x720. **Windows are clamped to the display work area**: asked 393x852 got 375x813 (work area is 845 tall including the title bar); 5000x3000 gave 1445x813; 1000x1000 under 16:9 gave 999x562. So a window cannot be larger than the screen. |

## Chosen mechanisms

1. **Viewport**: per tab, one `applyViewport(webContents, spec)` that sends, in order, `Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor: dpr, mobile, screenWidth: width, screenHeight: height, scale: fit}` then touch and UA calls. Reset (`Responsive`, no override): `Emulation.clearDeviceMetricsOverride`, `Emulation.setTouchEmulationEnabled {enabled:false}`, `Emulation.setUserAgentOverride {userAgent:""}`, clear the header hook. Applied once; re-apply on debugger `detach`, `render-process-gone` (belt and braces, it survived in the test) and when attaching a new webContents.
2. **User agent**: `Emulation.setUserAgentOverride {userAgent, platform, userAgentMetadata}` plus a session-level `webRequest.onBeforeSendHeaders` (one hook per session, a `Map<webContentsId, ViewportSpec>`) adding `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform` for emulated tabs only, because Electron sends none. Only mobile profiles override UA; desktop presets (Laptop, Desktop) and Responsive keep the native UA. Touch: `Emulation.setTouchEmulationEnabled {enabled: touch, maxTouchPoints: 5}` and `Emulation.setEmitTouchEventsForMouse {enabled: touch, configuration:'mobile'}` (the latter accepted without error; not further verified that mouse emits touch events, treat as best effort).
3. **Fit to pane**: `scale = min(1, paneW / width, paneH / height)` in `setDeviceMetricsOverride`, native view bounds = `round(width*scale) x round(height*scale)` centred in the pane. When Responsive (no emulation) nothing changes: the view fills the pane. Pane rect already includes the app zoom factor in `applyLayout()`; compute `scale` from the pane rect in DIPs after that conversion. Never leave `scale` at 1 with an oversized viewport.
4. **Input**: agent click/type coordinates are emulated CSS px (snapshot refs/rects); `cdp()` mouse helpers multiply by the active `scale` before `Input.dispatchMouseEvent`. OS input and the picker need no change.
5. **Screenshots**: CDP `Page.captureScreenshot` (no clip) gives emulated size x DPR. Keep CDP, never `capturePage`. Do not promise screenshots from a minimized window: detect `win.isMinimized()` and fail with a clear error (or `restore()`/`showInactive()` for agent windows); agent windows must never be minimized by us. Throwaway capture after a metrics change when the window is hidden.
6. **DevTools**: no conflict; nothing to do.
7. **Agent windows**: `BrowserWindow {useContentSize:true, show:false}`, then `showInactive()`; `setAspectRatio` only when the agent asked for an aspect ratio; add the tab's `WebContentsView` (a new tab with the same persist partition) filling the content size; emulate DPR/screen/touch/UA with the same `applyViewport`. Requests larger than the display work area are satisfied by emulation: window content = requested size scaled down (`scale` as in 3), the window keeps the requested aspect ratio. Clamp results are reported back to the agent (`window` actual size vs `viewport` emulated size).

## ViewportSpec

```ts
interface ViewportSpec {
  width: number;       // CSS px, 200..3840
  height: number;      // CSS px, 200..3840
  dpr: number;         // 1..4, fractional allowed (2.625)
  mobile: boolean;     // Emulation mobile flag; mobile layout viewport, overlay scrollbars
  touch: boolean;      // touch emulation; implied by mobile presets
  ua: "native" | "iphone" | "android" | "ipad";  // userAgent profile id; "native" keeps Electron's UA
  label: string;       // "iPhone 15", "Custom", "Responsive" ...
}
```

`null` / absent spec means Responsive (no override, view fills pane). The `ua` profile id maps to a UA string, `platform`, `userAgentMetadata` and the injected `Sec-CH-UA-*` values in one table in `src/shared/browser.ts`.

## Presets

| Label | width x height | dpr | mobile | touch | ua |
|---|---|---|---|---|---|
| Responsive | pane size, no override | native | no | no | native |
| Laptop | 1440x900 | 2 | no | no | native |
| Desktop | 1920x1080 | 1 | no | no | native |
| iPhone 15 | 393x852 | 3 | yes | yes | iphone |
| iPhone SE | 375x667 | 2 | yes | yes | iphone |
| Pixel 8 | 412x915 | 2.625 | yes | yes | android |
| iPad | 820x1180 | 2 | yes | yes | ipad |
| Custom | user width x height, dpr | any | toggle | toggle | native unless mobile toggled on (then iphone/android choice) |

Rotate swaps width and height (and keeps everything else). Desktop and Laptop use the native (Mac) UA; touch off.

## Limits and policy

- Per edge 200..3840 CSS px, dpr 1..4 (clamp, report the clamped value). Clamp in one shared pure function used by UI, IPC and agent.
- Agent windows: at most 4 open per session; closing the last tab/window frees the slot. Windows are never larger than the display work area (see f); emulation covers the rest.
- Window tabs: a tab lives in the pane (`surface: "pane"`) or in its own window. **Closing a window closes its tab**; "Return to pane" (`browserReturn`, `returnToPane`) is the explicit way back and closes the window without closing the tab. `popOut` moves a pane tab into a window sized to its viewport (or the pane size; that made-up viewport is dropped again on return). Window tabs stay in the tab strip (flagged `surface: "window"`), and `ensureVisible` never reveals the pane for them. Windows close with the app window; the 5th open window is refused with an error.
- Who may change a viewport: the user (toolbar) and the agent (its own tab or an adopted tab), **no approval needed**: it is not a navigation and does not leave the origin policy. Either may reset to Responsive.
- Persistence (Codex lesson, openai/codex#35756, #34335): the spec lives in `BrowserManager` per tab, not in the agent session; releasing control, ending a run or a session does not clear it. It clears only when the user picks Responsive / Reset or closes the tab. When the agent set it, the toolbar shows a visible badge ("Set by agent" with reset); a user change removes the badge.
- UA is changed together with viewport (Codex lesson, openai/codex#35576).

## Ordered interface list for the later nodes

1. `src/shared/browser.ts`: `ViewportSpec`, `UaProfileId`, `VIEWPORT_PRESETS`, `UA_PROFILES` (UA, platform, metadata, client-hint values), `clampViewport(spec)`, `rotateViewport`, `fitScale(spec, pane)`, `toInputCoords(x, y, scale)`; `AgentAction` variants `viewport` (set/reset/get) and `window` (open/close/list with width, height, aspectRatio, dpr, mobile); `BrowserState.viewport` + `viewportBy: "user"|"agent"`; vitest tests.
2. `src/main/browser/viewport.ts` (or in `manager.ts`): `applyViewport(wc, spec|null)`, the single session `onBeforeSendHeaders` hook map, re-apply on `debugger` detach and webContents replacement; `BrowserManager.setViewport(tabId, spec, by)` and the `applyLayout()` change (view bounds = spec*scale, centred).
3. IPC: `browser:set-viewport` and state push (`src/shared/ipc.ts`, `src/preload/index.ts`).
4. `BrowserPane.tsx`: Dimensions toolbar (preset menu, width x height, dpr, rotate, mobile toggle), agent badge and reset, centred scaled viewport frame.
5. `src/main/browser/agent.ts`: `viewport` actions, input scale conversion in `cdp()` helpers, minimized-window screenshot guard.
6. Agent windows in main: `BrowserWindow` creation per f, 4-per-session limit, size report, tab/view ownership, close on session end.
7. `resources/browser-extension.ts` tools (`browser_viewport`, `browser_window`) and `src/renderer/src/lib/tools.ts` labels; DESIGN.md update.

## Flags for the orchestrator

- The plan's "CDP input coordinates stay in emulated CSS px" holds only at `scale = 1`; with fit-to-pane they are scaled (c'). Covered by interface 5.
- Client hints: Electron sends no `Sec-CH-UA*` headers, so `setUserAgentOverride` alone cannot satisfy "Sec-CH-UA-Mobile matches"; the `webRequest` hook is required (b').
- Windows cannot exceed the display; "exact size" for large requests means emulated size, with a smaller native window (f).
- Screenshots from a minimized window hang (d); not solvable, guard it.
