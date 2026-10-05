# iPhone remote access for pi-gna: implementation plan

Status: DRAFT plan (companion of `iphone-remote.atp.json`, same folder). Written 2026-10-04 against `bcf41fa`
(v0.4.5). Every claim about the current code cites a file; line numbers are from that commit.

Goal: a mobile web app (PWA) with **feature parity, not identical layout**, used from Safari or the Home Screen over
Tailscale, controlling the pi-gna running on a host Mac. No App Store, no Apple review, no developer account.
Agents, tools, repositories, the browser and Computer Use stay on the host Mac.

---

## 1. Current architecture and coupling points

pi-gna is an Electron app (`docs/DESIGN.md`, Architecture). Main owns processes and stores; the renderer is React;
the preload exposes `window.studio` (`StudioApi`, `src/shared/ipc.ts`).

| Layer | What it owns | Evidence |
|---|---|---|
| `PiProcess` | one `pi --mode rpc` child per open chat, JSONL, id-correlated commands | `src/main/pi-process.ts` |
| `SessionHost` | handle → PiProcess, forwards records, main-owned approval choices (`requestChoice`) | `src/main/session-host.ts` |
| `AgentBridge` | loopback HTTP for pi extensions, per-chat bearer token, Host check | `src/main/bridge.ts:38` |
| Stores | `BoardStore`, `LamentStore`, `SettingsStore`, `ComputerStore`, `GithubStore` (JsonStore, push whole value) | `src/main/store.ts`, `index.ts:93-131` |
| Browser | `BrowserManager` (WebContentsView tabs attached to the app window), `BrowserAgent` (CDP) | `src/main/browser/manager.ts:75`, `index.ts:187` |
| Computer Use | `ComputerService` (Swift helper over a Unix socket), `ComputerAgent` (policy, approvals) | `src/main/computer/*` |
| ATP | plan watch, librarian CLI, held plans; **the runner is in the renderer** | `src/main/atp.ts`, `src/renderer/src/state/atp.ts:150` |
| Renderer state | session reducer, open chats, card/lament/review chat setup, queue ops, pins, bookmarks, ATP threads | `src/renderer/src/state/app.ts`, `lib/session.ts`, `lib/projects.ts`, `lib/bookmarks.ts` |

### Coupling points that block remote use

1. **Single-window fan-out.** `send()` writes to one `BrowserWindow` (`index.ts:89`); every push (`events`,
   `board:changed`, `auth:update`, …) has exactly one consumer and no sequence numbers, buffer or replay.
2. **IPC trust is window identity.** `trusted()` (`index.ts:209`) accepts only the app window's page. There is no
   user or device authentication anywhere, because none was needed.
3. **Renderer-chosen handles; no host-side dedupe.** `newHandle()` (`state/app.ts:186`), validated by `HANDLE`
   (`session-host.ts:20`). Only the renderer prevents two pi processes on one session file (`openSession` looks up
   `sessionPath` in its own store). `DESIGN.md` (pi RPC notes) says two pi processes prompting one file are not safe.
4. **The renderer decides process lifetime.** Leaving a chat closes it when `isDisposable` (`state/app.ts:255`,
   `lib/session.ts:549`). A second client would see its chat killed by the desktop switching chats.
5. **Authoritative session state exists only in the renderer.** `reduceHostEvent`/`hydrate` (`lib/session.ts`) are
   pure but run only in the window. Main keeps no transcript, pending dialogs or queue state, so a client that
   connects late cannot be brought up to date except by re-reading the file (which misses the live run).
6. **Business logic in the renderer.** The ATP runner (`state/atp.ts:150-260`, claim → worker chat → settle →
   commit), chat setups for Kanban triage/Investigate/Resolve/QA/Chat about it, lament Fix and PR Review
   (`state/app.ts:859-950`, `state/card-actions.ts`), and multi-step RPC sequences `editQueue`/`interrupt`
   (`state/app.ts:549-570`). They run only while the desktop window is alive and are not atomic across clients.
7. **Approvals are answered blindly.** `respondUi` forwards whatever arrives (`session-host.ts:197`); dialogs are
   removed only by the renderer that answered. With two clients both could answer, and the other keeps a stale card.
8. **App lifetime is window lifetime.** `window-all-closed` quits (`index.ts:480`). `BrowserManager` is built on
   the window (`index.ts:187`) and closes device windows with it.
