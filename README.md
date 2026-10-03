<p align="center"><img src="resources/icon.png" width="112" alt=""></p>

<h1 align="center">🤌i-gna</h1>

<p align="center">A desktop app for the <a href="https://pi.dev">pi coding agent</a>. Your pi, with a window.</p>

![pi-gna: the sidebar of projects and chats, and a new chat over a painted 🤌 in a dusk sky](docs/screenshot.webp)

**pi-gna** (Italian *pigna*, as in the 🤌 "mano a pigna" gesture) is a frontend, not a fork. Every chat is a
`pi --mode rpc` process running the pi you already have: your models and logins, settings, extensions, skills,
prompt templates and MCP servers, and your sessions are pi's own session files. Start a chat in the terminal,
continue it in pi-gna, and go back. Nothing to migrate, nothing to configure twice.

macOS only for now (Apple silicon and Intel).

## Install

**Let pi do it.** Paste this into pi (or any coding agent):

```text
Install pi-gna for me by following the "For agents" steps in https://github.com/manuelcecchetto/pi-gna
```

**Or by hand:** download `pi-gna-arm64.dmg` (Apple silicon) or `pi-gna-x64.dmg` (Intel) from
[Releases](https://github.com/manuelcecchetto/pi-gna/releases/latest), drag pi-gna to Applications, and run
`pi install git:github.com/manuelcecchetto/pi-gna` for the `pi --pigna` flag. Builds are not notarized (no paid
Apple certificate behind this), so a browser download opens with "Apple could not verify…": click **Open
Anyway** in System Settings > Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/pi-gna.app`.

### For agents

Run these on the user's Mac and report what happened. Stop and tell the user if a step fails.

1. Check prerequisites: `uname -s` must print `Darwin`, and `pi --version` must print 1.0.0 or newer. If pi is
   missing, ask before installing it (`npm install -g @earendil-works/pi-coding-agent`); the user then has to run
   `pi` once and log in to a model provider.
2. Install the app (quit pi-gna first if it is running; this replaces an older copy):

   ```sh
   arch=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
   curl -fL -o /tmp/pi-gna.dmg "https://github.com/manuelcecchetto/pi-gna/releases/latest/download/pi-gna-$arch.dmg"
   hdiutil attach -nobrowse -quiet -mountpoint /tmp/pi-gna-dmg /tmp/pi-gna.dmg
   rm -rf /Applications/pi-gna.app && ditto /tmp/pi-gna-dmg/pi-gna.app /Applications/pi-gna.app
   hdiutil detach -quiet /tmp/pi-gna-dmg && rm /tmp/pi-gna.dmg
   ```

3. Add the `--pigna` flag to pi: `pi install git:github.com/manuelcecchetto/pi-gna`.
4. Tell the user: open pi-gna from Applications, or run `pi --pigna` in a project to open it there with the
   terminal as its log. If `@` file mentions should work, `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep))
   must be installed.

## What you get

- **The transcript, readable.** Markdown with highlighted code, tool calls grouped per run (Ctrl+O expands
  them), diffs from pi's `edit`, thinking in full, and a rail beside the chat to jump between your messages or
  bookmark them.
- **Steer and queue.** Type while pi works to steer the current run, Alt+Enter to queue a follow-up, Esc to pull
  queued messages back and stop.
- **Every project in one place.** The sidebar lists your pi sessions by project, from the terminal too. Pin
  projects; a chat's mark tells you when pi is working, waiting for you, failed, or finished while you were away.
- **A browser you share with pi.** Cmd+B opens a browser pane, and pi gets `browser_*` tools for it: it opens
  your dev server, clicks, types, reads the page and takes screenshots while you watch. Local URLs open without
  asking; other sites ask once per session. Comment on elements to hand pi notes with a crop of each.
- **A Kanban board per project.** Cards are tasks you drag across To do, In progress, In review and Done.
  Add one by describing the task in your own words: a quick Sonnet chat in the background titles it, tags it and
  takes a first look. Right-click a card to have a new chat investigate it, resolve it (in a git worktree, on a
  branch of its own, so your checkout is left alone) or, once it is in review, QA it; or start a chat about it.
  Chats on a card show their mark on it, and pi gets `kanban_*` tools to take a card, move it and report on it.
