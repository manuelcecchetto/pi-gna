# pi-gna on Linux (experimental)

Status: **experimental, run from source, one tested setup.** Everything below was checked on KDE Plasma 6.7.5 on
Wayland (CachyOS, NVIDIA) with pi 1.2.0 on 2026-10-13, by running the app and reading the result back (the window list
from KWin, screenshots, page state, logs). Other desktops (GNOME, Sway, Hyprland, X11 sessions) are untested; the
browser, chats, files and remote access do not depend on KDE, Computer Use does. There is no Linux package and no
updater yet.

## Run from source

Needs Node 22.19+ (24 tested), pnpm 10 (the version pinned in package.json), git, ripgrep, and **pi 1.x** on your PATH
(pi-gna v0.21 uses pi 1.x's SDK; with pi 0.79 the setup's Providers step fails).

```bash
pnpm install --frozen-lockfile
node node_modules/electron/install.js   # pnpm 10 skips Electron's download; this fetches it once
pnpm build
node bin/pi-gna.mjs
```

The app runs natively on Wayland (Electron picks Ozone/Wayland when `XDG_SESSION_TYPE=wayland`). Its settings live in
`~/.config/pi-gna`; worktrees and the Computer Use helper in `~/.pi-gna`.

Signing in: a Claude plan signs in through Claude Code (Settings > Providers > Claude Code, which installs
pi-claude-bridge and uses `claude`'s own login). If pi still has an expired login of its own for the `anthropic`
provider, sign it out there: task chats (card triage, titles) pick a model by id and may otherwise land on the expired
login, and so does any chat while pi's default provider is `anthropic`. Settings > Models can pin each task to a
provider.

## What works (observed)

- **Chats**: `pi --mode rpc` per chat, your pi config, extensions and session files; the sidebar lists the sessions you
  started in the terminal. Alt+Enter queues a follow-up, Esc Esc stops the run and returns the queue, @ mentions files,
  Ctrl+V pastes a screenshot, Ctrl+K opens search, Ctrl+, opens Settings.
- **Shared browser**: the agent opens local dev servers (Vite HMR included) and external sites (with the per-origin
  approval card), clicks, types, presses keys, reads text, takes screenshots, previews files (Markdown, PDF), uses
  device presets and device windows. Cookies persist (Electron uses KWallet for safeStorage on Plasma). This works with
  the pi-gna window focused, covered by other windows, minimized, on another virtual desktop and while the screen is
  locked.
- **Kanban**: describe a task, triage names, tags and investigates it; Resolve works in a git worktree, commits on its
  own branch and moves the card to In review. (A project needs at least one commit for worktrees.)
- **GitHub**: the page reads a project's issues and pull requests through `gh` with the matching account; a review chat
  reviews a PR without touching the checkout and posts nothing.
- **Laments**: pi files a lament when a tool is missing and carries on; the page lists them.
- **ATP plans**: worker chats run a plan node by node (a two-node plan with a dependency completed).
- **Inline visuals** render in replies (turn them on in Settings).
- **iPhone remote** over Tailscale: pairing, chats, approvals answered on the phone, the board. See the setup notes below.
- **Files**: attach files from the picker, drag and drop, @ mentions (new files show up within about 30 s), reveal in
  the file manager (Dolphin).
- **Computer Use** (KDE Plasma only): see its section below.

## Remote access setup on Linux

1. `sudo tailscale set --operator=$USER`. This setting is **per Tailscale profile**: after `tailscale switch` to
   another tailnet, run it again there. Without it, Serve over Tailscale fails with "Access denied: serve config
   denied" (pi-gna does not yet say what to run).
2. Turn on HTTPS certificates for the tailnet (Tailscale admin console > DNS). pi-gna says so when they are off.
3. Settings > Remote access: turn it on, Serve over Tailscale, pair the phone as on macOS.

With remote access on, closing the window **minimizes** it on Linux (it stays in the taskbar; there is no Dock or tray to
bring it back). Keep awake takes a power inhibition while remote access is on, which KDE lists as "electron" (an actual
idle suspend being prevented was not tested). "Open at login" is macOS only: add an autostart entry yourself if you
want one.

## Computer Use on KDE Plasma

A Linux helper (`native/computer-use-linux`, Python) speaks the same protocol as the macOS helper. It needs these
packages (Arch names): `python-gobject`, `python-dbus`, `python-pillow`, `libei`, `at-spi2-core`,
`gtk4-layer-shell`, `wl-clipboard`, and Plasma's `kbuildsycoca6`. Turn it on in Settings > Computer use; the first use
installs the helper under `~/.pi-gna/computer-use/linux` with its own copy of the system Python, and writes
`~/.local/share/applications/io.github.manuelcecchetto.pigna.computeruse.desktop`, which lets KWin give window
screenshots to that copy only.

How it differs from macOS:

- **Foreground, not background.** Reading an app (accessibility tree through AT-SPI, window screenshots through KWin)
  happens in the background, and accessible actions (press a button, set a field, select text) do too. Clicks by
  coordinate, typing and keys go through KWin's input server onto your real seat: the target window comes to the front
  and your pointer moves. Do not type while pi works; your keys can land in the target (seen once).
- **Stop button instead of Esc.** A banner at the top of the screen says which app pi is using; its Stop button ends
  the run. (Wayland apps cannot listen for Esc globally.)
- App ids are desktop file ids (`org.kde.kcalc`; an id without a dot ends in `.desktop`). Terminals, password and
  wallet prompts, portal dialogs, the lock screen, the Plasma shell, KRunner and pi-gna itself are never operated.
- Chromium and Electron apps expose their page tree once the helper reads them; the first read takes about half a
  second longer. Typing goes through the keyboard on a US layout, otherwise through accessibility or the clipboard.

Check it on your desktop (moves the pointer and keyboard for a few seconds):

```bash
python3 native/computer-use-linux/check.py
```

## Keep pi-gna from taking focus (KDE Plasma)

Add two window rules (System Settings > Window Management > Window Rules shows them afterwards):

```bash
K=kwinrulesrc; w() { kwriteconfig6 --file $K --group "$1" --key "$2" "$3"; }
G1=pigna-keeper; w $G1 Description "pi-gna background tabs: never take focus"; w $G1 wmclass pi-gna; w $G1 wmclassmatch 1
w $G1 title "pi-gna background tabs"; w $G1 titlematch 1; w $G1 acceptfocus false; w $G1 acceptfocusrule 2
w $G1 fsplevel 4; w $G1 fsplevelrule 2; for k in skiptaskbar skippager skipswitcher; do w $G1 $k true; w $G1 ${k}rule 2; done
G2=pigna-device; w $G2 Description "pi-gna device windows: do not steal focus"; w $G2 wmclass pi-gna; w $G2 wmclassmatch 1
w $G2 title '^(.+ [0-9]+x[0-9]+ @[0-9.]+x|Responsive)$'; w $G2 titlematch 3; w $G2 fsplevel 4; w $G2 fsplevelrule 2
OLD=$(kreadconfig6 --file $K --group General --key rules); w General rules "${OLD:+$OLD,}$G1,$G2"
w General count $(( $(kreadconfig6 --file $K --group General --key count --default 0) + 2 ))
qdbus6 org.kde.KWin /KWin reconfigure
```

The first rule is the one tested (above). The second keeps device windows (`browser_window`) from taking focus when
they open; it was not tested.

## Known limitations

- **Agent in a background chat steals focus, unless you add a KWin rule.** When an agent uses the browser in a chat you
  are not looking at, pi-gna parks its tab in a hidden "keeper" window (titled "pi-gna background tabs"). On Wayland
  KWin activates that window each time: in a test with three background chats for 90 s, 38 activations took the focus
  from the app being typed in and 35% of the keys were lost. With the rule below: no activation, every key arrived,
  and the agents' clicks and screenshots worked as before. See "Keep pi-gna from taking focus" below.
- **Phone browser screen**: the stream of a pane tab is stretched and taps do not land (the phone maps touches for a
  1280x800 tab while the pane is narrower); with a device preset it fits but looks soft. The stream also pauses while
  the pi-gna window is minimized or on another virtual desktop (it runs while the window is merely covered).
- **Device windows** (`browser_window`) take focus when they open and do not keep their aspect ratio when resized.
  pi-gna cannot restore a minimized window on Wayland (KWin does not let apps un-minimize themselves).
- **Native file dialogs from a page**: if the agent clicks an `<input type=file>`, a modal KDE file dialog opens that
  the agent cannot see or close (on macOS too).
- **MCP servers with an API key** (catalog connections such as Brevo) fail: the token is stored with macOS's
  `/usr/bin/security`, which Linux does not have (nothing is written). Servers you add to `mcp.json` yourself, and OAuth
ones, do not go through it (both untested).
- **Shortcuts built on Cmd**: the menu's shortcuts use Ctrl on Linux, but the window's own ones (new chat, open file,
  file finder, attach, jump to chat N) check Cmd, which is Super on Linux and taken by KWin. Labels still show the
  Mac glyphs and macOS wording ("Show in Finder", "this Mac") in places.
- The attach picker picks files only on Linux (the desktop file chooser cannot take files and folders at once); attach
  folders by drag and drop or @ mention.
- No package, no updater, no `pi --pigna` discovery of an installed app.
- Not tried: dictation, autocomplete, OAuth MCP servers, multi-monitor HiDPI scaling, NVIDIA-free machines, other
  desktops.

## Tests on Linux

`pnpm typecheck` and `pnpm test` pass, except two `src/main/setup.test.ts` cases on distributions that ship `npm` in
`/usr/bin` (the fixtures assume it is not there). `pnpm e2e:remote` passes 16 of 17 scenarios; `mobile-chat` fails one
caret check whose timing differs in the test window. Test instances started with `PIGNA_BACKGROUND=1` set their window
to opacity 0, which does not draw on Wayland, so scripts that need the desktop window to paint
(`scripts/verify-responsive-browser.mjs`) cannot complete there.
