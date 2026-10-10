# Remote access: threat model and review

Scope: everything reachable from the phone (`docs/REMOTE.md`). Reviewed against the code at T42. Tests named here run in
`pnpm test` (security suite: `src/main/remote-server.security.test.ts`).

## 1. Assets

| Asset | Why it matters | Reachable from a paired phone? |
|---|---|---|
| Host shell, via agents | An agent runs shell commands as the user | Yes, by design: a paired device is full-access (REMOTE.md decision 7). Compromise of a device = compromise of the Mac's user account. |
| Repositories | Source and secrets in working trees | Through agents, `chat.files`, `github.*`, `fs.browseFolders` (below the home folder, names only) |
| Provider credentials, `auth.json` | Billing, account access | Written (`providers.login`), never read back (tested: login updates never carry the key) |
| gh tokens | Repo access | Never returned; `github.*` runs `gh` on the host |
| Browser profile cookies | Logged-in sessions in the host browser | Pixels only (frame stream) and input; no cookie or storage API. The agent/phone can use the logged-in pages, same as the desktop. |
| Computer Use reach | Control of any non-denylisted app | Via agent runs; approvals and policy edits identical to desktop (section 5) |
| Device credentials | Authenticate a phone | Hashed at rest (`remote-devices.json`, 0600); cookie `HttpOnly; Secure; SameSite=Strict` |
| Web Push keys | Push to a device | VAPID key in `remote-push.json` (0600), never sent to a client |

## 2. Trust boundaries

1. Phone ⇄ tailnet ⇄ `tailscale serve` (HTTPS, tailnet only; the host never opens a public port).
2. `tailscale serve` → loopback `RemoteServer` (127.0.0.1). Any local process can reach this port directly.
3. `RemoteServer` → HostCore method table (scope check, validation, idempotency) → SessionHost / managers.
4. AgentBridge (loopback, per-run tokens): **not reachable** from the remote server (no route; tested).
5. pi processes and the Computer Use helper: spawned by the host, never given remote credentials.
6. Model output → mobile renderer: untrusted content crossing into the DOM.

## 3. Attackers, abuse paths, mitigations