- **Attachments.** Drop, paste or pick files and folders (sent by path) and images (sent to the model).
- **Right-click anything.** Copy or save images (screenshots pi took, attachments, pages in the browser), copy and
  open links, look up selected text, edit fields, and act on projects, chats and browser tabs.
- **Context at a glance.** A meter shows context use, auto-compaction and cache hits; compaction shows its
  progress.

## Your extensions

pi-gna does not have a plugin system of its own: pi's is the plugin system. Extensions run inside pi exactly as in
the terminal, and their UI calls are drawn natively:

| Extension UI call | In pi-gna |
|---|---|
| `ctx.ui.select`, `confirm`, `input`, `editor` | Approval card above the composer |
| `ctx.ui.notify` | Toast (each startup notice once per app run) |
| `ctx.ui.setWidget` | Panel above the composer |
| `ctx.ui.setTitle` | Chat title |
| `ctx.ui.setEditorText` | Composer text |
| `ctx.ui.setStatus` | Tracked, not shown |
| `custom()`, footer and header, editor components, themes | Not available: pi's RPC mode has no terminal for them |

Porting a TUI-heavy extension usually means a fallback for `ctx.mode !== "tui"` that uses the dialogs above
(see pi's `docs/rpc-extension-ui.md`). Sessions started by pi-gna have `PIGNA_BRIDGE` set in their
environment if an extension wants to know where it runs.

## Keys

| Key | Action |
|---|---|
| Enter / Shift+Enter | Send (steers while pi is working) / newline |
| Alt+Enter | Queue a follow-up while pi is working |
| Esc | Pull queued messages back into the composer and stop the run |
| Ctrl+O | Expand or collapse every tool call |
| ⌥↑ / ⌥↓ | Jump to the previous / next message you sent (the rail left of the chat does the same by click or drag) |
| Cmd+N | New session in the current project |
| Cmd+B | Show or hide the browser |
| Cmd+Shift+K | Show or hide the project's Kanban board |
| Cmd+Shift+S | Show or hide the sidebar (drag its edge to resize) |
| `/` and `@` | Commands, skills and prompt templates / project files |
| Cmd+U, "+", drop, Cmd+V | Attach files and folders (sent by path) or images (sent to the model) |

## Settings

| Variable | Effect |
|---|---|
| `PIGNA_PI_BIN` | pi executable to spawn (default `pi` on `PATH`) |
| `PIGNA_DEBUG=1` | Log every RPC record |
| `PIGNA_EXCLUDE_TOOLS` | Tools hidden from pi-gna sessions (default `run,snapshot,screenshot`, Stagehand's) |
| `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` | Where sessions are listed from (same as pi) |
| `PIGNA_USER_DATA` | Separate app profile and logs, for test instances |
| `PIGNA_BACKGROUND=1` | Open the window without taking focus, for test instances |
| `PIGNA_DEV=1` | Make `pi --pigna` run a source checkout instead of the installed app |

Logs: Help > Show Logs (`~/Library/Logs/pi-gna/main.log`), or the terminal when started with `pi --pigna`.

## Build from source

Needs Node 24 and pnpm 10.

```sh
pnpm install
pnpm build && node bin/pi-gna.mjs   # run the checkout, with this terminal as the log
pnpm dev                            # electron-vite with renderer HMR
pnpm test && pnpm typecheck
pnpm dist                           # dist/pi-gna-<arch>.dmg
pnpm icon                           # rasterize resources/icon.svg into the app icons
```

`pi install ~/path/to/pi-gna` adds `--pigna` from a checkout; it runs the installed app when there is one and the
checkout otherwise (`PIGNA_DEV=1` forces the checkout). Pushing a `v*` tag builds both dmgs and publishes a
GitHub release. [docs/DESIGN.md](docs/DESIGN.md) covers the architecture, packaging and pi RPC notes.

## License

[MIT](LICENSE). The hand in the logo is [Twemoji](https://github.com/jdecked/twemoji)'s 🤌 (© Twitter, Inc. and
other contributors, [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)), mirrored and turned to make the P.
pi-gna is an independent project, not affiliated with pi.
