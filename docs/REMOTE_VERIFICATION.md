# Remote access: real iPhone verification

Runbook for confirming the remote slice on a real iPhone over Tailscale. Contract: [REMOTE.md](REMOTE.md); iOS platform notes: [REMOTE_IOS.md](REMOTE_IOS.md).
Results are recorded by a human on a real device. Fill the **Result** column, then the sign-off block.

## Prerequisites

- Tailscale on the Mac and on the iPhone, both signed in to the same tailnet.
- MagicDNS and HTTPS certificates enabled for the tailnet (admin console > DNS).
- A pi-gna build with the remote server (this repo's `main`), running on the Mac. Use a real agent (or `PIGNA_PI_BIN=scripts/fake-pi.mjs`; prompts containing `ask-confirm` raise an approval, `[lines=N]` / `[delay=N]` set length and pace).
- Record: iOS version `____`, pi-gna build `____`, Mac model/macOS `____`.

## Setup

1. In pi-gna Settings > Remote, enable remote access and click the Tailscale serve action (it runs `tailscale serve --bg --https=443 http://127.0.0.1:4517`).
2. Copy the `https://<mac>.<tailnet>.ts.net` URL shown there.
3. On the iPhone open it in Safari. For S1, Share > Add to Home Screen, then open from the icon.
4. Pairing is approved on the Mac in the Settings prompt.

## Automated results (run by the agent, 2026-10-05)

| Item | Result |
|---|---|
| `pnpm e2e:remote` (fresh build, fresh instance; pairing, open/dedupe, approvals first-wins, cancel, replay, idempotent retry, ring-overflow resync, clients closing mid-run, 7 mobile screenshots at iPhone 15 size) | PASS, "all checks passed" (this run 33 s; T20 ran it twice earlier, all checks) |
| iOS Simulator via `xcrun simctl` | NOT AVAILABLE: no Xcode (`xcrun: unable to find utility "simctl"`) |

Not automatable: everything below.

## Slice checklist (real device)

Run each in the Home Screen app unless noted.

| ID | Step | Expected | Result (PASS/FAIL + note) |
|---|---|---|---|
| S1 | Pair from the Home Screen app: open the https URL in Safari, Add to Home Screen, open the icon, request pairing, Allow on the Mac | Mac shows device UA + name; after Allow the phone lands on the session list |  |
| S2 | Pair from a Safari tab (separate device) | Asks to pair again independently; both appear as separate devices in Settings |  |
| S3 | Open a desktop session on the phone | Same transcript as the desktop, no duplicates |  |
| S4 | Send a prompt from the phone | Both desktop and phone stream the same text |  |
| S5 | Approval: run a prompt that raises a confirm dialog; answer on the phone | Desktop dialog clears; resolved by the phone's device |  |
| S6 | Stop from the phone mid-run | Run ends on both; phone no longer shows Stop |  |
| S7 | Lock the phone 2 minutes mid-run, unlock | Transcript catches up, no missing or duplicated lines; host kept running |  |
| S8 | Airplane mode on for 20 s, then off | Banner while offline; reconnects and catches up without re-pair |  |
| S9 | Wi-Fi to cellular (Wi-Fi off) mid-run | Stream resumes over cellular |  |
| S10 | Close the app mid-run (swipe away), reopen after 1 min | Host run continued; transcript is complete on reopen |  |
| S11 | Mac display sleep (system awake) | Phone keeps working |  |
| S12 | Mac system sleep or lid closed with no external display | Phone shows host unreachable banner; recovers on wake without re-pair |  |
| S13 | Revoke the phone from Settings on the Mac while connected | Phone drops to the pair screen; no data served afterwards |  |

## Device-only items from REMOTE_IOS.md section 8

| ID | Step | Expected | Result (PASS/FAIL + note) |
|---|---|---|---|
| D1 | Storage isolation (REMOTE_IOS row 1): Safari pairing is not visible in the Home Screen app | Home Screen app asks to pair again |  |
| D2 | Cookie persistence (rows 3, 4): force-quit, reboot, wait a day, repeat for 3 days without opening Safari; verify cookie Max-Age | Still paired; record iOS version |  |
| D3 | Reconnect timings (rows 6, 7): lock 30 s / 5 min / 30 min; Tailscale off/on; host server off/on | No duplicate/missing events; record whether the stream was OPEN-but-dead; banner vs re-pair |  |
| D4 | Host asleep (row 9) | See S12 |  |
| D5 | SW update (row 12): deploy a new build, open the installed app | Time until new version, update prompt shown, old client vs new host shows protocol message |  |
| D6 | Keyboard/safe area (rows 15, 16): portrait and landscape, predictive bar, status-bar style | Composer above keyboard, no zoom on focus, scroll to latest stays right |  |
| D7 | Uploads (row 17): Take Photo, Photo Library (HEIC), Files, a 10+ MB photo | Record the MIME/extension that arrives on the host (after attachments land) |  |
| D8 | Clipboard (row 18): copy buttons first tap; paste an image | Works |  |
| D9 | Memory (row 22): thousands of lines, 5+ inline visuals, browser view; background 10 min | Record whether a reload happened; state restored |  |
| D10 | Push, if built (rows 20, 21) | Prompt from a button in the installed app; absent in Safari tab | see N1-N9 |
| D11 | Standalone chrome (rows 13, 14): status bar, icon, name, every screen has a way back, external link return | Fine |  |

## Notifications (Web Push, REMOTE.md section 13a), real device, iOS 16.4+

Needs the Home Screen app, remote access on, and the Mac awake with internet access. Result column: PASS/FAIL + note (record the iOS version).

| ID | Step | Expected | Result (PASS/FAIL + note) |
|---|---|---|---|
| N1 | Open pi-gna in a Safari tab, Settings > Remote access | Notifications card says to add the app to the Home Screen; the switch is off and disabled |  |
| N2 | Open the Home Screen app, turn "Notify this phone" on | iOS permission prompt appears from that tap; after Allow the switch is on and the per-kind switches show |  |
| N3 | Start a long run on the Mac, lock the phone, let it finish unread | One "Run finished" notification with no chat text; tapping opens that chat |  |
| N4 | Make a run need an approval, do not answer for 10+ s with the phone locked | "Approval needed" arrives; tapping opens the chat with the card; answering on the Mac within 10 s sends none |  |
| N5 | Keep the chat open on the phone while a run finishes | No notification (suppressed while viewed) |  |
| N6 | Stop an ATP plan on a failed node (or let it finish) | "Plan stopped" notification |  |
| N7 | Turn "Run finished" off, finish a run | No notification; the other kinds still arrive |  |
| N8 | Quit pi-gna on the Mac with the phone locked | "pi-gna is quitting" arrives (best effort) |  |
| N9 | Revoke the phone on the Mac, then finish a run | Nothing arrives; `remote-push.json` in the Mac's userData no longer lists the device |  |
| N10 | Deny the permission prompt once | Card explains how to allow it in iOS Settings; no crash |  |
| N11 | Over several days with the app unused: does a push still arrive (iOS may revoke subscriptions that show nothing)? | Record the behavior |  |

## Sign-off

- [ ] All S rows pass on a real iPhone.
- Tester / date: `____`
- iOS version: `____`
- Failures and notes: `____`

## Human confirmation for T21

Manuel confirmed in the iPhone remote chat that connection and chatting work, and,
after being asked explicitly, confirmed testing approvals, Stop, lock/reopen
recovery, Wi-Fi-to-cellular recovery, Mac sleep/wake recovery, and revocation
removing access. This is user-reported real-device evidence, not an agent-observed
run. T21 is accepted on that confirmation to unlock mobile parity implementation.

The exact iOS/build versions, test durations, independent Safari/Home Screen
pairing, airplane-mode case and display-only sleep were not separately reported.
The blank detailed rows above are deliberately not filled with invented results;
carry these details and the extended D-series checks into final gate T44. This
acceptance does not claim full mobile parity or completion of the final gate.

## Full final gate (T44): whole feature on real iPhones

This is the release gate. Run it on a real iPhone (two phones for the F-series; iOS 16.4+ for push). Fill the Result column with PASS/FAIL plus a note; do not leave guesses. Release needs every row PASS or explicitly accepted below. Rows already covered in the S, D and N tables above are not repeated; run those too.

Automated before this gate: `pnpm typecheck`, `pnpm test`, `pnpm e2e:remote` (see "Automated results"). The iOS Simulator is not available here (no Xcode), so nothing below was agent-run.

### A. Feature inventory on the phone (plan section 2)

| ID | Feature | Expected | Result |
|---|---|---|---|
| A1 | Projects → Chats → Chat; pins, attention marks (running/waiting/failed/unread), per-device unread | Navigation works; pins match the desktop |  |
| A2 | Open existing session, new chat, Close chat (confirmed) | Close stops pi on the host; others unaffected |  |
| A3 | Open a project via the host folder browser (directories only) | New project appears on desktop too |  |
| A4 | Transcript: markdown, code highlight, work accordion, tool rows/sheets, diffs (horizontal scroll), thinking, images, time dividers | Matches the desktop transcript |  |
| A5 | Streaming, tok/s, context meter (tap), compaction indicator, Compact now | Works |  |
| A6 | Composer: Send, Queue/steer, Stop (confirm), queue card (steer now/edit/delete) | Same outcome as desktop |  |
| A7 | `/` commands, `@` file mentions, model and thinking pickers | Sheets work; choices apply on the host |  |
| A8 | Attachments: photo, file, host file via browser | Arrive as paths/images in the prompt |  |
| A9 | Approval cards (select/confirm/input/editor), notify toasts, widgets, set_editor_text | First answer wins; others clear |  |
| A10 | Turn rail / bookmarks jump list | Jumps and bookmarks persist on the host |  |
| A11 | Inline visuals | Tap-to-render; stuck frame is removed |  |
| A12 | Long-press action sheets (copy/save image, links, chats, cards, tabs) | Work; links open on the phone |  |
| A13 | Kanban: columns pager, Move to…, reorder, add card (+screenshot), card dialog, tags, GitHub links, card actions (Investigate/Resolve/QA/Chat about it) | Board matches desktop; edit conflict shows a base-revision message |  |
| A14 | Laments: list, reports, Fix (worktree chat), resolve/reopen/delete | Works |  |
| A15 | GitHub: issues/PRs, account choice, New card, Link to card, Review a PR | Review opens a pr-review chat |  |
| A16 | ATP: plans, node list/graph pan+pinch, node panel, Start/Stop/Resume, orchestrator chat, New plan | Runner continues on the host |  |
| A17 | Integrated browser: tabs, address bar, back/forward/reload, viewport, tap/scroll/type, comment mode | Frames stream; input reaches the host tab |  |
| A18 | Agent `browser_*` URL approvals | Card on the phone; answering works |  |
| A19 | Computer Use: per-app approval, Stop, live preview | Works; permission grants stay on the Mac |  |
| A20 | Settings: General, Appearance, Models, Agent, Beta, Features, Computer use | Same ops; Finder/System Settings buttons hidden |  |
| A21 | Providers: API key, device-code login, manual-code fallback | Credentials go phone → host only |  |
| A22 | Updates: status and Download; Restart hidden | Matches the desktop |  |
| A23 | Toasts, lightbox, wallpaper | Fine |  |

### B. Safari and Home Screen

| ID | Step | Expected | Result |
|---|---|---|---|
| B1 | Repeat A1–A5 and A9 in a Safari tab | Works; push offered only as "add to Home Screen" |  |
| B2 | Repeat A1–A5 and A9 in the Home Screen app | Works; own pairing (D1) |  |

### C. Connectivity, sleep and host lifecycle

| ID | Step | Expected | Result |
|---|---|---|---|
| C1 | Wi-Fi → cellular → Wi-Fi mid-run; Tailscale off/on on the phone | Stream resumes; no duplicate/missing events (S8, S9, D3) |  |
| C2 | Phone suspended / app backgrounded 10 min | Resumes without re-pair (S7, D9) |  |
| C3 | Mac display sleep only | Phone keeps working (S11) |  |
| C4 | Mac system sleep | Unreachable banner; recovers on wake (S12) |  |
| C5 | Lid closed, no external display, on battery | Unreachable banner; recovers on open |  |
| C6 | Lid closed with an external display, on power, keep-awake on | Phone keeps working with the lid closed |  |
| C7 | Lid closed with an external display, on power, keep-awake off | Record behavior (expected: Mac sleeps per macOS) |  |
| C8 | Restart the Mac; pi-gna auto-starts or is launched | Phone reconnects without re-pair; running chats were ended by the restart, not by the phone |  |
| C9 | Quit pi-gna while a run is active | Phone shows host offline; relaunch → reconnect without re-pair |  |

### D2. Concurrency: two phones plus the desktop (F-series)

| ID | Step | Expected | Result |
|---|---|---|---|
| F1 | Phones P1 and P2 and the desktop open the same chat; each sends a prompt | Prompts are queued/ordered; all three show the same transcript |  |
| F2 | Raise an approval; answer on P1 and P2 at the same time | First answer wins; the others clear; no double action |  |
| F3 | Edit the same Kanban card on P1, P2 and the desktop | Conflict is reported, no silent overwrite; board converges |  |
| F4 | Start/Stop an ATP plan on P1 while P2 and the desktop watch | One state everywhere; Stop is not duplicated |  |
| F5 | Close the chat on P1 while P2 views it | P2 is told, no crash |  |

### E. Revocation and pairing limits

| ID | Step | Expected | Result |
|---|---|---|---|
| E1 | Revoke P1 on the Mac while P1 streams a run | P1 drops to pairing; run keeps going; P2 unaffected |  |
| E2 | Re-pair the revoked phone | Needs a new Allow |  |
| E3 | Pairing limits: repeat pairing requests quickly; leave one unanswered | Rate limit / pending cap / expiry per REMOTE.md; the Mac is not flooded |  |
| E4 | Turn remote access off in Settings | Both phones lose access; no listener remains |  |

### G. Security spot checks (from the phone)

| ID | Step | Expected | Result |
|---|---|---|---|
| G1 | Settings, Providers, GitHub, Agent pages | No API keys, tokens or secret values shown, only set/unset |  |
| G2 | Open the https URL from a non-paired browser/device on the tailnet (private tab) | Pairing screen only; no data, no API results |  |
| G3 | From that browser, request `/api` and event endpoints directly | 401/403; nothing served |  |
| G4 | Off the tailnet (Tailscale off), open the URL | Unreachable |  |

### Final sign-off (required for T44 to complete)

- [x] Every row above (and the S, D, N tables) is PASS or explicitly accepted below.
- Tester / date: Manuel / 2026-10-05
- iOS versions / devices: not reported
- Accepted deviations (row, reason): individual rows were not recorded; the gate is accepted on the tester's overall confirmation (see below).
- Failures and notes: none reported.

## Human confirmation for T44

On 2026-10-05 Manuel reported in the ATP orchestrator chat that the final real-device verification is done and "works very well", and asked to complete the plan. This is user-reported real-device evidence, not an agent-observed run. The per-row Result cells above stay blank rather than being filled with invented results; device and iOS versions were not reported.