9. **Host-local UI side effects inside APIs.** Native dialogs (`pickFolder`, `pickAttachments`), `shell.showItemInFolder`
   (`piSettingsReveal`), opening OAuth pages on the Mac (`index.ts:321`), `openExternal`, `webUtils.getPathForFile`.
   For a phone these must be per-client (open on the phone) or replaced (upload, folder browser).
10. **Per-window localStorage holds user data.** Pins (`lib/projects.ts`), bookmarks (`lib/bookmarks.ts`), ATP
    threads (`state/atp.ts:55`). A second client would not see them.
11. **The raw RPC passthrough.** `command(handle, RpcCommand)` sends any RPC command to pi. Safe for the trusted window;
    a remote surface needs an allowlist (the renderer never uses `bash`, `new_session`; grep of `src/renderer`).

What is already good for remote: stores validate every op with pure functions in `src/shared`; Computer Use and
browser policy live in main (`computer/agent.ts`, `bridge.ts`), not in the renderer; approvals already travel as
`extension_ui_request` events, so any client that sees session events can render them; GitHub tokens never leave
main (`DESIGN.md`, GitHub); `AuthState` carries no secrets (`src/shared/auth.ts`).

### Decision: where moved logic lives (main, not pi extensions)

pi extensions stay the home of agent-facing tools (`kanban_*`, `browser_*`, `lament`, `computer_*`, `atp_pause`),
unchanged. Orchestration across chats (the ATP runner, card/lament/review chat setups, leases, approvals arbitration)
moves to Electron main: an extension lives inside one pi process and dies with its chat, cannot own the other pi-gna
chats it would start (their events, approvals and tools flow through `SessionHost`), and does not hold the shared
stores. Main is the only long-lived process that owns processes, stores and both clients.

### Decision: what changes on the desktop and what does not

The desktop renderer is **not rewritten**. It keeps IPC, its components and its local reduction of events (it never
misses one, so it needs no replay). The shared contract sits in main: one `HostCore` method table that IPC and
the remote server both dispatch to. The desktop changes only where the coupling points above force it: it calls
host methods for logic that moves to main (points 6, 10), attaches/detaches instead of closing (3, 4), drops
approval cards on `dialog_resolved` (7), and adopts chats another client started.

---

## 2. Feature inventory and mobile strategy

Verified against the app (README "What you get", `DESIGN.md`, `src/renderer/src/components/*`, `src/shared/ipc.ts`).
Classes: **R** reusable directly (shared code/components with layout changes), **T** needs a touch interface
or a remote transport, **H** host-only capability exposed to the phone, **L** genuine iOS/remote limitation,
**D** explicitly deferred.

