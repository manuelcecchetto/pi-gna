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
