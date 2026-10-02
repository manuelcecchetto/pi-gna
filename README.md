# pi studio

A desktop app for the [pi coding agent](https://pi.dev). pi stays the backend: every chat is a `pi --mode rpc`
process with your own models, extensions, skills and settings, and your sessions are pi's own session files.
pi studio renders the transcript, tool calls and extension dialogs, and adds a browser pane that you and pi share.

macOS only for now.

## Install

1. Install and set up pi: `npm install -g @earendil-works/pi-coding-agent`, then run `pi` once to log in
   ([pi.dev](https://pi.dev)).
2. Download the `.dmg` for your Mac from [Releases](https://github.com/manuelcecchetto/pi-studio/releases)
   (`arm64` for Apple silicon, `x64` for Intel) and drag the app to Applications.
3. Open it. Builds are not notarized (there is no paid Apple developer certificate behind this project), so the
   first time macOS says it cannot verify the app. Open **System Settings > Privacy & Security** and click
   **Open Anyway**, or run:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/pi studio.app"
   ```

Opened from Finder or the Dock, the app reads your login shell's environment, so `pi`, `node` and API keys
from your shell profile work as they do in a terminal. [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
powers `@` file mentions.

### `pi --studio`

To open studio from a terminal in the current project:

```sh
pi install git:github.com/manuelcecchetto/pi-studio   # once: adds the --studio flag to pi
pi --studio
```

That terminal becomes the app's log (main process and every pi child's stderr), and Ctrl-C quits. If studio is
already open, it opens a new chat in that directory instead.

## Use

The browser pane (Cmd+B) is shared by you and pi. pi gets `browser_*` tools for it: local dev servers open
without asking, other sites ask once per session. Use the comment button to click elements and leave notes;
they are attached to your next prompt with a crop of each element.

Logs: Help > Show Logs (`~/Library/Logs/pi studio/main.log`).

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
| Cmd+Shift+S | Show or hide the sidebar (drag its edge to resize) |
| `/` and `@` | Commands, skills and prompt templates / project files |
| Cmd+U, "+", drop, Cmd+V | Attach files and folders (sent by path) or images (sent to the model) |

| Variable | Effect |
|---|---|
| `PI_STUDIO_PI_BIN` | pi executable to spawn (default `pi` on `PATH`) |
| `PI_STUDIO_DEBUG=1` | Log every RPC record |
| `PI_STUDIO_EXCLUDE_TOOLS` | Tools hidden from studio sessions (default `run,snapshot,screenshot`, Stagehand's) |
| `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` | Where sessions are listed from (same as pi) |
| `PI_STUDIO_USER_DATA` | Separate app profile and logs, for test instances |
| `PI_STUDIO_BACKGROUND=1` | Open the window without taking focus, for test instances |
| `PI_STUDIO_DEV=1` | Make `pi --studio` run a source checkout instead of the installed app |

## Build from source

Needs Node 24 and pnpm 10.

```sh
pnpm install
pnpm build && node bin/pi-studio.mjs   # run the checkout, with this terminal as the log
pnpm dev                               # electron-vite with renderer HMR
pnpm test && pnpm typecheck
pnpm dist                              # dist/pi-studio-<version>-<arch>.dmg
```

`pi install ~/path/to/pi-studio` adds `--studio` from a checkout; it runs the installed app when there is one
and the checkout otherwise (`PI_STUDIO_DEV=1` forces the checkout). Releases are built by GitHub Actions when a
`v*` tag is pushed. See [docs/DESIGN.md](docs/DESIGN.md) for the architecture, packaging and pi RPC notes.

## License

[MIT](LICENSE)
