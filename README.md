# pi studio

A desktop UI for the [pi coding agent](https://pi.dev). pi stays the backend: every session is a
`pi --mode rpc` child process with your own models, extensions, skills and settings. pi studio renders the
transcript, tool calls and extension dialogs, and the terminal you launch it from keeps the logs.

## Run

```sh
pnpm install
pnpm build
node bin/pi-studio.mjs        # or `pnpm link --global` once, then `pi-studio` inside any project
```

New sessions start in the directory you launch from. Ctrl-C in the terminal quits and stops every pi process.

| Variable | Effect |
|---|---|
| `PI_STUDIO_DEBUG=1` | Log every RPC record in the terminal |
| `PI_STUDIO_PI_BIN` | pi executable to spawn (default `pi` on `PATH`) |
| `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR` | Where sessions are listed from (same as pi) |

## Keys

| Key | Action |
|---|---|
| Enter / Shift+Enter | Send (steers while pi is working) / newline |
| Alt+Enter | Queue a follow-up while pi is working |
| Esc | Pull queued messages back into the composer and stop the run |
| Ctrl+O | Expand or collapse every tool call |
| Cmd+N | New session in the current project |
| `/` and `@` | Commands, skills and prompt templates / project files |

## Develop

```sh
pnpm test        # vitest: JSONL framing, session files, transcript reducer and view model
pnpm typecheck
pnpm dev         # electron-vite with renderer HMR
```

See [docs/DESIGN.md](docs/DESIGN.md) for the architecture, pi RPC notes and milestones.