| Feature (desktop) | Class | Mobile strategy |
|---|---|---|
| Chat list by project, pins, attention marks (running/waiting/failed/unread) | R | Navigation stack: Projects → Chats → Chat. Pins move to a host store; unread is per device. |
| Open existing session, new chat, close chat (stops pi) | R/T | Host-issued handles, attach/detach leases; Close is an explicit confirmed action. |
| Open a project folder (native picker) | T | Host folder browser (directories only) via a new host method. |
| Transcript: markdown, shiki, work accordion, tool rows, diffs, thinking, images, time dividers | R | Reuse `Transcript`, `Markdown`, `Activity`, `ToolDetails`; diffs scroll horizontally; tool details in sheets. |
| Streaming, tok/s, context meter, compaction indicator, Compact now | R | Same reducer (moved to `src/shared`); meter opens on tap instead of hover. |
| Composer: send, steer, Alt+Enter follow-up, Esc-Esc stop, queue card (steer now/edit/delete) | T | Buttons for Send / Queue / Stop (confirm); queue ops become one atomic host op. |
| `/` commands, `@` file mentions, model and thinking pickers | R/T | Same data (`get_commands`, `listFiles`); bottom sheets. |
| Attachments: photos, files/folders by path, paste, drop | T | Upload to the host (stored under userData), returned as paths; images also as image content; host files via the folder browser. |
| Approval cards (`select`/`confirm`/`input`/`editor`), notify toasts, widgets, `set_editor_text` | R | Same cards; first answer wins host-side; `dialog_resolved` clears others. |
| Turn rail, bookmarks, ⌥↑/⌥↓ | T | Jump list sheet; bookmarks move to the host store. |
| Inline visuals (beta) | T/L | Sandboxed iframe served from the remote origin with the same frame CSP; tap-to-render; no process kill on iOS, so a watchdog removes a stuck frame. |
| Right-click menus (copy/save image, links, chats, cards, tabs) | T | Long-press action sheets; iOS handles text/image copy natively; links open on the phone. |
| Kanban: board per project, drag and drop, add card (+screenshots), card dialog, tags, GitHub links, card actions (Investigate/Resolve/QA/Chat about it, triage) | T | Column pager; "Move to…" and long-press reorder; actions call host methods; text edits carry a base revision. |
| Laments: list, reports, Fix (worktree chat), resolve/reopen/delete | R | Same list; Fix is a host method. |
| GitHub: issues/PRs, account choice, body, New card, Link to card, **Review a PR** (pr-review chat) | R | Same; "Open on GitHub" opens on the phone; Review is a host method. |
| ATP: plans, graph, node panel, Start/Stop/Resume, interrupted, orchestrator chat, New plan | T | Runner moves to the host; node list by status plus a touch pan/pinch graph; orchestrator as a full chat. |
| Integrated browser: tabs, address bar, back/forward/reload, viewport emulation, pop-out windows, comment mode (annotations) | T/H | Frames streamed from the host tab, input sent back (tap, scroll, type, keys); comment mode picks the element at the tapped point on the host. Pop-out windows: host-only (H). |
| Agent `browser_*` tools, URL approvals | H | Unchanged on the host; approvals reach the phone as cards. |
| Computer Use: per-app approvals, Esc stop, overlay, always-allow list, permissions | H/L | Approvals and Stop from the phone; read-only live preview of apps a chat holds; macOS permission grants only on the Mac (L). The user operating Mac apps directly from the phone is a non-goal (use macOS Screen Sharing over Tailscale). |
| Settings: General, Appearance, shortcuts, Models (task models), Agent (pi settings), Beta, Features, Computer use, Providers | R/T | Same ops; "Reveal in Finder"/"Open System Settings" hidden; theme on the phone follows iOS. Keyboard shortcuts page hidden. |
| Providers: OAuth logins, API keys, Claude Code login | T/L | API keys and device-code flows from the phone; auth URLs open on the phone; flows whose callback hits the Mac's localhost fall back to manual code paste or "finish on the Mac" (L). Credentials go phone → host, never back. |
| Updates: available/downloading/ready, Restart now | R/D | Status and Download on the phone; Restart stays host-only in v1 (it drops the remote server and every chat). |
| Toasts, lightbox, empty-state wallpaper | R | Reused. |
| Unread marks / "seen" logic | T | Host records settle outcomes; each device keeps its own seen marks. |
| `pi --pigna` launch, terminal log, single-instance handoff, DevTools | H | Host-only, unchanged. |
| **Terminals** (listed in the brief) | n/a | pi-gna has **no integrated terminal**: `bash` tool output streams in the transcript (`tool_execution_update`) and `bash_execution` messages render read-only; the RPC `bash` command is unused by the UI. Parity needs none; a remote shell is out of scope (see non-goals). |
| **Files/diffs** (listed) | R | There is no file browser: files appear as tool results, `edit` diffs, `@` mentions and attachments; all covered above. |
| **Reviews** (listed) | R | GitHub PR Review (above). |

Missing from the brief and added: laments, GitHub issues/PRs, inline visuals, providers/login, updates, context
meter and compaction, queue editing, turn rail/bookmarks, unread/attention marks, browser comment mode and viewport
emulation, PR review skill chats.

---

## 3. Proposed design

### 3.1 Process and deployment model

```
iPhone (Safari or Home Screen app)
  └─ HTTPS https://<mac>.<tailnet>.ts.net   (Tailscale on iOS, WireGuard)
       └─ tailscale serve (on the Mac, tailnet only, never Funnel) → http://127.0.0.1:<port>
            └─ RemoteServer (Electron main, node:http, no dependencies)
                 ├─ auth: device cookie → DeviceStore; Host/Origin allowlist; CSRF header
                 ├─ /api/<method> → HostCore method table  ←── IPC (desktop window) uses the same table
                 ├─ /api/events (SSE, Last-Event-ID replay) ← EventHub (seq, ring buffer)
                 └─ /, /assets, /sw.js, /manifest → out/mobile bundle (strict CSP)
HostCore: SessionRegistry (PiProcess, leases, snapshots), command layer (idempotency, allowlist, dialogs),
          stores (board, laments, settings, devices, ui-state), ATP runner, chat setups, browser remote, computer
AgentBridge (unchanged: loopback, per-chat tokens, pi extensions only)
```

