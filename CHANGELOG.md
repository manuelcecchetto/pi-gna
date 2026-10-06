# Changelog

What changed in each pi-gna release, newest first. Add a line under Unreleased as you go; `pnpm release`
moves those lines under the new version, and they become its GitHub release notes (docs/DESIGN.md, Versioning).

## Unreleased

## 0.6.3 - 2026-10-06

- Ten curated light/dark theme presets, selectable per project or globally and through `set_theme`. pi-gna Original remains the unchanged default; switching palettes preserves wallpapers and logos.

- Project themes: choose separate light/dark colors, installed fonts and text size in Settings > Appearance, with project-local images replacing the wallpaper and a project logo. Ask an agent to change any project theme field with `set_theme` (partial patches, null resets). Themes follow the active project on desktop and phone; inline HTML visuals inherit the same colors and fonts live.

## 0.6.2 - 2026-10-06

- Inline visuals look and work more like T3 Code's in-thread visualizations: no box around them, actions on hover, Expand to the full window (Esc closes), and taller visuals (720 px before Show all). Agents get a richer kit that follows your theme: headline stats, text tabs, ranked bars, stacked split bars, a heat scale, tooltips, a category palette and helpers for scripted charts such as treemaps and heat maps. While a visual streams, a skeleton shows instead of text. The visual instructions now reach the agent beside your AGENTS.md files, only in pi-gna chats while the setting is on. Fixed: a visual whose script declared top-level `const`s failed with "already declared".

## 0.6.1 - 2026-10-06

- Web links in chats show the site's icon at their left (a globe until it loads, so text never shifts); localhost and private addresses are never looked up. Browser tabs show the page's own favicon, on the Mac and in the phone's tab list.
- A chat can work on several Kanban cards: `kanban_claim` no longer takes the chat off its other cards, `kanban_update` takes an optional card (required only when the chat is on several) and a `leave` flag, and the chat header shows the latest card plus "+N".
- Sidebar: a project's chat list now shows 10 more at a time behind "Show more", with "Show less" beside it once expanded, instead of revealing every chat at once.
- Phone: back and the iOS swipe from a freshly launched new chat now go to the project's chat list, then to Projects.

## 0.6.0 - 2026-10-06

- Setup: a guided first run that opens by itself when pi is missing, or on first launch when no provider is signed in. Choose the nerd or the cool pigna (technical or plain wording), let Setup check Node, npm, pi and its SDK and install pi with npm while it shows the output, sign in to a provider, then pick plugins and MCP servers. To open it again, go to Settings > General > Run setup. If you close Setup while pi is installing, the install keeps running. Known gap: with Node.js from the nodejs.org installer, the global npm install can fail with EACCES; Setup shows the error but cannot fix it for you.
- Card IDs in chats are links: click one to open the card as a tab beside the chat. Investigate, Resolve and QA in that tab run in the current chat; "On another chat" starts a new one as before.
- Phone notifications now show the chat's title, and a finished run's notification shows the start of pi's reply (up to 140 characters). Pushes stay end-to-end encrypted, but this text can appear on the lock screen.
- Phone: the Home Screen app opens an empty new chat in the last project you used. Tap the project name to switch projects. The chat list now refreshes when chats start or finish.
- The DMG installer window now has a pigna-hand "drag me to Applications" background.

## 0.5.4 - 2026-10-06

- The iPhone's empty chat state now shows the wallpaper chosen on the Mac, and follows it when you change it.

## 0.5.3 - 2026-10-05

- Notifications on the iPhone now arrive: the host signed pushes with a contact address Apple's push service rejected (403 BadJwtToken), so none were ever delivered.
- ATP workers and other model-configured tasks no longer silently run on your default model when selection fails. Explicit provider selections are exact, rejected or unconfirmed model switches prevent the task prompt, and new orchestrators are not exposed until model setup succeeds.

## 0.5.2 - 2026-10-05