| Attacker | Abuse path | Mitigation | Evidence |
|---|---|---|---|
| Stolen, unlocked phone | Use the paired PWA | Revoke from the Mac (or another phone): streams, browser views and push subscription die at once; revoke all. Cookie max age is bounded. iOS device lock is the first line. | `devices.test.ts`, security suite (revocation closes streams) |
| Stolen phone | Revoke other devices / rename | Accepted (section 4, A2) | |
| Another tailnet device or user | Pair without being invited | Pairing needs a short-lived code shown on the Mac **and** explicit approval on the Mac; codes lock after failed attempts; rate limit 10/min globally and per Tailscale login | `devices.test.ts`, security suite |
| Another tailnet device | Use a stolen cookie from a different login | Cookie bound to the Tailscale-User-Login recorded at pairing (401 on mismatch, 403 without header). Defense in depth only: a local process can forge it. | security suite |
| Another tailnet device | DNS rebinding / foreign Host | `Host` must be the configured tailnet name or a loopback test name, checked before anything else | security suite |
| Malicious web page in any browser on the phone/Mac | Cross-site request with the cookie | `SameSite=Strict`, `Origin` must be `https` and equal to Host, `X-Pigna-Client: 1` required on POST/PUT; CORS never enabled | security suite (http Origin was accepted before T15, fixed) |
| Malicious local process | Call 127.0.0.1 directly | Still needs a valid device cookie; no unauthenticated mutating route; AgentBridge tokens not accepted. A local process that can read the user's files can already read the userData folder: accepted (A3). | security suite |
| Malicious local process | Forge Tailscale header | Header is not the gate; the device credential is | REMOTE.md s.11 |
| Malicious web content in the host browser | Page triggers host actions through the remote surface | The remote server is not reachable from the browser's origin (Host/Origin/cookie checks); pages cannot reach the AgentBridge (loopback token); phone input goes only to tabs through `browser.input`. | security suite |
| Prompt-injected agent | Exfiltrate via tools, spend money, drive apps | Same host policies as the desktop: Computer Use approvals/denylist, browser approvals, extension dialogs go to every attached client, first answer wins. Remote has no extra privilege. Cannot turn on remote/pair devices (desktop-only methods). | section 5 |
| Prompt-injected agent | Make the phone open a malicious link or script | Links open through the normal markdown link path (external, `rel=noopener`); no auto-navigation | |
| XSS through model output on the phone | Script in markdown/HTML | `DOMPurify` always runs on rendered markdown (`FORBID_TAGS` style/form/input); CSP `script-src 'self'`, no inline script, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; inline visuals are `sandbox="allow-scripts"` frames (opaque origin, no cookies) served with the strict visual CSP (no network, forms, navigation) | `lib.test.ts` (markdown), security suite (CSP headers) |
| Any authenticated client | Read arbitrary host files | `fs.describePaths` is desktop-only (fixed T15); `fs.browseFolders` is confined below the home folder, skips hidden entries, does not follow symlinks out, and returns names only; uploads are confined to `remote-uploads/<device>/<uuid>/` | security suite, `browse.test.ts`, `uploads.test.ts` |
| Any authenticated client | Read host files through a chat's links | `chat.resolveLinks`, `chat.linkImage`, `chat.readFile`, `chat.openFile` resolve only inside the chat's cwd and project, symlinks followed. Exception: an image file (by extension, 20 MB cap) that the chat's own assistant answers embed loads wherever it is. A phone cannot add it by writing a path: its own messages do not count. Getting the agent to embed one equals asking the agent to read the file, which an authenticated client can already do (prompt-injected agent row). | `host-core.test.ts` ("a phone's chat links") |
| Any authenticated client | Read another device's upload | 404 for another device; non-uuid ids/paths 400 | security suite |
| Any authenticated client | Exhaust the host (big bodies, streams) | JSON cap 1 MiB, upload cap 25 MiB × 10 enforced while streaming, SSE backpressure with hard cap, 6 browser streams, Computer Use preview 1/s per client | security suite |
| Any authenticated client | Replay a mutating call | `Idempotency-Key` required, per-device cache keyed on boot id and body | `command-layer.test.ts` |
| Any authenticated client | Raw RPC passthrough | `chat.command` only allows an allowlist; `chat.rawCommand` desktop-only | security suite |
| Any authenticated client | Read the usage report (costs, tokens, project folders, session names) | `usage.get` is read-only and remote, and gives aggregates only: the facts never hold message text, tool arguments or output, and an error message is a category. Session names are untrusted text (the phone renders them as text, T16). Project keys are folder paths that `chat.list` already sends. The query is checked and every list is capped (`usage-service.ts`, DESIGN "Usage"). | `usage-service.test.ts` (query checks, bounds), `host-core.test.ts` ("usage"), `remote-server.test.ts` ("reads the usage report without a key") |
| Any authenticated client | Make the host scan or rewrite the session files again and again | `usage.refresh` needs an `Idempotency-Key`, and a refresh asked while a scan runs joins it, so one scan runs at a time. It reads pi's session files and writes only `usage-index.json` (temp file and rename). No network. | `usage-service.test.ts` ("joins a refresh"), `remote-server.test.ts` (key required) |
| Any authenticated client | Read a non-plan JSON via `atp.read` | **Fixed at T42**: path must be an absolute `.atp.json` | `host-core.test.ts` |
| Network observer / push service | Learn chat content | Web Push payloads carry no chat titles or text (opaque chat handle, kind only); RFC 8291 encrypted. The push service sees host IP and timing (accepted, A5). | `push-service.test.ts` |
| Anyone investigating after the fact | Who did what | Audit in `main.log`: `remote <deviceId> <method> <status>` for every call, upload and stream; **added at T42**: `device paired/revoked <id>` and `pairing <state>` lines. Args and secrets are never logged. | code review |

