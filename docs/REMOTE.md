# Remote access: the contract of record

Status: contract of record for the iPhone remote epic (`docs/plans/draft/iphone-remote.md`, nodes T01–T44). Where this
file and the plan differ, **this file wins**. The types live in `src/shared/host-api.ts`; this file is the prose
and the decisions. Written 2026-10-04 against v0.4.5 (`bcf41fa` + working tree).

Goal: a mobile web app (PWA) with feature parity (not identical layout), used from Safari or the Home Screen
over Tailscale, controlling the pi-gna running on the host Mac. Agents, tools, repositories, the browser and
Computer Use stay on the host. The desktop renderer is not rewritten: it keeps IPC and local reduction of
events, and gains only what the coupling points below force.

Invariants (every node keeps them): closing or suspending a client never cancels host work; no unauthenticated
listener; remote access off by default; the AgentBridge stays loopback-only and is never exposed; no raw RPC
passthrough remotely; no host credential ever reaches the phone; no privileged sleep hacks; no native iOS app.

## 0. Corrections to the plan (re-verified against the code)

The coupling points in plan section 1 all hold. Line numbers drifted; current ones:

| Plan claim | Code today |
|---|---|
| `send()` single-window fan-out, `index.ts:89` | `index.ts:~90` (`send` writes to `window.webContents` only) |
| `trusted()` `index.ts:209` | `index.ts:209` (window identity + app origin) |
| `registerIpc` handlers `index.ts:224-370` | `index.ts:228-380` (every handler listed in `IPC`, `src/shared/ipc.ts`) |
| stores `index.ts:93-131` | `index.ts:101-125` |
| `window-all-closed` quits, `index.ts:480` | `index.ts:480` |
| `newHandle()` `state/app.ts:186`, `isDisposable` `:255` / `lib/session.ts:549` | same (`app.ts:186`, `closeSession` at `:258` uses `isDisposable`) |
| ATP runner `state/atp.ts:150-260` | `startPlan` at `atp.ts:150`, `stopPlan` `:294`, `releaseInterrupted` `:307`, `orchestrator` `:333` |
| chat setups `state/app.ts:859-950` | `startCardChat :864`, `discussCard :874`, `startAtpChat :936`, `fixLament :763`, `reviewPullRequest :787` |
| `editQueue`/`interrupt` `:549-570` | `editQueue :549`, `interrupt :560`; pure part is `lib/queue.ts` `applyQueueOp` |

Two additions the plan missed:

- **`send` composes host-visible text in the renderer** (`state/app.ts:410`): card block, annotations, file
  mentions, images, and it clears attachments/annotations and attaches the chat to the card after success. A
  remote client cannot do that, so `chat.send` composes host-side from ids (section 3).
- `SessionState` and its reducer live in `src/renderer/src/lib/session.ts`. `src/shared` cannot import from the renderer,
  so `host-api.ts` carries `SessionStateJson` as an opaque placeholder until T05 moves the reducer to
  `src/shared/session-state.ts`; T05 replaces the alias with the real type.

## 1. HostCore method table

One table in Electron main, `name → { scope, mutates, validate(args), run(ctx, args) }`, built from today's
`registerIpc` handlers.

- **`name`**: dotted, `<area>.<verb>`; the key of `HostMethods` in `src/shared/host-api.ts`.
- **`args`**: one JSON object (never positional), `result`: a JSON value. `validate` throws a `HostError`
  `bad_request`; it is where today's ad-hoc `String(x).slice(...)` and `project(cwd)` checks go. IPC adapters map the
  preload's positional calls to the object.
- **`ctx`**: `{ caller: "desktop" | { device: DeviceId }, clientId, bootId }`, for logging (method names only,
  never payloads), leases, presence, `dialog_resolved.by`, per-client replies.
- **`scope`**: `"remote"` (IPC and the remote server) or `"desktop"` (IPC only; the remote server answers
  `403 scope_denied`). Host-UI methods are `desktop`: native pickers, Finder/System Settings, relaunch, window focus,
  window-bound browser layout, opening a URL on the Mac.
- **`mutates`**: requires `Idempotency-Key` remotely (section 6).
- IPC registers every method (same `trusted()` check). IPC keeps its existing channel names as aliases until a
  later node replaces them; the table is the contract. The remote server exposes `POST /api/call/<name>` for
  `scope: "remote"` methods only.

### 1.1 Method list

`replaces` names the IPC channel(s) (`IPC` in `src/shared/ipc.ts`) the method replaces or wraps; "new" has no
channel today. Arg/result types are in `host-api.ts` (`HostMethods`).