- Images in pi's answers: pi can embed a local image with `![caption](path)` and it renders inline; click it to view it full screen. The images pi's tools gathered no longer stack above the answer; they stay on their tool rows in "Worked for". `browser_screenshot` can save its screenshot to a file (`save`) so pi can show it.
- File preview in the browser pane: click a file link in pi's answer or a path in a tool call, type a path in the address bar, use Open file... or drop a file on the pane, and it opens as a browser tab. PDF (pdf.js, with pi-gna's own page, zoom and find controls), images, Word `.docx`, PowerPoint `.pptx`, Excel `.xlsx`, Markdown, HTML, code, JSON, CSV, audio and video preview in place (Rendered/Raw where it applies, reloads when the file changes); other files get an info card. Office files are drawn on canvas like Word, PowerPoint and Excel lay them out (BetterOffice): a long contract shows its first page in about a second while the rest is laid out, and opening a file that is already open just shows its tab. pi can open files too with `browser_open` and a path. File contents are served on a private `pigna-file://` scheme that web pages in other tabs cannot read.
- The browser is per chat: each chat has its own tabs, and the browser pane hides when you switch to a chat or page that has none.
- Resumed chats show the model they are actually running in the model picker.
- Long unbroken lines in chat messages wrap instead of scrolling the whole transcript sideways.
- Computer Use overlay: a glowing yellow pigna pointer and a glowing frame in pi's colors.
- Kanban: Investigate, Resolve and QA show on the card, its menu and its details while their chat is starting, then that it started. Clicking again while it starts (a double click) no longer starts a second chat, on the Mac and on the phone.

## 0.5.1 - 2026-10-05

- Settings > Remote access: Tailscale's status no longer fails with an "is not valid JSON" error when pi-gna is opened from the Dock or Finder and uses the Tailscale app's own CLI; a Tailscale answer that is not JSON now shows what Tailscale said.

## 0.5.0 - 2026-10-05

- iPhone remote access (off by default): use pi-gna from Safari or the Home Screen over Tailscale (`tailscale serve`, HTTPS, your tailnet only), with the same chats, approvals, board, laments, GitHub, ATP, browser and settings. Agents, repositories, the browser and Computer Use stay on the Mac. Pair each phone with a one-time code the Mac approves. The Mac must be awake and online (idle sleep can be prevented, a closed lid cannot). Setup: README, iPhone remote access.
- Phone notifications (off by default, Settings > Remote access on the Home Screen app): a push when pi needs an approval, a run finishes or fails, a plan stops or finishes, or pi-gna quits. Pushes carry no chat text, are skipped while you are viewing the chat, can be switched off per kind, and are removed when you revoke the phone. They only arrive while the Mac is awake and online.
- Phone: while pi drives a Mac app with Computer Use, the chat shows a view-only preview of it; approvals and Stop work from the phone as on the Mac.
- Settings > Remote access (off by default): while on, closing the window hides it and pi-gna keeps running, Quit asks first when chats are running, and the Mac can be kept from idle-sleeping (never while the lid is closed on battery). Also: open at login. Serve it on your tailnet with one click (never Funnel), pair phones with a one-time code and a QR, and revoke them.
- Phone: the Browser screen (globe on the Projects header): the Mac's browser tabs with agent and window badges and their viewport, an address bar with history suggestions, back/forward/reload, viewport presets, the live page as a stream you tap, drag to scroll and pinch to zoom, a text field and keys for the focused element, and comment mode: tap an element, write a comment, and it goes with your next message from the phone. Works with the Mac's window hidden.
- Phone: the ATP page: switch plans with progress, nodes grouped by status (with the instruction, context, report and chats of each), a graph you pan and pinch, Start, Stop, Resume and Lift from the phone, the orchestrator as a full chat, and New plan with the Macro or Micro architect.
- Phone: the Kanban board: columns with counts, a project switcher, card rows with tags, GitHub badges, attachment and chat marks, moves from a sheet or by long-press drag, a card page (title, Markdown notes, tags, GitHub links, reports, chats, screenshots; edits that conflict with the Mac are refused and refreshed), new cards with photos, and Investigate, Resolve, QA and Chat about it from a card.
- Phone: the Laments page: Open and Resolved tabs worst first, reports as Markdown with links to the chats that filed them and their Fix chats, and Fix, Mark resolved, Reopen and Delete (after a confirmation) from an actions sheet.
- Phone: the GitHub page: issues and pull requests (Open/Closed), the account chooser and Refresh, expanded descriptions, Open on GitHub in the phone's browser, Copy link, Review a PR in a new chat on the Mac, New card from it and Link to card. Tokens stay on the Mac.
- Phone: projects and chats like the sidebar: search, pins, attention marks, long-press menu (open, add to or show on the board, close chat, copy path), new chat, and a folder browser to open any folder on the Mac.
- Phone: Settings like the Mac's (except Shortcuts): general, appearance, models, agent and Beta, features, Computer use (allowed apps, permission status), remote devices with revoke, and updates with Download. Changes show live on the Mac.
- Phone: sign in to model providers from Settings > Providers: API keys typed on the phone are saved by pi on the Mac and never sent back; device-code and paste-a-code sign-ins work on the phone, and sign-ins that only finish in the Mac's browser say so.
- Phone: attach photos (library or camera), files and files or folders on the Mac to a message. Uploads are kept on the Mac for 30 days.
- Phone: tool calls open in a sheet (diffs scroll sideways, bash output keeps its colors, copy command or output), Expand all, images open in a zoomable viewer (long-press to save or copy), a turn list with bookmarks replaces the Mac's hover rail, tap a message for its time, and inline visuals draw on tap in a sandboxed frame.
- ATP page: new plans are written to `docs/plans/draft/` instead of the project root.
- Settings > Plugins: connect apps over MCP (Attio, Notion, Granola, Intercom, Brevo) and install reviewed pi packages from a catalog, sign in to a connection in the browser (a Brevo token is kept in the Keychain), see each connection's status, and turn installed packages and each of their extensions, skills and prompts on or off, for you or for the current project, plus pi's built-in extensions. Everything is written to pi's own `settings.json` and `mcp.json`, so pi in the terminal sees the same and new chats load it. Mac only.
- The window opens where you left it (size, position and zoom); the first launch, or one after the display it was on is gone, fills the screen's work area instead of a centered 1320×880 window.
- The title bar stays level with the traffic lights at every zoom (⌘+/⌘−): the sidebar header and the pane headers keep their height and the lights' space instead of drifting against them.
- Browser: a page in a responsive viewport no longer leaves a blank white strip below it after navigating.
- Chats (most visibly on the iPhone): the transcript keeps following a streaming answer when you are at the end, including after iOS's bounce at the bottom; the ↓ button shows exactly when it stops following.
- ATP page: a plan the architect writes into a folder it just created shows up right away.