## 4. Accepted risks

| # | Risk | Reason |
|---|---|---|
| A1 | A paired device has full access (agents run shell). No per-device read-only scope in v1. | The product is remote control of coding agents; a read-only phone would defeat it. `DeviceRecord` reserves a scope field. Mitigated by approval at pairing, revocation, Tailscale login binding. |
| A2 | A paired device can revoke or rename other devices. | Needed to revoke a lost phone from the other phone. Worst case is denial of service; re-pairing needs the Mac. |
| A3 | A local process running as the user can read `userData` (device hashes, push keys, uploads) or attach to the loopback port. | Same user = already owns the account and the agents' shell. Files are 0600. |
| A4 | `chat.open`, `chat.files`, `github.*` and attachment `{path}` refs take any absolute path on the host. | An agent on the same phone can read the same files through its shell; the desktop behaves identically. Results of `{path}` go to the model, never back to the phone. |
| A5 | Push provider (Apple/Mozilla/Google) sees timing and host IP. | Inherent to Web Push; payloads are encrypted and contain no content. |
| A6 | `style-src 'unsafe-inline'` in `REMOTE_CSP`. | Needed by the mobile build's runtime styles. Scripts stay `'self'` only; the visual frame CSP is stricter. |
| A7 | Idempotency is not enforced on `PUT /api/uploads`. | A retried upload duplicates a file; pruned after 30 days. |
| A8 | An invisible keeper window hosts browser tabs while the app window is hidden. | Needed so screencast and touch work; it is click-through and unfocusable. |
| A9 | The Tailscale login header is forgeable by a local process. | It is defense in depth only; the cookie is the gate. |

## 5. Approvals and policies: remote equals desktop

- **Extension dialogs / approvals** (`SessionHost.requestChoice`, `respondDialog`): shown to every attached client; the first
  answer wins; the answer names who gave it. (`session-host.test.ts`.)
- **Computer Use**: the policy (enabled flag, denylist, allow-lists, Always allow) lives in `ComputerStore` and is applied in
  the host whoever started the run; `computer.apply` edits it through the same revision-checked path; the preview only shows
  apps the chat holds and rechecks denylist, enabled flag and lock; there is no screen capture method. Interrupt from the
  phone aborts the run and releases held apps (`route.integration.test.ts`).
- **Preview tabs**: `BrowserTab.preview` carries the file's real path and name; the phone shows those, not the
  `pigna-file://<token>` URL (the token is only a capability inside the host browser partition; the phone gets pixels).
  `browser.previewMode` (Rendered/Raw) is remote-allowed: it takes a tab id and a two-value enum, no paths. Opening,
  revealing and opening externally stay desktop-only. No BrowserState change was needed.
- **Browser**: agent browser control and approvals are in `BrowserAgent`/`BrowserManager`, not per client; phone input is
  limited to `browser.input` on host tabs, and the agent indicator uses the same `agentAt` stamp.
- **Desktop-only** (never callable remotely, `scope_denied`): enabling/disabling remote, pairing codes and approvals,
  `devices.revokeAll`, native pickers, `host.openExternal`, relaunch, `chat.rawCommand`, `fs.describePaths`, `settings.revealPi`.

## 6. Review result

| Finding | Status |
|---|---|
| `fs.describePaths` read any path for a phone | Fixed (T15), tested |
| CSRF accepted an `http://` Origin | Fixed (T15), tested |
| `atp.read` accepted any path | Fixed (T42), tested in `host-core.test.ts` |
| Pairing, revocation not in the audit log | Fixed (T42), `index.ts` logs ids only |
| Items A1-A9 | Accepted, reasons above |