**chat** (host-owned handles, leases, atomic commands)

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `chat.list` | remote | no | `listSessions`. Projects with sessions (`ProjectGroup[]`). |
| `chat.open` | remote | yes | `openSession`. Args `{ request: OpenSessionRequest }`. **Host issues the handle.** Opening a session file already live attaches to its handle (`reused: true`); otherwise spawns pi. Takes a lease. Returns `{ handle, reused }`; the desktop also gets `snapshot` (its first page with the outline of earlier turns, see DESIGN.md), a remote caller reads the chat with `chat.snapshot`. ATP sessions via `request.atp`. |
| `chat.attach` | remote | no | new. Lease on a live chat + snapshot (reconnect, second client, adopt a chat another client started). Returns the flat `ChatSnapshot & { seq }` (the first page and the outline) to the desktop and only `{ seq }` to a remote caller (which pages through `chat.snapshot`), or null when the chat ended. |
| `chat.viewing` | remote | yes | new. This client shows (or stops showing) the chat in the foreground; showing it clears the chat's unread mark. A chat a client views is never stopped for being idle. |
| `chat.shown` | desktop | yes | new. The window has the chat on screen, focused or not (its active chat, also behind a page, and a page's side chat): the host does not stop its pi for being idle. |
| `chat.live` | remote | no | new. `AttentionSummary[]` of every live chat (first paint of the marks; `global` `attention` events carry the deltas). A summary carries the chat's `sessionPath`, which matches it to its row in `chat.list`, and `listed` (`isListed`: not a draft, triage or ATP chat), so the phone's lists show it before the index has its file. |
| `chat.detach` | remote | yes | new. Releases the lease; the host may then dispose (section 5). |
| `chat.close` | remote | yes | `closeSession`. Explicit stop of pi; broadcast to all clients. Mobile asks for confirmation. |
| `chat.snapshot` | remote | no | new. `{ seq, value: ChatSnapshot }`, the last `turns` turns (1 to 40, default 40; the phone opens with 6 and pages 20), fewer when they pass about 2 MB (never none); `before` (a turn index, the previous page's `turns.from`) pages earlier ones, whose `state` carries just their items (each tool run is on the assistant item that made the call). The desktop pages through it too (`pageSession`). |
| `chat.send` | remote | yes | the `send` action in `state/app.ts` plus `command(prompt)`. Args: text, mode (`send`/`followUp`), `attachments` (upload ids or host paths), `annotationIds`, `cardId`. Host composes the message (card block, annotations, file mentions, images), picks `streamingBehavior`, marks the chat prompted. |
| `chat.command` | remote | yes | `command`, restricted to the RPC allowlist (section 7). Result `RpcResponse`. |
| `chat.interrupt` | remote | yes | `interrupt` (`app.ts:560`): clear_queue then abort under the chat mutex; returns the restored queued texts (`string[]`). |
| `chat.editQueue` | remote | yes | `editQueue` (`app.ts:549`): clear, `applyQueueOp`, re-queue under the mutex; true when the queue held the text. |
| `chat.respondDialog` | remote | yes | `respondUi`. First response wins; a later one is answered `{ ok: false, code: "already_answered" }` (a `DialogAnswer`, not an HTTP error; section 8). |
| `chat.startTask` | remote | yes | new; absorbs `startCardChat`, `discussCard`, `fixLament`, `reviewPullRequest`, `cardWorktree`, `lamentWorktree`, triage. Kinds: `triage`, `investigate`, `resolve`, `qa`, `discuss`, `fix`, `review` (review takes `cwd`, `repo` and `item` as GitHub lists them, and `login`). Host-side (`src/main/chat-tasks.ts`): worktree, link to the card/lament, model, prompt, name, under a host lease that ends when the first run settles; a triage that ends well and that nobody views closes. Returns `{ handle, snapshot, notices }` (`notices` are what the client toasts). `board.addCard` (cwd, column, description, attachments of image bytes or host paths) adds a card, saves its images and starts its triage. `chat.send` composes `cardId` host-side; annotations follow with the phone's annotations. Landed in T22. |
| `chat.files` | remote | no | `listFiles` (`@` mentions). |
| `chat.compactionSettings` | remote | no | `compactionSettings`. |
| `chat.rawCommand` | desktop | yes | `command` unrestricted. Kept only until the desktop uses `chat.command`/`chat.send`; then removed. |

**stores** (every value carries `rev`; section 9)

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `board.get`, `board.apply` | remote | apply yes | `boardGet`, `boardApply` (`BoardOp`; text edits carry `baseRev`). |
| `board.saveImage` | remote | yes | `boardSaveImage` (a card image, base64). |
| `laments.get`, `laments.apply` | remote | apply yes | `lamentsGet`, `lamentsApply`. |
| `settings.get`, `settings.apply` | remote | apply yes | `settingsGet`, `settingsApply`. |
| `settings.pi`, `settings.setPi` | remote | setPi yes | `piSettingsGet`, `piSettingsApply`. |
| `settings.revealPi` | desktop | no | `piSettingsReveal`. |
| `computer.get`, `computer.apply` | remote | apply yes | `computerGet`, `computerApply`. |
| `computer.permissions`, `computer.requestPermissions` | remote | request yes | `computerPermissions`, `computerRequest` (status only; prompts show on the Mac). |
| `computer.openSettings` | desktop | no | `computerOpenSettings`. |
| `computer.preview` | remote | no | new. Latest-only read-only frame of the app a chat holds (T37). |
| `ui.get`, `ui.apply` | remote | apply yes | `uiGet`, `uiApply`. Pins, hidden projects and bookmarks live in `<userData>/ui-state.json` (`UiState`, ops `pin`/`unpin`/`reorder`/`hide`/`unhide`/`bookmark`/`unbookmark` in `src/shared/ui-state.ts`; a bookmark is a session file + message timestamp); changes ride `global` as `ui`. Layout (sidebar width, ATP panel sizes, wallpaper loop) and unread "seen" marks stay per client. |
| `ui.importLegacy` | desktop | no | `uiImportLegacy`. Merges the window's old localStorage pins and bookmarks once, then the renderer forgets them. |

**atp** (the runner is in main: `src/main/atp-runner.ts`)

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `atp.plans` | remote | no | One scan of a project's plans, `{ cwd }` -> `AtpProjectPlans` (no watching: `atp.watch` is the desktop window's, one project for everyone). The phone asks again every 3 s while its ATP page is open and at once when `atp.runners` changes. |
| `atp.read` | remote | no | `atpRead`. |
| `atp.start` | remote | yes | `startPlan`. Idempotent: a running plan is a no-op. Returns once the run is registered; it goes on in main (activates, runs workers). Doubles as resume. |
| `atp.stop` | remote | yes | `stopPlan`. |
| `atp.releaseInterrupted` | remote | yes | `releaseInterrupted`. |
| `atp.liftHold` | remote | yes | `liftHold` / `atpSetHeld`. |
| `atp.threads` | remote | no | worker/orchestrator session files of a plan (`AtpPlanThreads`), from `<userData>/atp-threads.json` (replaces the renderer's localStorage); changes ride `global` as `atp.threads`. `atp.importThreads` (desktop) merges the window's old copy once. |
| `atp.orchestrator` | remote | yes | `orchestrator`: opens or reuses the orchestrator chat for a project/plan, with the caller's client lease; `{ handle }`. Without `plan`: the chat for a plan being written (it becomes the plan's orchestrator when the plan appears). `atp.releaseOrchestrators` drops the caller's leases (idle chats stop, busy ones when done); `atp.discardNewPlan {cwd}` drops the new-plan chat. |
| `atp.state` | remote | no | `{ runners, notes, orchestrators, held }`; `global` `atp.runners` carries the first three whole on every change, `atp.held` the last. |

**browser** (T33–T35)

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `browser.state`, `browser.history` | remote | no | `browserGetState`, `browserHistory`. |
| `chat.resolveLinks`, `chat.linkImage`, `chat.openFile` | remote | no / no / yes | new. A chat's file links on the phone, confined to the chat's cwd and project, except the images the chat's answers embed (docs/FILE_PREVIEW.md, Phone). `from` resolves the first two from a shown file's folder. |
| `chat.readFile` | remote | no | new. A text file of the chat's folders (first 2 MB) for the phone's File screen (docs/FILE_PREVIEW.md, Phone). |
| `browser.newTab`, `browser.closeTab`, `browser.activate`, `browser.navigate`, `browser.command`, `browser.annotate`, `browser.inspect`, `browser.viewport` | remote | yes | the same-named channels. |
| `browser.view` | remote | no | new. `{ id, on }` → `{ stream: "/api/browser/view/<id>" }` (null when off or the tab is gone); the frames are the separate stream of section 4. |
| `browser.input` | remote | yes | new. `BrowserInput`: `tap`, `longPress`, `scroll` (wheel delta), `drag`, `text`, `key`, and `pick { x, y, comment }` for comment mode. Coordinates are CSS px of the streamed page (`X-Css-Width` x `X-Css-Height` of the frame), clamped inside it. Touch-emulated tabs get touches, others mouse events; `pick` returns `{ annotation }` to the caller only (element selector/label/html plus a JPEG crop of the last frame), nothing is broadcast. Works with the desktop window hidden or the pane closed. Tab state carries `agentAt` (ms epoch of the agent's last action) for the "agent is using this" indicator; URL approvals stay chat cards. |
| `browser.layout`, `browser.still`, `browser.popOut`, `browser.returnToPane`, `browser.reveal` | desktop | yes | `browserLayout`, `browserStill`, `browserPopOut`, `browserReturn`, `browserReveal` (window-bound; pop-out windows are host-only). |

**fs and uploads**

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `fs.browseFolders` | remote | no | new. Args `{ path?, files?, hidden? }`. Folders below `homeDir` (the real path must stay inside it; symlinks are followed only when the target does), hidden (dot) entries skipped unless `hidden: true`, 500 entries at most; `files: true` adds `files` (names and paths, never contents) for the attachment picker. `parent` is null at `homeDir`. Landed in T27. |
| `fs.pickFolder` | desktop | no | `pickFolder` (native). |
| `fs.pickAttachments` | desktop | no | `pickAttachments` (native). |
| `fs.describePaths` | desktop | no | `describePaths`: reads any absolute path (image bytes), so it is desktop-only; the phone sends uploads instead (security test: remote-server.security.test.ts). |
| `PUT /api/uploads?name=&type=` | remote | yes | **a route, not a method**: the raw body is the file (no base64, no 1 MiB JSON cap). Same pipeline as POST (device cookie, Origin, `X-Pigna-Client`). Stored under `userData/remote-uploads/<device>/<uuid>/<sanitized name>` and nowhere else (`sanitizeUploadName` drops separators, control characters and leading dots); an image type (png/jpeg/gif/webp) gives the stored name its extension. 25 MiB per file, checked on `Content-Length` and while streaming (413, nothing kept). Answers `{ id, path, name, image?: { mimeType } }`. Uploads older than 30 days are deleted at startup. |
| `uploads.discard` | remote | yes | `{ id }`; the caller's own upload only. |

**devices, remote, hello**

| Method | Scope | Mutates | Notes |
|---|---|---|---|
| `devices.list` | remote | no | Paired devices (no token hashes). |
| `devices.rename` | remote | yes | Own device or any (same trust). |
| `devices.revoke` | remote | yes | Any single device, including others (decision 3). Closes its streams at once. |
| `devices.revokeAll` | desktop | yes | Mac only. |
| `devices.pairStart` | desktop | yes | Issues the one-time code. |
| `devices.pairDecide` | desktop | yes | Allow/deny a pending pairing. |
| `remote.get` | remote | no | Status (enabled, port, url, serve state, keep-awake). Remote form omits nothing sensitive. |
| `remote.enable`, `remote.disable`, `remote.serve`, `remote.unserve`, `remote.setKeepAwake` | desktop | yes | Turning on/off, `tailscale serve`, keep-awake setting. |
| `app.hello` | remote (public-minimal) | no | `GET /api/hello`: `{ buildId, bootId, authenticated }`; the only authenticated-optional API route. |
| `app.info` | remote | no | `homeDir`, version, `launchCwd`; replaces `StudioApi` constants. |

**providers** (the preload's `auth`, renamed to avoid clashing with device authentication)

| Method | Scope | Mutates | Replaces |
|---|---|---|---|
| `providers.list` | remote | no | `authList` (`AuthState`, no secrets). |
| `providers.login` | remote | yes | `authLogin`; the call returns when the login ends; updates ride `global` as `providers.login`. Auth URLs are delivered to the client (opened on the phone); the host does not open them for a remote caller. |
| `providers.answer`, `providers.cancel` | remote | yes | `authAnswer`, `authCancel`. |
| `providers.logout` | remote | yes | `authLogout`. |

**github, update, misc**

| Method | Scope | Mutates | Replaces |
|---|---|---|---|
| `github.project`, `github.choose`, `github.list`, `github.lookup` | remote | choose yes | the same-named channels. |
| `update.get`, `update.download` | remote | download yes | `updateGet`, `updateDownload`. |
| `update.restart` | desktop | yes | `relaunch` (decision 6). |
| `host.relaunch` | desktop | yes | `relaunch` (same effect; dev rebuilds). |
| `host.openExternal` | desktop | no | `openExternal`. Remote clients open links on the phone. |
| `host.windowFocused`, `host.focusWindow` | desktop | no | `windowFocused`, `windowFocus`. |
| `host.killVisual` | desktop | no | `visualKill` (Electron `webContents`; a phone cannot kill a frame process, it removes the frame). |

Not in the table (host-only, unchanged): menu accelerators (`sidebarToggle`, `pageToggle`, `browserToggle`),
`openProject` (second launch), `updateReveal`, `pi --pigna`, terminal log, DevTools, `webUtils.getPathForFile`
(preload-only).

## 2. EventHub, topics, envelopes

Every push goes through one in-process EventHub in main. The desktop window is one subscriber (it stays on
`studio:events` IPC with the same envelopes); each SSE stream is another.

- **Topics:** `global` and `chat:<handle>`.
  - `global` events (`GlobalEvent`, kind in `host-api.ts`): `projects`, `attention`, `board`, `laments`, `settings`,
    `computer`, `atp.plans`, `atp.runners`, `atp.threads`, `atp.held`, `browser`, `update`, `providers.login`, `devices`, `remote`,
    `ui`, `chat.opened`, `chat.closed`.
  - `chat:<handle>` events (`HostEvent`): the existing `rpc`, `ready`, `exit` plus `dialog_resolved`, `lease` and `closed`.
- **Implementation (`src/main/event-hub.ts`):** `publish`/`publishBatch` (a batch is consecutive `seq`s delivered to each
  subscriber in one call, which keeps the desktop's `IPC.events` batching; a chat's streaming deltas arrive merged per
  frame, see DESIGN.md), `json(envelope)` (the envelope's JSON from the event's, made once at publish; SSE frames reuse
  it), `subscribe({ topics, deliver, onClose })`
  with `setTopics` and `close(reason)`, `since(bootId, seq)` (replay or resync via `planReplay`). The desktop window is
  the `"all"` subscriber in `src/main/index.ts` and maps events back to the legacy IPC channels. `browser.reveal` and
  `browser.annotation` are `global` events too. **Window-only pushes stay direct sends** (desktop shell, not host
  state): `pageToggle`, `sidebarToggle`, `browserToggle`, `windowFocus`, `openProject`, `updateReveal`.
- **Event envelope:** `{ bootId, seq, topic, event }`. `seq` is a host-global monotonic integer (one counter for
  all topics), `bootId` a random string per launch.
- **Snapshot envelope:** `{ seq, value }`; `seq` is the last event the value reflects. A client applies only events
  with `seq > snapshot.seq` for that topic. Snapshot reads (`chat.snapshot`, `*.get`, `atp.plans`, `browser.state`, …)
  are taken atomically with `seq` (read value and counter in the same tick).
- **Ring buffer:** one ring for all topics: at most **2000 events and 8 MiB** of serialized events, whichever first
  (oldest dropped). Browser frames and `computer.preview` frames never enter the ring.
- **Resync rules:**
  1. Client reconnects with `Last-Event-ID: <bootId>:<seq>`.
  2. Same `bootId` and `seq + 1` still in the ring → replay the gap, then live.
  3. Different `bootId` (host restarted), or the gap fell out of the ring, or no `Last-Event-ID` → the server sends a
     `resync` SSE event (no replay) and the client refetches snapshots for `global` and its subscribed chats, then
     applies events with `seq` greater than each snapshot's.
  4. Backpressure (section 4) also ends in `resync`.
  5. A client never trusts its local state across a `resync`; it replaces it from snapshots.
- **Chat events carry no host-side loss:** because the reducer in main (T05) runs on every event, `chat.snapshot` is
  always authoritative, including the streaming partial message, pending dialogs and queues.
- **Attention summary:** `global` `attention` events carry `Record<handle, AttentionSummary>` deltas
  (`attention`, `title`, `cwd`, `running`, `unread`, `dialogs` count) so a phone not subscribed to a chat still shows
  its marks. Unread is host-recorded as the settle outcome; "seen" is per device (client state).

## 3. Chat model: handles, leases, snapshots

- **Handles are host-issued** (`^[a-z0-9]{6,32}$`, as `HANDLE` in `session-host.ts`). The host keeps
  `sessionPath → handle`; `chat.open` on a live file returns the existing handle (point 3 of the plan: no two pi
  processes on one session file).
- **Snapshot:** `ChatSnapshot = { state: SessionStateJson, turns: { total, from } }`; the state is the reducer's
  output over the active branch plus live events, trimmed to the most recent N turns (default 40);
  `chat.snapshot({ handle, before })` pages older turns (the desktop's "Show earlier turns" model).
- **Composer drafts are per client** and not synced.
- **Prompts from two clients** deliver in arrival order; while running, a send is a steer unless
  `mode: "followUp"`.

## 4. SSE, subscriptions, backpressure

- `GET /api/events?stream=<uuid>[&chats=h1,h2]` (EventSource). `stream` is chosen by the client, once per page
  instance, and doubles as the **client id** for leases and presence.
- **Framing:** `id: <bootId>:<seq>`, `event: host`, `data: <event envelope JSON>`. Other event names: `hello`
  (`{ bootId, seq, buildId }`, first frame), `resync` (`{ reason }`, no `id:`), and `: hb` comment lines every 15 s.
  The client watchdog reconnects after 35 s of silence and on `visibilitychange`, `pageshow`, `online`.
- **Subscriptions:** a stream always receives `global`. `POST /api/subscribe { stream, chats: string[] }` replaces the
  set of `chat:<handle>` topics (idempotent, not counted for idempotency keys). A stream may subscribe to a chat
  only if it holds a lease or the chat exists (subscribing does not lease).
- **Backpressure:** per stream, if `res.writableLength` exceeds 1 MiB the server stops writing; when it drains it
  sends `resync` (or closes the stream if still over 4 MiB after 10 s). It never buffers without bound. Browser
  frames (`browser.view`) are latest-only: a frame is dropped when the previous one has not drained.
- **Frame transport:** `GET /api/browser/view/<tab>?w=<css px>&h=<css px>&dpr=<n>` (the area the phone draws the frame
  in; same auth as `/api/events`, at most 6 at once) answers `multipart/x-mixed-replace; boundary=pigna-frame`, one JPEG per
  part with `X-Css-Width`/`X-Css-Height` headers, so an `<img>` shows it; never SSE. The host runs a CDP screencast
  (`Page.startScreencast`, JPEG, size/quality/fps from the viewer: at most dpr 3, 30 fps for small frames down to 12) only
  while a response is open, acks every frame, and delivers latest-only: a frame waits for the previous part to drain and for
  the viewer's fps cap, newer frames replace it. Closing the response, revoking the device or stopping remote access stops
  the screencast. Several viewers of one tab share one screencast (largest ask), each throttled by its own gate.
  A tab outside the pane or a window is parked in an invisible keeper window while watched (no pane reveal), because a view in
  a hidden app window never renders; see `docs/REMOTE_BROWSER_SPIKE.md`. `scripts/remote-browser-check.mjs` verifies it.

## 5. Leases and the dispose rule

- A **lease** is `(handle, clientId)`. `chat.open`/`chat.attach` take one; `chat.detach` releases it. The desktop's
  clientId is `desktop`; a phone's is its stream id. A lease whose SSE stream closed is kept for a **60 s grace**
  (page suspended, reconnect) and then expires.
- **Dispose rule (host decides):** pi stops for a chat when it has no live leases and `isDisposable` holds
  (not prompted, not running, not compacting, no dialogs, no unread outcome), when it is idle (30 min, or past 8 idle
  chats; DESIGN.md "Idle chats stop their pi"), or on an explicit `chat.close`. A lease expiring never kills a
  running, compacting, dialog-holding or unread chat; closing or suspending a client never cancels host work.
- **Background chats:** "close when done" (triage) and ATP worker auto-close check **presence** (no client holds a
  lease on the chat) instead of the renderer's `active !== handle`.
- `lease` events on `chat:<handle>` (`{ clients: ClientPresence[] }`) let a client show who else is looking.

## 6. Idempotency

- Every method with `mutates: true` called remotely requires header `Idempotency-Key: <uuid>`; missing → `400 bad_request`.
  Desktop IPC calls are exempt.
- The client also sends `X-Pigna-Boot: <bootId>` (the bootId it last saw).
- **Cache:** `(deviceId, method, key) → { status, body }` in memory, **TTL 10 minutes**, at most 1000 entries per
  device (LRU), responses over 256 KiB are not cached (the key is then remembered as "done, result too large": a
  retry returns `409 conflict` with code `result_unavailable`, and the client refetches state). A retry while the first
  call is in flight waits for it and returns the same result.
- **Host restart:** the cache dies with the process. A retry carrying an `X-Pigna-Boot` that differs from the current
  `bootId` fails `409 host_restarted` before running; the client shows the transcript instead of resending.
- A key reused with a different body → `400 bad_request` with `detail.reason: "idempotency_mismatch"`.
- Reads (`mutates: false`) ignore the header.

## 7. RPC allowlist

`chat.command` accepts only these `RpcCommand.type` values: `prompt`, `steer`, `follow_up`, `abort`,
`clear_queue`, `set_model`, `set_thinking_level`, `compact`, `abort_retry`, `get_state`, `get_available_models`,
`get_available_thinking_levels`, `get_session_stats`, `get_commands`, `set_session_name`. `RPC_ALLOWLIST` and
`isAllowedRpc` are in `host-api.ts`. `bash`, `new_session` and every other type are refused remotely with
`403 scope_denied` (the desktop UI uses neither; `chat.rawCommand` stays desktop-only). `prompt` through
`chat.command` bypasses `chat.send`'s composition and is allowed for commands like `/compact`. `chat.send`
is the prompt path for the UI.

## 8. Dialogs: first answer wins

- Main records every pending `extension_ui_request` dialog (`select`/`confirm`/`input`/`editor`) and its own
  `requestChoice` ids (browser URL and Computer Use approvals) per chat.
- `chat.respondDialog { handle, response }`: the first valid response resolves it. The host emits
  `dialog_resolved { id, by, outcome }` on `chat:<handle>` (`by`: `"desktop"` or a device id; `outcome`:
  `answered | cancelled | timeout | exit`), and all clients drop the card. A later response gets `409 already_answered`.
- pi's dialog timeouts and chat exit settle dialogs (`settleChoices` today) and emit `dialog_resolved`.
- Computer Use and browser-URL approvals keep Allow once / Always / Deny; whichever client answers, the device id is logged
  (`main.log`). The same policy runs whoever answers: an Always allow from a phone is persisted like the desktop's, and
  denylisted apps never reach a card.
- Computer Use from the phone (T37): approvals and Stop (`chat.interrupt`; the run ending releases the chat's apps and
  hides the overlays) work as above. `computer.preview { handle }` returns one JPEG frame (`{ mimeType, data, app }`) of
  the latest app that chat currently holds, or `null` (nothing held, feature off, denied app). It takes the target only
  from the chat's held apps, never an arbitrary app or the screen, is limited to one call per second per client
  (`rate_limited`), and never enters the event ring. The mobile chat polls it every 2 s while the chat runs and shows it
  view-only. Permissions: status is readable (`computer.permissions`); granting happens on the Mac (macOS UI).
  **Non-goal:** the user operating Mac apps from the phone (no taps, keys or pointer are forwarded to any Mac app).
- The desktop drops its card on `dialog_resolved` (it previously removed it only when it answered itself).

## 9. Store revisions and conflicts

- Every store value (`Board`, `Laments`, `Settings`, `ComputerSettings`, `UiState`, held plans) carries `rev: number`,
  incremented on each applied change; pushed values and `*.get` return it.
- **Free-text edits** carry `baseRev` (the revision the editor last showed): card title/notes/tags, settings theme,
  wallpaper and task models. When `baseRev !== current rev`, `JsonStore` looks the base value up in its last 64 revisions
  and the model's `conflicts` (`boardConflict`, `settingsConflict`) compares just the field the op replaces; if it
  changed since (or the base is older than 64 revisions) the op fails `409 conflict` with `detail: { rev }` (IPC message
  starts `Conflict:`) and the client reloads and tells the user. Laments and Computer Use settings have no text-replacing
  op, so they only carry `rev`. Agents (`kanban_update`, the lament tool) send no `baseRev`.
- **Structural ops** (move, attach, link, reorder, resolve/reopen) stay last-writer-wins, validated by the existing
  pure `applyOp`/`applyLamentOp`; they ignore `baseRev`.
- `rev` is persisted in each store file (`rev` key beside `version`; files without it load as 0) and counts only changes
  that alter the value. It is added by `JsonStore`, not by the pure `apply*Op` functions. `GithubStore` shares the class
  and so also persists a `rev` (unused, never pushed).

## 10. Errors

Every failure is `{ code, message, detail? }` with an HTTP status; JSON body `{ "error": { code, message, detail } }`.
Over IPC the same shape is a thrown `HostError` (`code` kept on the message prefix `code: message`).

| Code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | Invalid args, missing `Idempotency-Key`/CSRF header, `idempotency_mismatch` in `detail`. |
| `unauthorized` | 401 | No/unknown/revoked device cookie. Clients go to pairing. |
| `forbidden` | 403 | Host/Origin/Tailscale-User-Login mismatch, or CSRF failure. |
| `scope_denied` | 403 | Desktop-only method, or RPC type outside the allowlist, or path outside allowed roots. |
| `not_found` | 404 | Unknown method, chat, card, tab, plan. |
| `conflict` | 409 | Store `baseRev` stale (`detail.rev`); `result_unavailable`. |
| `already_answered` | 409 | Dialog was answered by someone else. |
| `host_restarted` | 409 | `X-Pigna-Boot` differs from the current `bootId`. |
| `payload_too_large` | 413 | Body or upload over the cap. |
| `rate_limited` | 429 | Pairing attempts or per-device call rate (`Retry-After`). |
| `unavailable` | 503 | Feature not available now (no browser, helper down, remote disabling). |
| `internal` | 500 | Unexpected; message is generic, details only in `main.log`. |

`HOST_ERROR_STATUS` in `host-api.ts` is the code → status table.

## 11. Authentication, pairing, revocation

- **Cookie:** `pigna_device=<32 random bytes, base64url>; HttpOnly; Secure; SameSite=Strict; Path=/;
  Max-Age=34560000` (400 days; persistent because iOS dropped session cookies in Home Screen apps). The host stores only
  `sha256(token)` with `{ id, name, userAgent, tailnetLogin, createdAt, lastSeenAt }` in `userData/remote-devices.json`
  (T11). Tokens are compared in constant time. Sliding refresh: `lastSeenAt` updates at most once a minute.
- **Pairing states** (`PairingState`): `idle → code_issued → pending_approval → approved | denied | expired | locked`.
  The Mac issues a one-time code (**8 characters, `[A-Z2-9]` without lookalikes, 5 min TTL, single use, 5 wrong
  attempts then `locked` and the code dies**). The phone `POST /api/pair { code, deviceName }`; the Mac shows an approval
  prompt (device user agent, `Tailscale-User-Login`, name); **Allow** issues the cookie in the pending response
  (`Set-Cookie` on the long-poll `GET /api/pair/<id>/wait`), **Deny** or a 2-minute approval timeout does not. Pairing
  always needs the Mac. Pairing runs inside the installed Home Screen app (storage is separate from Safari; the landing
  page explains Add to Home Screen first).
- **Public routes:** static app files, `GET /api/hello` (minimal), `POST /api/pair`, `GET /api/pair/<id>/wait`. Everything else needs a
  valid device cookie. Pairing endpoints are rate-limited globally (10 attempts / minute) and per source.
- **Every request:** `Host` must equal the configured `<mac>.<tailnet>.ts.net` name (or `127.0.0.1:<port>` /
  `localhost:<port>` when testing locally with an explicit loopback-test flag); mutating (`POST`) requests need a
  same-origin `Origin` and `X-Pigna-Client: 1` (CSRF; `SameSite=Strict` is the first line). `Tailscale-User-Login` is
  required and must match the login recorded at pairing; it is **defense in depth only** (a local process can forge it by
  calling 127.0.0.1 directly), so the device credential is the real gate. AgentBridge tokens are never accepted by the remote
  server, and no route reaches the AgentBridge.
- **Revocation:** `devices.revoke` (the Mac or any paired device, decision 3) and `devices.revokeAll` (Mac). Revoked
  devices' SSE streams and browser-view streams close immediately and their leases drop. Turning remote access off stops
  the server and closes all streams.
- **Credentials stay on the host:** no API returns provider keys, gh tokens, browser-profile cookies or pi's
  `auth.json` content. The phone can send an API key (`providers.login`) but never read one back.
- **Audit:** `main.log` records `remote <deviceId> <method>` (names and status, never args), plus `device paired|revoked <id>` and `pairing <state>` lines. Threat model: `docs/REMOTE_THREAT_MODEL.md`.

## 12. Static app, CSP, limits

- The remote server serves `out/mobile` (T16) at `/`: `/assets/*`, `/sw.js`, `/manifest.webmanifest`, icons.
  The service worker caches only the app shell by build id (never `/api`). `GET /api/hello` returns `buildId`; a mismatch reloads.
  Build: `pnpm build` runs `scripts/build.mjs` (electron-vite, then `vite build -c vite.mobile.config.ts` into `out/mobile`) with one
  `PIGNA_BUILD` id for both; `out/**` already ships in the asar and the server reads it with plain `fs` (no `onDisk`). `pnpm dev:mobile`
  rebuilds `out/mobile` on change; the RemoteServer serves it (no Vite dev server). `sw.js` is generated with the build id and shell file list.
  Icons are generated by `pnpm icon:mobile` into `src/mobile/public/icons`.
- **CSP** (`REMOTE_CSP` in `host-api.ts`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`.
  Visual frames are served from a dedicated path with their own frame CSP and rendered with `sandbox="allow-scripts"`
  (opaque origin, `connect-src 'none'`). `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses.
  (`style-src 'unsafe-inline'` is allowed for the mobile build's runtime styles; the visual frame CSP stays stricter.)
- **Limits:** JSON bodies ≤ 1 MiB; `PUT /api/uploads` ≤ 25 MiB per file, at most 10 attachments per message
  (`chat.send` checks it); uploads are deleted after 30 days (at startup). An upload resolves only for the device that made it.
- **Process model:** `RemoteServer` binds `127.0.0.1:<port>` only and starts only when enabled; `tailscale serve`
  fronts it on 443 (tailnet only, never Funnel; refuse when Funnel is on for that port). Window close hides the window while
  remote access is on; quit warns that devices lose access and chats stop.

## 13. Decisions (plan section 7 open decisions)

| # | Decision | Reason |
|---|---|---|
| 1 | **Port:** default `4517`, editable in Settings; always `127.0.0.1`. | Stable, so `tailscale serve --bg --https=443 http://127.0.0.1:4517` survives restarts; editable for conflicts. |
| 2 | **QR code:** bundle a small MIT QR encoder in the renderer (devDependency, Vite-bundled); the pairing dialog **always** shows the URL and the code as text too. | Main stays dependency-free; the QR is convenience, text is the fallback. |
| 3 | **Cross-device revoke:** a paired device may revoke any single device (and itself) but not pair, enable remote access, or "revoke all". | Lost-phone case needs another device; the powerful actions stay Mac-only. |
| 4 | **Keep-awake default:** *while a chat or plan runs* (`prevent-app-suspension` held only then), option *always while remote access is on*. | Least surprise for laptops; always-on hosts opt in. Copy states it cannot keep a closed-lid MacBook awake. |
| 5 | **Web Push:** GO, opt-in and off by default, designed in section 13a (T38); implemented after mobile parity. | The only way to reach a suspended phone; the only feature that leaves the tailnet, so its egress is listed and minimal. |
| 6 | **Update Restart:** host-only (`update.restart` desktop scope); the phone can see state and Download. | Restart drops the server and every chat; it should be a deliberate action at the Mac. |
| 7 | **Scopes:** none in v1; every device is full-access. `DeviceRecord` reserves `scope: "full"` so read-only devices can be added without a migration. | Keeps v1 small; the field is the only forward hook. |

Additional decisions made while writing the contract:

- **One object argument per method**, positional IPC adapted in the preload/main, so remote JSON and IPC share one validator.
- **`providers.*`** replaces the preload's `auth.*` in the table; "auth" in this contract means device authentication.
- **ATP low-level methods** (`claim/release/activate/head/commit/info`) are desktop-scope until T23 makes them host-internal, then leave the table.
- **`chat.rawCommand`** stays desktop-only as a transition; removed once the desktop uses `chat.command` + `chat.send`.
- **Subscriptions never lease**: only `chat.open`/`attach` lease, so a phone cannot keep a chat alive by streaming it.
- **Text-edit conflicts are coarse first** (`baseRev` staleness), refined only if T09 finds it cheap.

## 13a. Notifications (Web Push)

**Implemented (T39).** Differences from the design below: there is no `client.visibility` method (suppression uses the session host's existing lease `viewing` flag, plus the service worker's visible-window check); the methods are `push.vapidKey`, `push.state`, `push.subscribe`, `push.unsubscribe`, `push.setPrefs` (remote scope, per calling device); an error runner note or the "Finished" note triggers `plan`; subscriptions are dropped whenever the device list no longer contains the device (revoke, revoke all); the opaque chat id is the chat handle. Code: `src/main/web-push.ts`, `src/main/push-service.ts`, `src/shared/push-rules.ts`, `src/mobile/push.ts`, the push handlers in `vite.mobile.config.ts`. Real-device checks: `docs/REMOTE_VERIFICATION.md` N1-N11.

**Decision: GO, as an opt-in, off-by-default feature, built after the mobile parity nodes (not part of the v1 contract above).**
Reasons: (1) a suspended Home Screen app has no connection (SSE stops within seconds of the lock screen), and Tailscale delivers nothing to a
sleeping phone, so without a push the main phone use case, "approve the tool call that is blocking the agent", only works while the
app is open; (2) Web Push for installed Home Screen apps is supported on iOS 16.4+ and needs no native app; (3) the cost is bounded: ~300
lines of `node:crypto` in main, no runtime dependency, and the privacy surface can be made small and explicit (below). Reasons to keep it
optional: it is the only feature that sends anything off the tailnet, and it cannot work while the host is asleep or offline. If the
payload or egress rules below are later judged unacceptable, the fallback is no-go: the app still works, notifications are just absent.

### Triggers

| Event | Condition | Kind |
| --- | --- | --- |
| Approval/dialog waiting | a `dialog_requested` that needs an answer (tool approval, confirm, select, input) and is still unanswered after a short grace (10 s, so desktop answers do not ping) | `approval` |
| Run finished | a run ends (`agent_end`) and the chat is unread by every client | `done` |
| Run failed | a run ends in error/abort-by-error and the chat is unread | `failed` |
| ATP plan stopped / finished | the runner stops on a failed node, a human-needed stop, or the plan completes | `plan` |
| Host going down | the user quits pi-gna while remote access is on and devices exist (sent once from the quit path, before the server stops) | `host_quit` |

"Unread" reuses the unread state the app already keeps per chat; a chat the user is looking at never notifies. `host_quit` is best effort (a crash, power loss
or sleep sends nothing) and is the only "host unavailable" signal the system can give.

### Web Push mechanics (host side, `node:crypto` only)

- **Phone:** inside the installed Home Screen app only (Safari tabs cannot subscribe on iOS), a "Notifications" switch in Settings calls
  `Notification.requestPermission()` **from that tap** (a user gesture is required), then `registration.pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey: <VAPID public key> })`, and sends the subscription (`endpoint`, `keys.p256dh`, `keys.auth`) with `push.subscribe`. Every push must show a
  notification (iOS revokes subscriptions that show none), so the service worker's `push` handler always calls `showNotification`.
  `notificationclick` focuses or opens the app at `/#/chat/<opaque id>`.
- **VAPID key pair (RFC 8292):** an ECDSA P-256 pair generated on first enable with `crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })`,
  stored in `userData/remote-push.json` (mode 0600, private key never leaves the host and is never returned by any API; the public key is served to
  paired devices). Regenerating the key invalidates every subscription (devices must re-subscribe), so it is only done by an explicit "Reset notifications".
- **Subscriptions:** stored per device in the same file as `{ deviceId, endpoint, p256dh, auth, prefs, createdAt }`, one per device. They are
  removed when the device is revoked (`devices.revoke`, `devices.revokeAll`), on `push.unsubscribe`, and on a `404/410` from the push service.
  The `endpoint` must be `https:` and is otherwise treated as an opaque URL chosen by the push service; it is not an SSRF concern for the tailnet because
  the host only POSTs a fixed encrypted body to it, but the host refuses endpoints that resolve to loopback, link-local or private addresses.
- **Message encryption (RFC 8291, `aes128gcm` content coding of RFC 8188):** per message an ephemeral P-256 ECDH key (`crypto.createECDH('prime256v1')`), shared secret
  with the subscription's `p256dh`, HKDF-SHA256 (`crypto.hkdfSync`) with the subscription `auth` secret and the `WebPush: info` context to derive the IKM, then a
  16-byte random salt and HKDF for the CEK and nonce, AES-128-GCM (`crypto.createCipheriv('aes-128-gcm')`), a single record with padding delimiter `0x02`, header
  `salt(16) | rs(4, 4096) | idlen(1) | ephemeral public key(65)`. Plaintext is capped far below the 4096-byte push limit (our payload is < 200 bytes).
- **VAPID JWT:** ES256 over `{ aud: <push service origin>, exp: now + 12 h (max 24 h), sub: "mailto:..." }`; signature produced with `crypto.sign('sha256', ...,
  { dsaEncoding: 'ieee-p1363' })` (raw r||s, as JWS requires). Request headers: `Authorization: vapid t=<jwt>, k=<base64url public key>`, `Content-Encoding: aes128gcm`,
  `Content-Type: application/octet-stream`, `TTL`, `Urgency`, and `Topic` for collapsing. `sub` is a configurable contact, default a non-identifying
  `mailto:` placeholder; it is visible to the push service.
- **Delivery params:** `approval`: `Urgency: high`, `TTL: 3600`, `Topic` = chat id + kind (a newer one replaces the older). `done`/`failed`/`plan`: `Urgency: normal`,
  `TTL: 86400`. `host_quit`: `Urgency: normal`, `TTL: 600`.
- **Transport:** `node:https` POST from the host to the subscription's endpoint (Apple `web.push.apple.com`, FCM `fcm.googleapis.com` for Android Chrome, Mozilla `*.push.services.mozilla.com`). The
  connection leaves the host over the public internet, not the tailnet, and does not depend on Tailscale. Timeout 10 s, no retries beyond one retry on `5xx`/`429`
  honoring `Retry-After`; at most one in-flight send per subscription.

### What leaves the host (complete list)

1. To the push service of each subscribed device: the device's `endpoint` (which it already knows, being its own), the ECDH ephemeral public key and salt, the VAPID JWT with the
   host's VAPID **public** key and `aud`/`sub`/`exp`, the `TTL`/`Urgency`/`Topic` headers, and the ciphertext. The push service also sees the host's public IP and timing/size of each push.
2. Inside the ciphertext only (readable by the phone alone): `{ v: 1, kind, chat: <opaque id>, t: <ms>, title?, preview? }`. `title` is the chat title (clipped to 80 characters); `preview` is the first 140 characters of the last reply, sent only with `done`.
3. Nothing else: **no other transcript text, tool names or arguments, file paths, repository names, error messages, hostname, tailnet name or device names.** The
   `Topic` header is a hash (`sha256(chatId|kind)` truncated, base64url), not the chat id.

The notification is composed on the phone by the service worker: the title is the chat title (or "pi-gna"), the body the status text for `kind` ("Approval needed", "Run finished", "Run failed", "Plan stopped", "pi-gna is quitting"), followed by the reply excerpt when there is one.
The opaque chat id is a handle the app resolves after the user opens it (authenticated); it is a random per-session id minted by the host, not the session file path. The title and
excerpt are shown on the lock screen as iOS is configured to show them (the user's "Show Previews" setting applies); the payload is end-to-end encrypted to the phone, so the push service never sees them.

### Suppression and preferences

- **Active viewing:** the host knows each client's SSE stream and its visibility reports (`client.visibility` sent by the app on `visibilitychange`). When any device (phone or desktop
  window, focused) is viewing the chat, no push is sent for it. For `approval`, an answer from any client within the grace period cancels the pending push. The phone's service worker
  additionally skips `showNotification` when a visible client window of the app exists (permitted, since iOS allows this only when a client is `visibilityState === 'visible'`); if a
  push shows nothing otherwise, iOS may revoke the subscription, so the worker falls back to a notification when in doubt.
- **Per-device preferences** (`push.setPrefs`, stored with the subscription): toggles for `approval`, `done`/`failed`, `plan`, `host_quit`; defaults: approval, failed, plan and
  host_quit on; done on. "Mute this chat" is a later option. Sending to a device respects only its own prefs.
- **Rate limits:** at most one push per device per chat per kind per 30 s; at most 20 pushes per device per hour (excess is dropped and counted in `main.log`).

### Failure handling

- `404`/`410 Gone`: subscription removed at once (and the device told to re-subscribe at its next visit). `400/401/403` from the push service: the VAPID header is wrong; log, do not
  retry, surface "notifications broken" in the host settings. `413`: cannot happen with our payload. `429`/`5xx`: one retry, then drop. Network failure: drop (the next event notifies again;
  there is no queue, since stale "approval needed" is worse than none).
- `main.log` records `push <deviceId> <kind> <status>`, never payload or endpoint.
- If the push service is unreachable for hours, nothing else degrades: the app, SSE and the remote server do not depend on it.

### Impossible or out of scope

- **Host asleep, powered off, lid closed, or pi-gna not running:** no event is produced, so no push is sent. Nothing a phone or a push service can do changes that (and the contract
  forbids privileged sleep hacks). The phone only ever learns "the host is unreachable" when it is opened.
- No push for events that happen while the host is unreachable, and no catch-up push after wake (the app's resync shows the state when opened).
- No delivery guarantee: the push service may delay or drop (iOS low-power/Focus modes, force-quit app after user-initiated removal, revoked permission).
- No actions inside the notification (approve/deny from the lock screen) in v1: an approval is authenticated state change and goes through the app.
- No Funnel, no third-party relay, no analytics: the host talks to the browser vendors' push services directly and to no pi-gna server.

### Build plan (for the later implementation node)

Pure, vitest-tested helpers in `src/shared`: `buildPushPayload`/encryption (checked against the RFC 8291 Appendix A test vector), VAPID JWT, prefs/suppression/rate-limit decisions. Main: `push-service.ts`
(key store, subscriptions, sender), hooked to EventHub events and the revoke paths; HostCore methods `push.vapidKey`, `push.subscribe`, `push.unsubscribe`, `push.setPrefs`, `client.visibility`. Mobile: Settings switch,
service-worker `push`/`notificationclick`, doc updates in `docs/DESIGN.md`, a CHANGELOG line, and a real-device check on iOS 16.4+ in `docs/REMOTE_VERIFICATION.md`.

## 14. Node map

| Contract part | Implemented by |
|---|---|
| EventHub, envelopes, ring | T04 |
| Shared reducer, snapshots | T05 |
| Session registry, leases, dedupe | T06 |
| Idempotency, mutex, dialogs, allowlist | T07 |
| Desktop adaptation | T08 |
| Store `rev`/`baseRev` | T09 |
| Host-mode lifecycle, keep-awake | T10 |
| DeviceStore, auth | T11 |
| HostCore method table | T12 |
| RemoteServer, SSE | T13 |
| Remote settings, pairing UI | T14 |
| Security suite | T15 |
| Host-side chat setups / ATP runner / pins | T22–T24 |

### RemoteServer implementation notes (T13, `src/main/remote-server.ts`)

- Built from injected parts (`DeviceStore`, `EventHub`, `IdempotencyCache`, a `call`/`scopeOf` pair over the HostCore table, `allowedHosts()`), so it
  listens only after `start(port)`; wiring to settings/tailscale is T14. `devicesChanged` must be passed as the `DeviceStore` `changed` callback.
- A call names its client with `X-Pigna-Stream: <stream id>` (falls back to the device id). `/api/hello` returns `buildId` (and `build`).
- Pairing is rate limited at 10/minute globally and per Tailscale login; `GET /api/pair/<id>/wait` long-polls 25 s.
- `dispatch` turns any non-`HostError` thrown by `validate` into `bad_request`; unexpected `run` errors answer `500 internal` with a generic message.

### Mobile chat slice (T19, `src/mobile`)

- **Stack:** Projects (`chat.list`, ordered like the sidebar by `projectViews` with the host's pins) -> Chats (rows carry the live chat's attention mark, matched by `sessionPath`) -> Chat, on `history` so the back swipe works. A reload inside a chat lands on Projects.
- **Joining a chat:** `chat.open { request: { cwd, sessionPath } }` (or `chat.attach` for a handle the list already knows), then `HostClient.setChats([handle])` subscribes the stream and reads `chat.snapshot`; `chat.viewing` marks it seen. Leaving sends `chat.viewing false` + `chat.detach` and drops the subscription; the host keeps a running chat going. When the stream is live again after a drop the screen attaches once more (the lease may have lapsed).
- **Transcript:** the desktop's `Transcript`, `Activity`, `ToolDetails`, `Markdown`, `Dialogs` and `QueueCard`, unchanged but for `src/renderer/src/lib/chat-ui.tsx`: they read expansion state, board cards, wallpaper/visuals and actions (lightbox, open link, answer dialog, edit queue) from a `ChatUi` context. The desktop provides it from its store in `renderer/src/main.tsx`; the phone from `src/mobile/chat-ui.ts` (no visual frames or wallpaper, links open in the phone's browser). "Show earlier turns" pages `chat.snapshot { before }` through `HostClient.loadEarlier`, keeping the scroll position; scrolling within 600 px of the top loads the next page by itself. Touch sizing uses the `touch:` Tailwind variant (`pointer: coarse`).
- **Composer:** text drafts are per chat in `localStorage` (`pigna:draft:<session file>`). Send is a steer while the agent works (`chat.send mode: "send"`), Queue is `mode: "followUp"`, Stop asks first, then `chat.interrupt` and the returned queued texts go in front of the draft. `@` mentions and slash-command pickers are later nodes.
- **Connection:** the banner shows reconnecting / unreachable / outdated with "Retry now". After a browser-side EventSource retry (same URL, so without the chats on screen) the client re-subscribes and rereads the chats on `hello`, so a reconnect cannot leave a transcript stale.
- **App info:** `app.info` (`homeDir`, `launchCwd`, `version`, `buildId`) is in the table; the phone uses `homeDir` to shorten paths.

### Images by URL and a short first page (2026-10-05)

Opening a long chat with pasted screenshots took seconds: images rode inside the JSON as base64 (13.7 MB in one
real chat), `chat.attach` returned the whole transcript, which the phone discarded, and the phone attached twice per open,
so about 40 MB crossed Tailscale before "Opening…" cleared. Now:

- **Images by URL** (`src/main/remote-images.ts`): the RemoteServer serializes method results and stream events with a
  `JSON.stringify` replacer that swaps every `{ type: "image", data }` block of 16 KB or more, in a renderable type (png,
  jpeg, gif, webp, heic), for `{ type: "image", mimeType, data: "", url: "/api/image/<sha256>" }`. `GET /api/image/<id>`
  needs a paired device and answers `private, max-age=31536000, immutable` with `default-src 'none'`, so each image
  downloads once. The bytes stay in an LRU of 256 M base64 characters (strings the session state already holds); an
  evicted id is a 404 until the next snapshot or event names it again. The host's state and the desktop are untouched;
  the renderer reads `imageSrc(block)` (`url` or a data URL) and lazy-loads.
- **Short first page:** the phone opens with `chat.snapshot { turns: 6 }` and pages 20 at a time.
- **Attach without the transcript:** for a remote caller `chat.attach` returns `{ seq }`; the desktop gets its first
  page over IPC.

### Mobile composer parity (T26, `src/mobile/MobileComposer.tsx`)

- **Pickers:** model and thinking chips open bottom sheets (`Sheets.tsx`). Reads and writes go through `chat.command` on the RPC allowlist (`get_available_models`, `get_available_thinking_levels`, `set_model`, `set_thinking_level`, `get_state`); after `set_model` the levels and thinking level are read again. `composer-data.ts` holds the reads (plain functions, tested with a fake call) and `useComposerData`, which also keeps `get_session_stats` fresh whenever a run or compaction ends.
- **Commands and mentions:** `get_commands` and `chat.files` (cached 15 s per folder) feed touch lists above the textarea; trigger detection is `src/shared/composer-menu.ts`, shared with the desktop composer.
- **Shared components made touch-friendly, not forked:** `ContextMeter` (props `compaction`, `onCompact`, `touch`: a tap opens the card as a bottom sheet; compaction settings come from `chat.compactionSettings`), `QueueCard` (`touch`: rows show Steer now / After the run, Edit, Remove as full-size buttons; ops are `chat.editQueue`), `TokenRate`, `Widget`. The compaction indicator is the transcript's own `CompactionProgress`; an auto-retry shows a callout with "Give up" (`abort_retry`).
- **Extension UI:** `HostClient.onChatEvent` sees each applied chat event once; `notices.ts` turns `notify` into toasts (startup info dropped, each startup warning once per page run). Widgets render above or below the composer, `set_editor_text` fills the draft (once per nonce), `setTitle` is the chat header.
- **Verification:** the `mobile-chat` scenario of `pnpm e2e:remote` ends with `composerChecks` on the phone (fake-pi serves commands, thinking levels, model switches, compaction, stats; a prompt with `ext-ui` or `retry-demo` raises extension UI and an auto-retry). Real pi for models and commands: see docs/REMOTE_VERIFICATION.md.

### Automated end-to-end tests (T20, `scripts/remote-e2e/`)

`pnpm e2e:remote` proves the remote slice without a phone. It is a set of small scenarios, one file each
(`scripts/remote-e2e/<name>.e2e.mjs`), on a shared harness (`harness.mjs`). The runner (`run.mjs`) builds the app once into a folder under
the temp dir (`electron-vite` + the mobile bundle, one build id), then runs each scenario as its own process against its own fresh test
instance: own `PIGNA_USER_DATA`, free debugging/inspector/remote ports, `PIGNA_BACKGROUND=1`, `PIGNA_REMOTE_LOOPBACK=1`, `scripts/fake-pi.mjs`
as pi, its own `PI_CODING_AGENT_DIR`, and a throwaway git project with a three-turn session, a "Tools demo" session and three laments.
Remote access and the task models (fake-pi's) are set in the profile's `settings.json`, and each instance is stopped by PID. Nothing touches a running pi-gna.
A scenario never depends on another's leftovers, so a failure stops only its own checks. The run prints a pass/FAIL table; its exit code is
0 only when every scenario passed. A failed scenario keeps its work folder (`app.log` inside).

```bash
pnpm e2e:remote                        # all scenarios, one at a time (about 4 minutes; --jobs 3 takes about 1.5)
pnpm e2e:remote mobile-board reconnect # by name; a prefix such as `mobile` selects every mobile-* scenario
pnpm e2e:remote --list                 # names only
node scripts/remote-e2e/reconnect.e2e.mjs   # one scenario directly; builds unless SLICE_E2E_APP=<folder of an earlier build>
```

Runner flags: `--jobs <n>` (parallel scenarios, output prefixed with the name), `--keep` (keep the build and work folders), `--shots <dir>`
(screenshots under `<dir>/<scenario>`). A scenario run directly also takes `--keep`, `--shots <dir>`, `--hold` (stay up at the end for
manual poking) and `--debug`. To add a check, add it to the scenario it belongs to, or add a new `<name>.e2e.mjs` that calls `scenario()`.
Seed what it needs in its own body rather than relying on another scenario's state.

What they drive: two paired "phones" A and B (plain HTTP + SSE with the headers Tailscale serve and Safari would send: loopback `Host`, https
`Origin`, `X-Pigna-Client`, `Tailscale-User-Login`, the device cookie), the desktop window over CDP, and for `mobile-*` the mobile app in an
offscreen window of the instance itself (iPhone 15 size, mobile user agent, touch emulation) through a small Tailscale-header proxy.

| Scenario | What it proves |
| --- | --- |
| `pairing` | The Mac issues a code through the window's `studio.remote`, each phone claims it, the Mac's Allow is `pairDecide` (no test hook in the app), the cookie comes from the long-poll. An unpaired client gets 401. |
| `chat-sync` | A opens the session file (host handle, no transcript), B gets the same handle (`reused`), the desktop shows the same live chat. A prompt with `ask-confirm` raises a `confirm` dialog: A answers, B and the desktop drop the card on `dialog_resolved` (naming A's device), B's later answer is `already_answered`, pi saw one answer, and lines 1..40 arrive once each on A, B and in the desktop's DOM. B then interrupts a long run started by A: `aborted` everywhere with identical partial text. |
| `multi-client` | Two simultaneous prompts: one runs, one queues, B's interrupt hands the queued one back. Two card edits from one revision: one lands, the other gets 409 `conflict`; concurrent moves both succeed. |
| `reconnect` | A's stream is dropped mid-run and reopened with `Last-Event-ID` (replay, no `resync`, `seq` contiguous, lines 1..250 once); the same prompt retried with the same `Idempotency-Key` returns the first result and adds no turn; the same key with another body is `400`. Then with A away more than 2000 events pass: the reconnect gets `resync` and no replay, and the snapshot plus later events leave no gap. |
| `host-lifecycle` | A and B detach mid-run and the run goes on to the end. The host process is paused (SIGSTOP on the test instance only) and resumed: calls hang, the stream stays, then carries every line once. A real restart: new boot id, an old idempotency key fails `host_restarted`, a stream resuming the old boot gets `resync(new_boot)`. |
| `themes` | The desktop applies a project theme (tokens, wallpaper and logo images, a live VisualFrame without re-running its script); remote clients may read themes but not set them; the phone follows the project's forced light/dark mode over the emulated OS mode. |
| `mobile-chat` | Projects, Chats, Chat (first page, earlier turns on scroll up), a prompt from the phone's composer, Allow, following the stream, Stop with confirmation, then the composer's chrome (`composerChecks`). |
| `mobile-transcript` | Tool sheets, Expand all, images and the lightbox, links, visuals and their watchdog, the turn list and bookmarks. |
| `mobile-projects` | Projects and Chats parity: search, long-press sheets, board from a chat, Kanban off, Close chat, pins, the folder browser. |
| `mobile-board` | The Kanban board: counts, card edits with conflicts, tags, GitHub links, moves, drag reorder, add card with a photo, task chats. |
| `mobile-laments`, `mobile-github`, `mobile-atp`, `mobile-settings` | Those pages' parity with the desktop (ATP runs a three-node plan on fake-pi workers; GitHub reads a public repository through the host's `gh`). |
| `mobile-browser` | The Browser screen driving a local dev page (tap, type, keys, scroll, pinch, comments with crops), then chat links: a Markdown file drawn on the phone's File screen (Raw, the linked line, its own links; Back keeps the chat's transcript and scroll position), an HTML file streaming the Mac's preview, a card on the board, a localhost page in the Mac's browser. |

The multi-client rules (simultaneous prompts, steer vs. follow-up, one answer per dialog, abort against a steer, serialized queue edits, card edit conflicts and moves, leases and close broadcasts) are unit-tested in `src/main/multi-client.test.ts`; `multi-client` runs the prompt, queue-interrupt and card-edit cases through the real server.

Prompts steer fake-pi with `[lines=N]` and `[delay=N]` (ms).

Lessons baked in: windows and browser tabs of a `PIGNA_BACKGROUND=1` instance draw no frames, so `Page.captureScreenshot` and `capturePage` of a tab never answer; the screens
use an offscreen `BrowserWindow` created through the inspector (`--inspect`) instead. The test found that `chat.respondDialog` ignored its caller, so `dialog_resolved.by`
named `"desktop"` for a phone's answer (fixed: `host-core.ts` passes the caller). Splitting the old single script into scenarios exposed two hidden couplings: the
transcript's image check passed only because an earlier section had given the project a logo `<img>`, and an ATP failure (task models fake-pi does not
have) had kept every later mobile section from running.

### Resilience results (T41)

Every recovery path has a test; none needed a production fix. Unit tests run in `pnpm test`; the process-level ones are the `reconnect` and `host-lifecycle` scenarios of `pnpm e2e:remote`.

| Case | Proof | Result |
| --- | --- | --- |
| Ring overflow → resync | `event-hub.test.ts` (count/bytes eviction, resync on a missing cursor); e2e: >2300 events while A is away, reconnect gets `resync`, no replay, snapshot + newer events leave no gap | pass |
| Slow SSE consumer | `remote-server.test.ts`: a paused client with 100 MiB published queues at most the cap plus a frame or two (`RemoteServer.streamQueuedBytes`), gets `resync` after draining, then live frames again; the 4 MiB / 10 s hard cap closes the stream | pass |
| Host restart (new `bootId`) | server test: an old key with the old `X-Pigna-Boot` is `409 host_restarted`, the call does not run, a stream with the old `Last-Event-ID` gets `resync(new_boot)` and no replay; client test: `host_restarted` is never retried and a boot change restarts seq counting; e2e: real restart of the instance, same cookie still works, stale `chat.send` starts no chat and adds no turn | pass |
| Host paused (sleep) | e2e: `SIGSTOP` on the **test instance's** PID mid-run: calls get no answer, no events, the stream is not torn down; after `SIGCONT` the same stream carries every line once and calls answer again. Client unit tests: watchdog reconnect, `unreachable` after 3 failures with the last state kept, recovery to `live` on the next `hello` | pass |
| Drafts while unreachable/restarted | `src/mobile/drafts.test.ts`: drafts live in `localStorage` keyed by session file, so a new handle after a restart finds the same draft | pass |
| Build change → reload | client test: a `hello` with another `buildId` goes to `outdated` and calls `onOutdated` (the page reloads) | pass |
| Revoked while reconnecting | server test: the revoked device's stream closes at once; client test: the next probe says unauthenticated → `unauthorized`, `onUnauthorized` once, no further reconnects | pass |

The SIGSTOP case is not in vitest on purpose: it needs the real Electron process and must only ever target the PID the script itself started.
- **Attachments (T27):** the composer's `+` opens a sheet: Photos (`<input type=file accept="image/*" multiple>`, library or camera), Files (`<input type=file multiple>`) and "Files and folders on the Mac" (`fs.browseFolders { files: true }`, attach a file or the folder you are in). A photo or file uploads at once with `HostClient.upload` and shows as a chip (uploading, ready, or red on failure); Send waits for uploads. A pasted image (where iOS gives the paste as a file) uploads the same way. `chat.send { attachments: [{ upload: id } | { path }] }`: the host resolves uploads for the calling device, reads host paths like the desktop's `describePaths`, and `ChatTasks.send` composes the `# Files mentioned by the user:` block (`src/shared/file-mentions.ts`, shared with the desktop composer) and image content, none for a `/command`. Add-card screenshots from the phone use `board.addCard` image attachments / `board.saveImage` (base64, the phone downscales); the add-card screen itself arrives with the board nodes. Check with `scripts/fake-pi.mjs`: a prompt containing `echo-attach` is echoed with `[images=N]`.
- **Projects and chats (T25):** Projects lists the host's projects (`chat.list`, pins from `ui.get`, so the order is the sidebar's) with the strongest attention mark of their live chats and a search over folder names and chat titles; Chats lists a project's sessions. Like the desktop sidebar, both lists also show `listed` live chats with no `chat.list` row yet (pi writes the file with the first message, and the index is only re-read on the phone's asks): on top of Chats, their project ahead of the other unpinned ones. A long press (or the context-menu gesture) opens a sheet whose rows come from `src/mobile/actions.ts`, the same conditions as the desktop sidebar menus: chats offer Open, Add to the board / Show on the board (Kanban on; adds a card with `board.apply` `add` + `attach`), Close chat (`chat.close`, after a confirmation that says it stops pi) and Copy path; projects offer New chat, Pin/Unpin (`ui.apply`), the Kanban, Laments, GitHub and ATP pages only while their feature is on, and Copy path. The Projects header's folder button opens the folder browser (`fs.browseFolders`, folders only, from the home folder, a toggle for hidden ones) and "Start a chat here" opens a new chat (`chat.open` without a session file) in that folder's project. The project pages themselves show a placeholder until their nodes land. Unread is per device: opening a chat records its `settled.at` in the page's `localStorage` (`pigna:mobile-seen`), and a chat shows `unread` only when it settled after that. `GLOBAL_READS` in the client takes the host's bare answers for the `Snapshot`-typed reads (`board.get`, `settings.get`, `ui.get`, ...) as the value; before this, the phone's board, settings and pins stayed empty. Checked by `pnpm e2e:remote` (projectChecks: search, sheets, pin, board, Kanban off, Close chat, a chat started on the phone listed before its file is indexed, folder picker; shots 8 to 16).
- **Browser (T36):** the globe on a chat's header opens `src/mobile/Browser.tsx` (route `{screen:"browser", handle}`) on that chat's tabs (`BrowserTab.agent`, as the Mac scopes them); the globe shows their count and pulses while the agent drives one. "All tabs" lifts the filter. The phone keeps its own selected tab, because the Mac ignores `browser.activate` for a tab of a chat it is not showing, and a new tab from a chat's browser belongs to that chat (`browser.newTab { agent }`, which returns `{ id }`). Tabs come from `browser.state` (badges: the agent icon, brighter while `agentAt` is within `AGENT_ACTIVE_MS`; "window" for pop-out tabs, which can be viewed and driven but not moved; the viewport label), the address bar suggests from `browser.history`, and back/forward/reload/stop are `browser.command`. The frame is an `<img>` on the stream sized to the fitted page (quantized to 50 px so a resize does not restart it). An `<img>` cannot read `X-Css-Width`/`X-Css-Height`, so touch points are mapped to CSS px from the tab's viewport (1280x800 for a Responsive tab: `RESPONSIVE_SIZE`; pick a preset for an exact fit), by `toPagePoint` in `browser-data.ts`. One finger: a tap is `tap`, 500 ms without moving is `longPress`, a drag is `scroll` (wheel deltas, one call in flight, latest wins); two fingers zoom/pan the picture locally with `pinch.ts` (a drag while zoomed pans it; the reset button restores). The text field is `type: "text"` into the focused element and the keys sheet sends `Enter`, `Tab`, `Escape`, `Backspace` and the arrows. Comment mode turns a tap into a sheet; `pick` returns the annotation to this phone only, which keeps it (`src/mobile/annotations.ts`, chips on the Browser screen and the composer) until its next prompt: `chat.send { annotations }` (validated by `parseAnnotations`, composed host-side by `ChatTasks.send` with `formatAnnotations` from `src/shared/annotations.ts`, the crops going as images), dropped from the phone once accepted; a slash command carries none. The sheet's **Send now** sends every waiting comment at once instead (`sendAnnotations`: `chat.send` with empty text, which steers a running chat), to the chat whose header opened the browser, else the tab's owner; with neither, only Add. Once the pick is saved the sheet closes even if Send is refused or the connection fails; those comments stay pending for the next message rather than inviting a duplicate pick. On a file preview the host's `previewContext` swaps the token URL for the file path and line (docs/FILE_PREVIEW.md, Comments). Checked by `pnpm e2e:remote` (`browserChecks`: the instance's own browser at the iPhone 15 preset against a local page, window hidden: frame, tap, text, key, scroll, pinch, suggestions, comment chip, host-composed prompt with the crop, Send now from the chat's browser, send failure and recovery with a two-comment/two-crop batch; shots `browser-*`).
- **GitHub page (T31):** `src/mobile/Github.tsx`, route `{screen:"page", page:"github"}`, same data as the desktop page: `github.project` (Refresh passes `refresh`), `github.choose` (the account sheet), `github.list` per kind and filter (both kinds loaded for the tab counts), reduced with the renderer's pure `lib/github` helpers. Problems (no gh, no remote, no login, no access) show as on the desktop. Actions sheet: Open on GitHub (`window.open` on the phone), Copy link, Review in a new chat (`chat.startTask` `{kind:"review", cwd, repo, item, login}`, pi runs on the Mac; PRs only), New card from it and Link to card (`board.apply` `add`/`link`). Tokens never leave the Mac; the phone only sees list results. Checked by `pnpm e2e:remote` (githubChecks against a public repo, read-only; shots 24 to 26).
- **Kanban board (T29):** the project sheet's Kanban board row (and "Show on the board") opens `src/mobile/Board.tsx` (route `{screen:"page", page:"board", cwd, cardId?}`) over the client's `board` global. A segmented control with counts (To do, In progress, In review, Done), a project switcher (`boardProjects`) and Add card. Card rows show title, latest report or notes, tags, GitHub badges, attachment count, chat count and the attention mark of the card's open chats (`cardMark`, from the live attention summaries). Moves: the row's actions sheet "Move to…" (`move` op, card goes on top) and a long-press drag within the column (`dropOp`: `move` with `before`); the page does not scroll while a row is dragged. The card page edits title, notes (Markdown view, textarea on tap), tags, GitHub links (`github.lookup`, then `link`; `unlink`), shows reports, attached chats (open, detach) and image attachments (`fs.describePaths`, Lightbox); title/notes saves carry `baseRev` from when the edit began and a `conflict` reply resets the fields to the host's text. Add card: description plus photos (`PUT /api/uploads`, then `board.addCard` with `{kind:"file", path}` attachments; the host starts triage). Card actions mirror the desktop's (`cardTasks`): Investigate, Resolve (not in done), QA (in review) via `chat.startTask`, and "Chat about it": a new chat whose route carries `cardId`, which `chat.send` passes so the host prefixes the card block and attaches the chat. Checked by `pnpm e2e:remote` (boardChecks, shots 23 to 28).
- **Laments (T30):** the project sheet's Laments row opens `src/mobile/Laments.tsx` (route `{screen:"page", page:"laments"}`) over the client's `laments` global (`laments.get` + `laments` events): Open and Resolved tabs from `projectLaments` (worst severity first, then recent; resolved by recency), a row with severity emoji, title, ×N, age and the latest report's snippet, expanding to every report as Markdown with links to the filing chats (`reportChat`) and the Fix chats (`fixChat`, branch). The actions sheet: Fix (`chat.startTask` `{kind:"fix"}`, notices as toasts, opens the new chat), Mark resolved / Reopen and Delete after a confirmation (`laments.apply`). Checked by `pnpm e2e:remote` (lamentChecks, shots 21 to 25).
- **ATP (T32):** the project sheet's ATP row opens `src/mobile/Atp.tsx` (route `{screen:"page", page:"atp"}`). Plans come from `atp.plans` (polled), runs from the client's `atp` global (`atp.state` + `atp.runners`/`atp.held`). The plan bar shows status, `done/total`, a progress bar and the run (phase, node, elapsed, the worker's chat), with Start/Run/Resume (`atp.start`), Stop (`atp.stop`), Lift (`atp.liftHold`), Release (`atp.releaseInterrupted`) and the run's last note; the Plans sheet switches plans with progress. The Nodes tab groups nodes by look (`src/mobile/atp-data.ts`, running, interrupted, failed, ready, split, locked, then folded done/closed) with a node filter; a node opens a sheet with instruction, context, report (Markdown), dependencies and its chats (`atp.threads`: the running worker joins its live handle, earlier ones open from their session file). The Graph tab reuses `AtpGraph` (levels of detail, minimap): its drag is now pointer-event based with a two-finger pinch (`touch-action: none`), so touch and mouse share the code. "Orchestrator chat" calls `atp.orchestrator` and opens the chat full screen (route `orchestrator: true`; leaving it calls `atp.releaseOrchestrators`); New plan offers Macro/Micro architect, calls `atp.discardNewPlan` + `atp.orchestrator` without a plan and opens the chat with `/skill:<architect> ` in the composer (route `prefill`). Checked by `pnpm e2e:remote` (atpChecks, shots 31 to 37): a throwaway three-node plan runs under fake-pi `FAKE_ATP=1` (start, nodes complete, stop, run again to 3/3), pinch and drag on the graph, orchestrator lease released on leave, new-plan composer.
- **Settings (T33):** the gear in the Projects header opens `SettingsScreen` (route `{screen:"settings", section?}`): General, Appearance, Models, Agent, Features, Computer use, Remote access, Updates (`src/mobile/settings-data.ts` holds the section list). Choices (theme, wallpaper, task models) go through `settings.apply` with the store's `rev` as `baseRev`; a refused or conflicting change toasts and reloads the latest. pi keys use `settings.pi`/`settings.setPi`, Computer use `computer.apply` (enable, revoke) and `computer.permissions` (status only; granting is on the Mac), devices `devices.list`/`devices.revoke` (no revoke for the current device: Sign out is in the section), updates the new `update` global (`update.get` + `update` events) and `update.download`. Left on the Mac: Shortcuts, Reveal in Finder, System Settings buttons, pairing, Restart. The phone follows iOS appearance; the theme row edits the Mac's. Model pickers list models through any live chat (`get_available_models`) and say so when none runs. Checked by `settingsChecks` in `pnpm e2e:remote` (shots 17-21).

### Provider sign-in from the phone (T34, `src/mobile/ProvidersSection.tsx`, `src/mobile/login-view.ts`)

Settings > Providers on the phone drives `providers.list/login/answer/cancel/logout`. Credentials flow phone -> host only: `AuthState` has names and statuses (asserted in `src/main/pi-auth.test.ts`: a saved key never appears in `list()` or in login updates), an API key is typed into a masked field and sent with `providers.answer`, and pi saves it in the Mac's `auth.json`.

**Per-client updates.** `providers.login` updates are not hub events (the hub is shared by every client and replays). The client names its SSE stream on every call (`x-pigna-stream`, which becomes `HostContext.clientId`), `remoteContext.authUpdate` calls `RemoteServer.notify(clientId, deviceId, {kind:"providers.login", update})`, and the server writes an unsequenced `event: client` frame on that device's own stream only. `HostClient.onLoginUpdate` hands it to the sheet. A login runs one at a time on the host; leaving the section or Cancel calls `providers.cancel`.

**Flow classification** (from `resources/pi-auth.mts`; the phone decides at run time from what the login sends, `loginGuide`):

| Flow | What pi sends | On the phone |
| --- | --- | --- |
| API key (`method: api_key`, any provider with `apiKey.login`) | `prompt` type `secret` | Masked field, Save. Works. |
| Device code (e.g. GitHub Copilot) | `device_code` event | Code shown large with Copy, and Open page. Works. |
| Link + pasted code or redirect (e.g. OpenAI Codex, Anthropic: browser flow with a local callback server racing a `manual_code` prompt) | `auth_url` + `manual_code` prompt | Link opens on the phone; paste the code or the redirect URL (the phone's own redirect to localhost fails to load, so copy the address). Works. |
| `select` first (which way to sign in) | `select` prompt | Options as buttons, then one of the rows above. |
| Optional text (Copilot Enterprise domain) | `text` prompt | Field, blank allowed. |
| Link only, redirect to a callback server on the Mac | `auth_url`, no prompt (seen after 1.5 s) | "Finish this sign-in on the Mac." No link offered; Cancel closes the sheet. |
| Claude Code (`claude-bridge`) | `auth_url` with `opened: true` + `manual_code` prompt | Claude Code opens its page in the Mac's browser itself (side effect on the Mac); the phone also gets the fallback link whose page shows a code to paste. Works by paste. |
| Providers where pi only reads the environment or models.json (`apiKey.login` false) | none | "Set on the Mac". |

Not verified against each live provider (needs real accounts): the table classifies by mechanism; tests use the fake SDK and fake `claude` in `src/main/pi-auth.test.ts` (API key, link+paste with the browser winning, device code, Claude Code paste). Sign out asks first; for Claude Code it says the sign-out affects the whole Mac, terminal included. Removing a saved key leaves environment and models.json keys.

### Mobile transcript extras (T28, `src/mobile`)

- **Same components, a phone's presentation:** `ChatUiActions` gained `Sheet` (a tool call opens `ToolDetails` in a bottom sheet instead of inline; Expand all in the chat header still opens them inline) and `visualFrames`. Diffs keep their own horizontal scroll, bash output goes through `Ansi`, written/read files through `CodeView`, anything else shows the arguments as JSON; the sheet has Copy command / Copy output.
- **Images:** a tap opens `Lightbox.tsx` (pinch, pan when zoomed, double tap, a sideways swipe at fit size pages through the answer's images with an "n / m" counter; math in `pinch.ts`). The image is a bare `<img>`, so iOS's long-press Save/Copy applies.
- **Turn jump list:** `Transcript` takes a `turns` render prop (the turns plus `jump`, which pages in an earlier turn when needed, scrolls and flashes it); `TurnList.tsx` shows it as a sheet with one row per message you sent and a star per row. Stars are `ui.apply` bookmark/unbookmark, the host's store, so they match the desktop rail.
- **Visuals:** shown when the Mac's Inline visuals setting is on. `GET /visual/<frameId>/{doc,kit.css,kit.js}` (no auth, no cookies: opaque-origin frames send none; method GET/HEAD; Host check still applies) serves `resources/visual` with `VISUAL_CSP`. The frame is `sandbox="allow-scripts"`, drawn after a tap; a silent frame (no heartbeat for 8 s) is removed and its source shown. `REMOTE_CSP` `frame-src 'self'` already allows it; the service worker skips `/visual/`.
- **Small things:** answers keep Copy and show their time; tapping your message shows its full time and Copy; links go through `window.open` on the phone.
- **Verification:** the `mobile-transcript` scenario of `pnpm e2e:remote` (shots 22-29) against a seeded "Tools demo" session (bash with ANSI, edit with a long diff line, read, a generic tool, images, a link, a healthy visual and one that stops its heartbeat). Unit tests: `pinch.test.ts`, `visual-frame.test.ts` (`visualRemoteAsset`), `remote-server.test.ts` (frame route).