- **One host:** the Mac where pi-gna runs. The same build works on a dedicated always-on Mac (mini) with
  auto-login and "Open at login". No cloud execution, no task migration.
- **Remote access is off by default.** The server binds `127.0.0.1` only and starts only when enabled. pi-gna offers
  a button that runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` and one that turns it off, only on
  explicit click; it refuses when Funnel is on for that port and never enables Funnel.
- **Window close hides while remote access is on** (the app keeps serving; Dock click reopens). Quit warns that
  paired devices lose access and running chats stop. This keeps `BrowserManager` and its window alive with no
  refactor of the browser.
- **Keep awake:** `powerSaveBlocker.start("prevent-app-suspension")` while remote access is on (setting: always, or
  only while a chat or plan runs). It prevents idle system sleep, lets the display sleep, and **cannot** keep a
  closed-lid MacBook awake: macOS only stays awake lid-closed with power and an external display (clamshell mode).
  The Settings copy says so; truly laptop-independent use needs an always-on host. No `pmset`/privileged hacks.

### 3.2 Backend contract (`HostCore`)

- A method table `name → { validate(args), run(ctx, args), scope }` in main, built from today's `registerIpc`
  handlers (`index.ts:224-370`). `ctx` carries the caller (`desktop` or `device:<id>`) for logging, presence and
  per-client replies. `scope` marks host-UI-only methods (native pickers, reveal in Finder, open System Settings,
  relaunch) that the remote server refuses.
- IPC registers every method from the table (same `trusted()` check). The remote server exposes the table minus
  host-UI-only methods. No route forwards to the AgentBridge, and there is no raw RPC passthrough: clients send
  an **allowlist** of RPC commands (prompt, steer, follow_up, abort, clear_queue, set_model, set_thinking_level,
  compact, abort_retry, get_state, get_available_models, get_available_thinking_levels, get_session_stats,
  get_commands, set_session_name). `bash` and `new_session` are refused remotely (the desktop UI uses neither).
- New host methods replacing renderer logic: `chat.open/attach/detach/close`, `chat.snapshot(handle, before?)`,
  `chat.send` (composes card block, file mentions, annotations, images host-side from ids), `chat.interrupt`,
  `chat.editQueue`, `chat.respondDialog`, `chat.startTask` (triage, investigate, resolve, qa, fix, review, discuss),
  `atp.start/stop/resume/releaseInterrupted/threads`, `ui.pins/bookmarks`, `fs.browseFolders`, `uploads.put`,
  `browser.view/input`, `computer.preview`, `devices.*`, `remote.*`.

### 3.3 State synchronization

- **EventHub:** every push gets a host-global monotonic `seq` and a `bootId` (random per launch). Topics:
  `global` (projects, attention summary, board, laments, settings, computer policy, ATP plans/held/runners, browser
  state, update) and `chat:<handle>` (session events, dialogs, `dialog_resolved`, lease changes). A ring buffer keeps
  the latest events (bounded by count and bytes). The desktop window is one subscriber; SSE streams are others.
- **Snapshots:** each value carries the `seq` it reflects. Chats: main runs the same pure reducer
  (`lib/session.ts` moved to `src/shared/session-state.ts`) on hydrate + live events, so `chat.snapshot` returns the
  authoritative `SessionState` including the streaming partial message, pending dialogs and queue, paged by turns
  (the desktop's "Show earlier turns" model). Clients apply only events with `seq > snapshot.seq`.
- **Reconnect:** `EventSource` reconnects with `Last-Event-ID: <bootId>:<seq>`. Same boot and still in the ring →
  replay the gap, then live. Otherwise → `resync` event → client refetches snapshots. A new `bootId` (host restarted)
  always resyncs. Heartbeat comment every 15 s; client watchdog reconnects after 35 s silence and on
  `visibilitychange`/`pageshow`/`online`.
- **Subscriptions:** a stream subscribes to `global` plus the chats it is showing (`POST /api/subscribe`), so
  background streaming of other chats does not cost phone bandwidth; the attention summary keeps their marks live.
- **Backpressure:** if a stream's `writableLength` exceeds a cap, the server stops writing, sends `resync` when it
  drains (or closes it), never buffers without bound. Browser frames are latest-only (dropped, not queued).

### 3.4 Commands, multi-client control and concurrency

- **Idempotency:** every mutating remote call carries `Idempotency-Key` (client UUID). The host caches
  `(bootId, key) → result` per chat/store for 10 minutes; a retry after a network drop returns the first result and
  never sends a second prompt. After a host restart old keys are unknown: the call fails with `host_restarted`
  and the client shows the transcript instead of resending.
- **Ordering:** per-chat command mutex in main, so `editQueue` (clear → transform → re-queue) and `interrupt`
  (clear_queue → abort, returning restored text to the caller) are atomic against other clients.
  (pi RPC can only clear and append its queues; an upstream pi `edit_queue` RPC command would make this native.
  Until then the host mutex is the fix.)
- **Prompts from two clients:** both delivered in arrival order; while running, a send is a steer unless the client
  asked for follow-up (today's semantics, `state/app.ts` `send`).
- **Approvals:** main records every `extension_ui_request` dialog (and its own `requestChoice` ids). The first
  response wins; main emits `dialog_resolved { id, by }`; later responses get `409 already answered`. pi's dialog
  timeouts and chat exit settle them (`settleChoices` today). Computer Use and browser URL approvals keep their
  semantics (Allow once / Always / Deny) whichever client answers; the device is logged.
- **Cancellation:** Stop/abort from any client, idempotent, broadcast through events. Closing or suspending a
  client never cancels anything.
- **Leases:** a client attaches to a chat while it shows it; the host stops a pi process only when it has no
  leases and `isDisposable` holds (not prompted, not running, not compacting, no dialogs, no unread outcome). Close
  chat is explicit and broadcast. Opening a session file that is already live attaches to the same handle.
- **Background chats:** "close when done" (triage) and ATP worker auto-close check presence (no client viewing the
  chat), replacing the renderer's `active !== handle`.
- **Stores:** pushed values carry `rev`. Free-text edits (card title/notes/tags, settings strings) carry `baseRev`;
  a stale edit fails with a conflict and the client reloads. Structural ops (move, attach, link) stay
  last-writer-wins, validated by the existing pure `applyOp`/`applyLamentOp`.
- **ATP:** one runner per plan in main; Start/Stop idempotent; `held` already lives in main.
- **Composer drafts** are per client and not synced (non-goal).

### 3.5 Authentication, pairing, revocation

- **Device credential:** 32 random bytes, sent once as cookie `pigna_device` (`HttpOnly; Secure; SameSite=Strict;
  Path=/; Max-Age` ≈ 400 days, persistent because iOS 17.x dropped session cookies in Home Screen apps). The host stores
  only `sha256(token)` with device id, name, user agent, tailnet login, created, last seen (`userData/remote-devices.json`).
- **Pairing (requires the Mac):** Settings > Remote access > Pair a device shows a one-time code (8 chars, 5 min TTL,
  single use, 5 attempts) and the URL as a QR code. The phone posts the code and a device name; the **Mac shows an
  approval prompt** with the device's user agent and `Tailscale-User-Login`; only Allow issues the credential.
  Home Screen apps do not share storage with Safari (WebKit bug 181849), so pairing works inside the installed app
  (the landing page explains Add to Home Screen first).
- **Every request:** Host header must be the configured `<mac>.<tailnet>.ts.net` name; mutating requests need a
  same-origin `Origin` and `X-Pigna-Client: 1` (CSRF). `Tailscale-User-Login` must be present and match the login
  recorded at pairing (defense in depth only: a local process can forge it by calling 127.0.0.1 directly, so the
  device credential is the real gate). AgentBridge tokens are never accepted.
- **Revocation:** from the Mac (or any paired device) per device or all; revoked streams close at once. Turning
  remote access off stops the server. Pairing new devices, turning remote access on, and `tailscale serve` need
  the Mac.
- **Credentials stay on the host:** no API returns provider keys, gh tokens, cookies of the browser profile or
  pi's `auth.json`. The phone can *send* an API key to the host (Providers) but never read one back.
- **XSS containment:** the mobile bundle gets a strict CSP (no inline script, `connect-src 'self'`, `frame-src`
  only the visual frame path, `img-src 'self' data: blob:`); markdown stays DOMPurify-sanitized; visuals run in
  `sandbox="allow-scripts"` frames with opaque origins and `connect-src 'none'`.
- **Audit:** remote calls are logged with the device id in `main.log` (method names, not payloads).

### 3.6 Mobile client

- A second Vite build (`src/mobile/`, output `out/mobile`, shipped in the asar) reusing `src/shared`, renderer `lib/`
  and transcript components; mobile shells (navigation stack, sheets, safe areas, `visualViewport` for the keyboard).
- `HostClient` over `fetch` + `EventSource` with a connection state machine: connected, reconnecting, host
  unreachable (last known state shown read-only, drafts kept, nothing auto-resent), unauthorized (→ pairing).
- `manifest.webmanifest` (`display: standalone`), apple-touch-icon, service worker caching only the app shell by build
  id (never API data); `/api/hello` returns the build id and `bootId`; a mismatch reloads.

### 3.7 Notifications (separate design, later phase)

Tailscale does not deliver pushes, and nothing reaches a suspended iOS page. Candidate: **Web Push** for Home Screen
apps (iOS 16.4+): VAPID keys generated on the host, subscriptions per device (revoked with the device), RFC 8291
encryption with `node:crypto`, sent from the host to Apple's push service over the public internet. Payloads carry
only an event kind and an opaque chat id (no transcript text); the app fetches details over Tailscale when opened.
No delivery while the host is asleep or offline. A design node decides go/no-go before implementation.

---

## 4. Tasks

The executable DAG is `iphone-remote.atp.json` (44 nodes, ids `T01`–`T44`). Phases:

| Phase | Nodes | Outcome |
|---|---|---|
| 0 Design and spikes | T01–T03 | `docs/REMOTE.md` contract; browser frame source measured; iOS constraints sourced |
| 1 Host core | T04–T10 | EventHub, shared reducer, session registry with leases and snapshots, command semantics, minimal desktop adaptation, store revisions, host-mode lifecycle and keep-awake |
| 2 Remote server and security | T11–T15 | Device auth, HostCore method table, RemoteServer (SSE), desktop Remote access settings and pairing, security test suite |
| 3 Vertical slice | T16–T21 | Mobile build and PWA shell, HostClient, pairing, chat slice, automated slice e2e, **real iPhone gate** |
| 4 Host logic moves | T22–T24 | Chat setups/card actions/fix/review on the host, ATP runner on the host, pins/bookmarks store |
| 5 Mobile parity | T25–T37 | Projects, composer, attachments, transcript extras, Kanban, Laments, GitHub, ATP, Settings, Providers, browser (host + mobile), Computer Use |
| 6 Notifications | T38–T39 | Design decision, then Web Push (or a recorded deferral) |
| 7 Hardening | T40–T44 | Multi-client and resilience tests, threat model review, docs, **final real-device gate** |

T21 and T44 are human gates: a worker prepares and runs everything automatable and fails the node until you record
real-iPhone results in `docs/REMOTE_VERIFICATION.md`.

---

## 5. First vertical slice (T16–T21)

Validates, on a real iPhone, from the Home Screen app:

1. Pair: enable remote access, serve over Tailscale, pair with code + Mac approval, revoke and re-pair.
2. Open an existing session started on the desktop; the desktop keeps it open and both show the same transcript.
3. Send a prompt; tokens stream on the phone and the desktop at the same time.
4. An approval card (fake-pi `confirm`, and a real browser URL approval) appears on both; answering on the phone
   clears it on the desktop; a second answer is refused.
5. Stop from the phone ends the run (queued text restored to the phone's composer).
6. Reconnect: lock the phone mid-run for 2 minutes, toggle airplane mode, switch Wi-Fi → cellular; on return the
   transcript is complete with no duplicated or missing text, and retrying a send that already landed does not
   prompt twice. Closing the app mid-run leaves the host run going.

---

## 6. Verification

| Area | How |
|---|---|
| Unit | vitest for EventHub (seq, ring, resync), reducer in `src/shared`, registry leases/dedupe, idempotency cache, dialog first-wins, DeviceStore (hashing, TTL, attempts, revoke), store revisions, web-push crypto vectors (RFC 8291 test vector) |
| Server integration | node:http client tests against RemoteServer: auth on every route, SSE replay/resync, backpressure, body limits |
| Security | T15 suite (unauthenticated, Host/Origin, CSRF, bridge token, revoked stream, brute force, secret leakage) and T42 threat model review |
| Multi-client | T40: desktop + two clients: concurrent prompts, double answers, abort vs steer, queue edits, conflicting card edits, ATP start races, lease/close |
| Resilience | T41: ring overflow, slow consumer, host restart (bootId), server pause (sleep simulation), idempotency after restart |
| Desktop regressions | existing `pnpm test`, plus test instances per `DESIGN.md` "Verifying the UI" (fake-pi, own profile, own port) |
| Mobile UI (automatable) | the mobile bundle in pi-gna's browser with iPhone emulation (layout, touch), and the iOS Simulator via `xcrun simctl openurl` when Xcode is installed (WebKit, standalone) |
| Real iPhone (human) | `docs/REMOTE_VERIFICATION.md` runbook: Safari and Home Screen, pairing inside the installed app, network changes, suspension, closing the app mid-run, Mac display sleep vs system sleep, lid closed without external display (expected: unreachable, recovers on wake), Mac quit/restart, multiple phones/desktop, revoke while connected, every parity screen |

---

## 7. Risks, open decisions, non-goals

### Risks

- **Browser frames while the window is hidden** (high). Chromium stops compositing hidden views (`DESIGN.md`,
  Browser: "Current display surface not available"). `Page.startScreencast` may stall; `Page.captureScreenshot`
  works hidden (the agent already uses it). T02 measures both; fallback is screenshot polling at a few fps.
- **iOS Home Screen storage and cookies** (medium). Separate from Safari; WebKit bug 272325 reported session cookies
  reset in 17.x. Mitigated by persistent cookies and a cheap re-pair; verified on device in T21.
- **SSE on iOS** (medium). Connections die on suspension; recovery relies on replay and resync, tested in T20/T41.
- **Concurrency regressions on desktop** (medium). Leases and host handles change desktop lifecycles; T08 is
  verified with fake-pi test instances, and T40 adds multi-client tests.
- **Moving the ATP runner** (medium). Behavior must stay identical (claims, nudge, release, commit); T23 keeps the
  existing tests and adds runner tests in main.
- **Exposure of a powerful surface** (high impact). A paired phone can do anything the desktop user can, including
  starting agents that run shell commands. Mitigations: tailnet-only, off by default, Mac-approved pairing, revocation,
  CSP, audit log, no raw transports.
- **Inline visuals on iOS** (low). A runaway script cannot be killed by process; tap-to-render and a watchdog limit it.
- **Web Push leaves the tailnet** (decision). Payloads are minimal and encrypted; still an external dependency.

### Open decisions (defaults proposed; T01 records the final choice)

1. Port: fixed default `4517`, editable. 2. QR code: bundle a small MIT QR encoder in the renderer (renderer deps are
bundled; main stays dependency-free) vs URL + code only. 3. Whether a paired device may revoke *other* devices
(proposed: yes, for a lost phone). 4. Keep-awake default: "while a chat or plan runs" vs "always while remote is on".
5. Web Push go/no-go (T38). 6. Update Restart from the phone (proposed: host-only in v1). 7. Device scopes
(read-only devices) are not in v1.

### Non-goals

- A native iOS app, App Store/TestFlight distribution, an Apple developer account.
- Cloud execution, moving running work between hosts, multi-host management.
- Public exposure (Funnel), unauthenticated listeners, exposing the AgentBridge or raw RPC.
- Copying host credentials (provider keys, gh tokens, browser cookies) to the phone.
- Operating Mac apps manually from the phone (use macOS Screen Sharing over Tailscale); granting macOS permissions remotely.
- A remote terminal/shell (pi-gna has no terminal today).
- Privileged sleep hacks (`pmset disablesleep`), promising closed-lid operation without clamshell mode.
- Syncing composer drafts between clients; pixel-identical desktop layout on the phone.