## 0.4.5 - 2026-10-04

- Inline visuals (beta, off by default): turn on Settings > Agent > Beta > Inline visuals, and pi can add a small diagram,
  comparison or timeline to a reply, drawn in a sandboxed offline frame styled like pi-gna. Applies to chats you open afterwards.
- GitHub page: Review on a pull request opens a new chat that reviews it with pi-gna's bundled pr-review skill,
  without touching your checkout; findings stay in the chat unless you ask it to post them. Chats opened while
  GitHub is on can use the skill too ("review PR #12").
- The chat header drops its close button (right-click the chat in the sidebar to close it), and expand-all uses a
  list icon with a clearer tooltip.
- The tok/s readout counts only text and thinking: tool calls, whose arguments often arrive in one burst, no longer
  push it to ~300 tok/s.

## 0.4.4 - 2026-10-04

- Browser tools run in the order the agent calls them: a `browser_screenshot` sent together with `browser_open` or
  `browser_viewport` no longer captures the previous page. `browser_evaluate` accepts top-level `await`, and
  `browser_screenshot` takes a `tab` like the other tools.

## 0.4.3 - 2026-10-04

- No more "pi-gna wants to use pi-gna Safe Storage" keychain prompt: the browser pane's cookies no longer
  use a keychain key. Sites you were logged into in the browser pane ask you to log in once more.

## 0.4.2 - 2026-10-04

- Computer Use: Request for Screen Recording opens the System Settings pane and shows the helper in Finder to add,
  since macOS does not prompt for it (the button did nothing).

## 0.4.1 - 2026-10-04

- Computer Use keeps its Accessibility and Screen Recording permissions across updates: the helper is now signed
  with a stable certificate instead of a per-build signature. Updating to this release asks for both one last time.

## 0.4.0 - 2026-10-04

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
- Stopping takes two Escs: the first arms the stop button (it reads "esc" for a moment), the second stops the run
  and pulls queued messages back, so a stray Esc no longer aborts. The running composer's toolbar stays on one line.
- The ATP graph canvas no longer has a dot grid.
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
