# Changelog

What changed in each pi-gna release, newest first. Add a line under Unreleased as you go; `pnpm release`
moves those lines under the new version, and they become its GitHub release notes (docs/DESIGN.md, Versioning).

## Unreleased

- Wallpapers: pick the empty state's backdrop in Settings > Appearance, from the sky and six new ones, each a 🤌 in
  another form (a constellation, a Dolomite spire, a pine forest, a shadow on a wall, an ink wash, a fresco), at dusk
  in the dark theme and by day in the light one, or none. Loop shows the next one at each new chat and each launch.
- ATP page: drag to resize the node panel and the orchestrator transcript, and pick the plan from a breadcrumb in
  the header instead of an always-open plans rail.
- Tool calls show how long they have been running, and a small pie fills toward the call's timeout (the timeout
  itself shows on hover until the call nears it).
- The tokens-per-second readout counts only time spent streaming tokens, so waits inside a response (tool runs,
  pauses before the first token) no longer drag it down.
- ATP: the orchestrator floats over the plan's graph instead of a strip under it. Its conversation shows as chat
  bubbles of the last turns (with what it is doing while it works) that fade away once it is quiet, or whole in a
  floating panel, or not at all; the graph fits the plan above the composer.
- Responsive browser fixes: pi's clicks on a phone-sized tab no longer hang its browser tools (they tap), and land on
  the element when the page is scaled to fit. Rotating an iPhone or editing a Pixel no longer turns it into an iPad or
  iPhone, popping a tab out keeps its device, the DPR select's Custom opens its field, and a window's title follows
  its size. A `browser_window` whose page fails to load no longer leaves a window behind.

## 0.3.2 - 2026-10-04

- Fix chats exiting at start ("Cannot find module '../src/shared/viewport'"): 0.3.1 left a file the browser
  extension needs out of the app. A test now checks that the app ships everything its pi extensions import.

## 0.3.1 - 2026-10-04

- Responsive browser: a Dimensions bar in the browser pane (presets, width x height, DPR, rotate, mobile) emulates a
  device with its viewport, pixel ratio, touch and User-Agent together, so server-rendered pages serve the mobile
  version. pi can set it too (`browser_viewport`, shown with a "Set by pi" badge and kept until you reset it) and open
  standalone windows at an exact size, aspect ratio and DPR (`browser_window`, up to 4); pop a tab out into a window
  and return it.
- Computer Use no longer types into the wrong element: when you last clicked, selected in or set a text element,
  `computer_type_text`, `computer_press_key` and `computer_paste` send keys only if the app's keyboard focus is
  confirmed on it, and otherwise fail with nothing sent. Before, text meant for a Word add-in's chat landed in the
  document. Key actions now name the element their keys went to. The helper is version 3, so macOS asks for
  Accessibility and Screen Recording again.

## 0.3.0 - 2026-10-04

- Fix a lament (right-click it, or Fix in its details): a new chat looks for the cause and fixes it in a git worktree,
  on a branch of its own (`pigna/<lament>-fix-…`), and the lament links to that chat and branch. The manual action
  is now Mark resolved, for when the fix is in: no chat runs for it.
- A Settings page (Cmd+, or Settings at the foot of the sidebar), Codex-style: while it is open the sidebar lists
  its sections, with a search. It gathers the theme, the models of the chats pi-gna starts itself (card triage, ATP),
  pi's own settings (default model and thinking, queueing, compaction, retries, images, project trust; they apply to
  new chats) and switches to turn Kanban, Laments, GitHub, ATP and Computer Use off, which also takes their tools
  away from chats. The Computer Use page is now one of its sections.
- Settings > Providers signs you in to pi's model providers as pi's `/login` does: subscription and account logins
  as cards, API keys in a searchable list, each with the provider's logo; sign out or remove a key there too. With
  pi-claude-bridge installed, your Claude plan signs in through Claude Code's own login instead of pi's.
- Hold Cmd to see Cmd+1 to Cmd+9 on the chats in the sidebar (on the sections while in Settings); press one to open it.
- Computer Use (Cmd+Shift+U): pi can see and operate your Mac's native apps in the background through a small helper
  app, with its own cursor, an approval per app and Esc to stop. Off by default; needs Accessibility and Screen
  Recording for the helper. Terminals, pi-gna and system security prompts are never controlled.
- A GitHub page per project (Cmd+Shift+G): its issues and pull requests, open or closed, read with the GitHub CLI
  as the gh account that can see the repository (a work and a personal account each get their own projects; your
  active gh account is never switched). Make a Kanban card from an issue or PR, or link one to a card; cards show
  their links, and their dialog links more by number or URL.
- The composer shows how fast the model writes, in tokens per second: live while a response streams (estimated
  until the provider reports the count), then the last response's speed.
- An ATP page per project (Cmd+Shift+A) for big projects run with ATP plans (`*.atp.json`, github.com/manuelcecchetto/atp):
  create a plan with the bundled macro or micro architect, then Start runs it node by node, each in a fresh hidden
  worker chat that completes, fails or splits its node with the ATP librarian and commits it as `node(<ID>): …`;
  Stop gives the node back. The plan draws as a live graph (300+ nodes, zoomable, running nodes glowing) with each
  node's instruction, report and chats, and an orchestrator chat under it tells you how it is going and can edit or
  extend the plan. ATP is separate from Kanban.

## 0.2.0 - 2026-10-03

- A Kanban board per project (Cmd+Shift+K): cards are tasks you drag across To do, In progress, In review and
  Done. Describe a task to add a card, with screenshots pasted, dropped or picked if you like, and a quick chat
  titles, tags and looks into it. Right-click a card to have a new chat investigate it, resolve it or, once it is
  in review, QA it, or start a chat about it; pi gets `kanban_*` tools to take a card, move it and report on it.
- Resolving a Kanban card runs its chat in a git worktree under `~/.pi-gna/worktrees`, on a branch of its own
  (`pigna/<card>-…`), and leaves your checkout alone; the chat commits there for you to merge.
- Right-click menus everywhere: copy or save images (screenshots pi took, attachments, pages in the browser),
  copy and open links, look up selected text, edit fields, and act on projects, chats and browser tabs.
- A Lamenting board per project (Cmd+Shift+L): pi files a lament with its `lament` tool when a tool or capability it
  needs is missing, unavailable or failing, marked 😒 annoying, 😠 costly or 🤬 blocking, and you resolve it once fixed.
- pi-gna checks GitHub for new releases and installs them: a row at the foot of the sidebar shows the release
  notes and an Update button, and pi-gna > Check for Updates… checks right away.
- The sidebar shows pi-gna's version next to the logo.
- Chats opened from the sidebar no longer flash the empty state while their history loads.
- Text put in a chat's composer no longer comes back when you switch away from the chat and back.
- Run from a checkout, pi-gna shows as pi-gna in the Dock, ⌘Tab and the app menu, not as Electron, and says so
  when the checkout was rebuilt under it, with a button to restart.

## 0.1.0 - 2026-10-03

- First release: a macOS desktop app for the pi coding agent, with chats grouped by project, a transcript
  with tool activity and thinking, a composer with attachments, queued and steering messages, an integrated
  browser that the agent can drive and you can annotate, and `pi --pigna` to open it from a terminal.
