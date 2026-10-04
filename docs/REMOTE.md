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
| `chat.open` | remote | yes | `openSession`. Args `{ request: OpenSessionRequest }`. **Host issues the handle.** Opening a session file already live attaches to its handle (`reused: true`); otherwise spawns pi. Takes a lease. Returns `{ handle, reused, entries }`; a remote caller gets `entries: []` and reads the chat with `chat.snapshot` (the whole branch would only cost bandwidth). ATP sessions via `request.atp`. |
| `chat.attach` | remote | no | new. Lease on a live chat + snapshot (reconnect, second client, adopt a chat another client started). Returns the flat `ChatSnapshot & { seq }`, or null when the chat ended. |
| `chat.viewing` | remote | yes | new. This client shows (or stops showing) the chat in the foreground; showing it clears the chat's unread mark. |
| `chat.live` | remote | no | new. `AttentionSummary[]` of every live chat (first paint of the marks; `global` `attention` events carry the deltas). A summary carries the chat's `sessionPath`, which matches it to its row in `chat.list`. |
| `chat.detach` | remote | yes | new. Releases the lease; the host may then dispose (section 5). |
| `chat.close` | remote | yes | `closeSession`. Explicit stop of pi; broadcast to all clients. Mobile asks for confirmation. |
| `chat.snapshot` | remote | no | new. `{ seq, value: ChatSnapshot }`, the last 40 turns; `before` (a turn index, the previous page's `turns.from`) pages earlier ones, whose `state` carries just their items and tools. |
| `chat.send` | remote | yes | the `send` action in `state/app.ts` plus `command(prompt)`. Args: text, mode (`send`/`followUp`), `attachments` (upload ids or host paths), `annotationIds`, `cardId`. Host composes the message (card block, annotations, file mentions, images), picks `streamingBehavior`, marks the chat prompted. |
| `chat.command` | remote | yes | `command`, restricted to the RPC allowlist (section 7). Result `RpcResponse`. |
| `chat.interrupt` | remote | yes | `interrupt` (`app.ts:560`): clear_queue then abort under the chat mutex; returns the restored queued texts (`string[]`). |
| `chat.editQueue` | remote | yes | `editQueue` (`app.ts:549`): clear, `applyQueueOp`, re-queue under the mutex; true when the queue held the text. |
| `chat.respondDialog` | remote | yes | `respondUi`. First response wins; a later one is answered `{ ok: false, code: "already_answered" }` (a `DialogAnswer`, not an HTTP error; section 8). |
| `chat.startTask` | remote | yes | new; absorbs `startCardChat`, `discussCard`, `fixLament`, `reviewPullRequest`, `cardWorktree`, `lamentWorktree`, triage. Kinds: `triage`, `investigate`, `resolve`, `qa`, `discuss`, `fix`, `review` (review takes `cwd`, `repo` and `item` as GitHub lists them, and `login`). Host-side (`src/main/chat-tasks.ts`): worktree, link to the card/lament, model, prompt, name, under a host lease that ends when the first run settles; a triage that ends well and that nobody views closes. Returns `{ handle, snapshot, notices }` (`notices` are what the client toasts). `board.addCard` (cwd, column, description, attachments of image bytes or host paths) adds a card, saves its images and starts its triage. `chat.send` composes `cardId` host-side; attachments and annotations follow with the phone's uploads. Landed in T22. |
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
| `ui.get`, `ui.apply` | remote | apply yes | `uiGet`, `uiApply`. Pins and bookmarks live in `<userData>/ui-state.json` (`UiState`, ops `pin`/`unpin`/`reorder`/`bookmark`/`unbookmark` in `src/shared/ui-state.ts`; a bookmark is a session file + message timestamp); changes ride `global` as `ui`. Layout (sidebar width, ATP panel sizes, wallpaper loop) and unread "seen" marks stay per client. |
| `ui.importLegacy` | desktop | no | `uiImportLegacy`. Merges the window's old localStorage pins and bookmarks once, then the renderer forgets them. |

**atp** (the runner is in main: `src/main/atp-runner.ts`)

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `atp.plans` | remote | no | `atpWatch` + `atpPlans` push. Starts watching a project for this client; `{ seq, value: AtpProjectPlans }`; updates ride `global` as `atp.plans`. |
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
| `browser.newTab`, `browser.closeTab`, `browser.activate`, `browser.navigate`, `browser.command`, `browser.annotate`, `browser.inspect`, `browser.viewport` | remote | yes | the same-named channels. |
| `browser.view` | remote | no | new. Starts/stops a frame stream for a tab (latest-only frames; see section 4). |
| `browser.input` | remote | yes | new. Tap, scroll, text, key on a tab; and `pick` for comment mode (element at the tapped point). |
| `browser.layout`, `browser.popOut`, `browser.returnToPane`, `browser.reveal` | desktop | yes | `browserLayout`, `browserPopOut`, `browserReturn`, `browserReveal` (window-bound; pop-out windows are host-only). |

**fs and uploads**

| Method | Scope | Mutates | Replaces / notes |
|---|---|---|---|
| `fs.browseFolders` | remote | no | new. Directories only, below `homeDir`; names and `isDirectory`; no file contents, never follows symlinks out. |
| `fs.pickFolder` | desktop | no | `pickFolder` (native). |
| `fs.pickAttachments` | desktop | no | `pickAttachments` (native). |
| `fs.describePaths` | desktop | no | `describePaths`: reads any absolute path (image bytes), so it is desktop-only; the phone sends uploads instead (security test: remote-server.security.test.ts). |
| `uploads.put` | remote | yes | new. Bytes from the phone stored under `userData/uploads`; returns `{ id, path, name, image? }`. Size/type caps (section 12). |
| `uploads.discard` | remote | yes | new. |

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
  subscriber in one call, which keeps the desktop's `IPC.events` batching), `subscribe({ topics, deliver, onClose })`
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
- **Frame transport:** `browser.view` frames are binary JPEG over a separate `GET /api/browser/view/<tab>` stream
  (multipart/x-mixed-replace or length-prefixed chunks, decided by T02's measurement); never SSE.

## 5. Leases and the dispose rule

- A **lease** is `(handle, clientId)`. `chat.open`/`chat.attach` take one; `chat.detach` releases it. The desktop's
  clientId is `desktop`; a phone's is its stream id. A lease whose SSE stream closed is kept for a **60 s grace**
  (page suspended, reconnect) and then expires.
- **Dispose rule (host decides):** pi stops for a chat only when it has no live leases and `isDisposable` holds
  (not prompted, not running, not compacting, no dialogs, no unread outcome), or on an explicit `chat.close`. A lease
  expiring never kills a prompted, running, compacting, dialog-holding or unread chat; closing or suspending a
  client never cancels host work.
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
  (`main.log`).
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
- **Audit:** `main.log` records `remote <deviceId> <method>` (names and status, never args).

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
- **Limits:** JSON bodies ≤ 1 MiB; `uploads.put` ≤ 25 MiB per file (images are also returned as image content,
  downscaled by the client to ≤ 4096 px), at most 10 uploads per message; upload dir pruned with the chat/card it
  belongs to or after 7 days orphaned.
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
| 5 | **Web Push:** go/no-go deferred to T38. Not part of this contract. | Separate design (leaves the tailnet). |
| 6 | **Update Restart:** host-only (`update.restart` desktop scope); the phone can see state and Download. | Restart drops the server and every chat; it should be a deliberate action at the Mac. |
| 7 | **Scopes:** none in v1; every device is full-access. `DeviceRecord` reserves `scope: "full"` so read-only devices can be added without a migration. | Keeps v1 small; the field is the only forward hook. |

Additional decisions made while writing the contract:

- **One object argument per method**, positional IPC adapted in the preload/main, so remote JSON and IPC share one validator.
- **`providers.*`** replaces the preload's `auth.*` in the table; "auth" in this contract means device authentication.
- **ATP low-level methods** (`claim/release/activate/head/commit/info`) are desktop-scope until T23 makes them host-internal, then leave the table.
- **`chat.rawCommand`** stays desktop-only as a transition; removed once the desktop uses `chat.command` + `chat.send`.
- **Subscriptions never lease**: only `chat.open`/`attach` lease, so a phone cannot keep a chat alive by streaming it.
- **Text-edit conflicts are coarse first** (`baseRev` staleness), refined only if T09 finds it cheap.

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
- **Transcript:** the desktop's `Transcript`, `Activity`, `ToolDetails`, `Markdown`, `Dialogs` and `QueueCard`, unchanged but for `src/renderer/src/lib/chat-ui.tsx`: they read expansion state, board cards, wallpaper/visuals and actions (lightbox, open link, answer dialog, edit queue) from a `ChatUi` context. The desktop provides it from its store in `renderer/src/main.tsx`; the phone from `src/mobile/chat-ui.ts` (no visual frames or wallpaper, links open in the phone's browser). "Show earlier turns" pages `chat.snapshot { before }` through `HostClient.loadEarlier`, keeping the scroll position. Touch sizing uses the `touch:` Tailwind variant (`pointer: coarse`).
- **Composer:** text drafts are per chat in `localStorage` (`pigna:draft:<session file>`). Send is a steer while the agent works (`chat.send mode: "send"`), Queue is `mode: "followUp"`, Stop asks first, then `chat.interrupt` and the returned queued texts go in front of the draft. Attachments, `@` mentions and slash-command pickers are later nodes.
- **Connection:** the banner shows reconnecting / unreachable / outdated with "Retry now". After a browser-side EventSource retry (same URL, so without the chats on screen) the client re-subscribes and rereads the chats on `hello`, so a reconnect cannot leave a transcript stale.
- **App info:** `app.info` (`homeDir`, `launchCwd`, `version`, `buildId`) is in the table; the phone uses `homeDir` to shorten paths.
