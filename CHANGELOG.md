# Changelog

What changed in each pi-gna release, newest first. Add a line under Unreleased as you go; `pnpm release`
moves those lines under the new version, and they become its GitHub release notes (docs/DESIGN.md, Versioning).

## Unreleased

- The phone app loads faster on a slow connection: pi-gna now sends its scripts and styles compressed (a first load is 206 KB instead of 745 KB, and on a 3G-like link the Projects screen shows in 1.7 s instead of 4.4 s). Each file is compressed once and remembered; images are sent as they are.
- The browser pane costs less: a tab change sends only icon keys instead of every tab's icon to the window and phones (8 tabs: 30 KB per update, now 1.6 KB, and updates that change nothing are not sent), another page of a site reuses its icon, the still shown behind a menu or the palette is a lighter JPEG reused until the page changes (ten quick opens: one capture instead of ten), and phone frames a slow link drops are no longer decoded.
- ATP plans, @ mentions and Resolve cost less in big repositories: a change to a plan re-reads only the folders being watched instead of searching the project and its worktrees again (about 560 ms and three processes per change in an 8,000-file repository, now about 3 ms), the @ menu's file list is kept until a file comes or goes instead of being listed again every 15 s, and a second Resolve of a card reuses its worktree with two quick git calls instead of four.
- Busy boards cost much less: a burst of Kanban changes (an agent filing cards, a drag) is now saved once, 250 ms later and without indentation, and the board is sent to the window and phones at most 20 times a second (20 quick changes to a 1.2 MB board went from about 20 file writes and 240 ms of work to one write and 35 ms).
- Long chats you keep open take much less memory: pi-gna keeps the big tool output and images of a chat's older turns in its session file and reads them back when you scroll up (four 71–115 MB chats went from 341 MB to 133 MB), and a chat you have not looked at for a minute lets go of the earlier turns you scrolled back to.
- The window shows its first screen a little sooner: Settings, Kanban, GitHub, Laments, ATP, the browser pane, the command palette and Setup now load just after it instead of before (the script the window reads at startup went from 852 KB to 558 KB).
- The window opens a little sooner: it no longer waits for the local bridge that pi's tools use to start, which now starts while Electron gets ready (from a checkout, the Dock icon is also set after the window shows: about 140 ms sooner there).
- Long chats open much faster: reading a chat's history no longer slows down with its length (an 11,500-entry chat took 3.6 s before the transcript could show, now under 10 ms).
- Large file writes stream smoothly: the live arguments of a write or edit no longer get slower to update as they grow (100 KB of streamed arguments cost about 490 ms of parsing in each window and phone, now about 20 ms).
- Opening pi-gna from the Dock or Finder shows your chats sooner: the sidebar no longer waits for your login shell's environment (about 2.1 s after launch before, about 0.9 s now; the first launch still waits once to learn pi's folders).
- Streaming answers no longer redraw the sidebar and the rest of the window on every frame: only the chat itself updates, and a chat answering in the background redraws nothing until its mark changes.
- Long answers stream without slowing the window: each frame now renders only the paragraph being written instead of the whole answer again (a 45 KB answer kept the window busy for 10.4 s of its 13 s stream, now 4.5 s), and text you select in an answer stays selected while it streams.
- Opening a long chat starts pi while its history is still being read, so it is ready to prompt sooner (a 115 MB chat was ready in about 1.9 s, now about 1.6 s).
- Opening a chat that is already running (on your phone, or a card's chat from the sidebar) no longer reads its whole session file again: it joins the running chat at once (a 115 MB chat took about 280 ms, now 1 ms).
- Long chats open with their last turns instead of the whole history: the window loads earlier turns as you scroll up, jump on the turn rail or open a bookmark (a 71 MB chat sent 70 MB to the window and kept 81 MB in its memory, now 22 KB and 4 MB, and it shows about a third sooner).
- Fast answers cost the window and your phone less: the text a model streams within a frame now reaches them as one update instead of one per piece (an answer streaming about 160 pieces a second sent 800 updates, now about 260; at 750 a second, 1,500 updates became about 115).
- Chats you leave idle no longer keep a pi process running for the rest of the session: a chat that has been idle for 30 minutes, or that is past the 8 most recently used idle chats, stops its pi and opens again from the sidebar with its transcript and any unsent text. Chats that are running, waiting for an answer, unread, held by ATP or on screen (even with the window in the background) keep theirs. On the phone, Reopen on such a chat now opens it again instead of saying it has ended.
- New chats are ready to prompt at once: pi-gna keeps one pi started for the next New chat in the folder you last opened a chat in (New chat to ready took about 0.7 s, now about 10 ms). It is skipped while your Mac is busy, replaced when pi's settings, your features or your context files change, and stopped after 10 minutes unused.
- The message box no longer redraws on every frame while an answer streams, and no longer measures its own height each time: the window lays out about a third as often while streaming (194 layouts in 2 seconds of a stream, now 68).
- The Kanban board, the ATP page and the browser pane no longer redraw on every frame while a chat streams: they update only when what they show of it changes (a card's mark, the orchestrator's tab, a tab's running icon). With 200 cards on the board, a chat streaming behind it cost about 480 ms of script every 2 seconds, now about 10 ms.
- Typing after @ in a big project keeps up: the file menu narrows the files the last letters matched instead of searching every file again (each key over 50,000 files cost about 30 ms of script, now about 3 ms), and deleting a letter shows the earlier list at once. The ⌘P file finder searches the same way, and in it and in ⌘K what you type shows before the list catches up.
- A command's live output no longer costs more the longer the chat is: each tool's run is now kept with the message that called it, so an update touches that message alone (in a chat with 6,000 tool calls, each update of a running command cost pi-gna about 1.2 ms, now about 1 µs).
- Long agent loops stay light while tools run: an update redraws only the step that changed instead of every tool row (in a 150-call loop, about 46,000 row redraws became 750, and the window's script time fell by about a third).
- A model's thinking streams as plain text and becomes formatted once it ends, instead of being formatted again on every frame (36 KB of streamed thinking cost the window about 470 ms of script, now about 375 ms; the finished thinking looks exactly as before).
- The turn rail no longer redraws its lines or rebuilds the hover card's preview on every frame while an answer streams: the preview is built when you hover (in a chat with 150 messages, the window's script time while an answer streams fell by about a third).
- Following a streaming answer no longer measures the transcript in the middle of each frame: the view now catches up with new output after the frame's own layout, and the chat redraws half as often while it streams (a 300-line answer redrew the transcript about 390 times and forced about 200 layouts, now about 195 redraws and one layout). A window you hide while it streams catches up when it shows again.
- Long chats stay light: turns scrolled out of view are no longer laid out or painted, so opening a chat, resizing the window and streaming an answer touch only what is on screen (with 30 long turns, opening the chat went from about 95 ms to 40 ms, a resize from about 55 ms of layout to 8 ms, and a streamed answer cost about a fifth less). The scrollbar estimates turns you have not scrolled to yet; jumps on the turn rail still land exactly.
- The window rests while you read: the focused message box, the spinners and the "Working" label now animate on the graphics compositor instead of redrawing the page every frame. A focused message box you are not typing in costs nothing (about 35 ms of work a second before), and a chat waiting on a running command about 8 ms a second instead of 65. The message box's border and glow flow while you type and settle at the end of a sweep once you stop; running tool rows keep their spinner without the shimmer; the Kanban page fades in without a blur, and panels over the ATP graph are solid instead of blurring it.
- Live timers tick together: run times, "Working for", tok/s and dialog countdowns share one clock, so a chat waiting on four parallel commands wakes the window once a second instead of seven times, and tok/s stops ticking while nothing streams. On the phone, the browser screen and a chat's globe no longer redraw every second once an agent has used a tab: they update once, when "the agent is using this" fades.
- A running command's output, opened under its tool row, shows its newest lines and follows them like a terminal (it showed the first 400 lines until the command ended), and keeping it up to date costs about half as much: colored output past pi's 50 KB limit took about 165 ms of work a second, now 85.
- Code in a chat highlights as it scrolls into view, in small pieces while the window is idle, instead of all at once when a chat opens or an answer ends (opening a chat with 160 code blocks froze the window for about 3 seconds, now its longest pause is about 60 ms). Code blocks over 30 KB stay plain.
- A chat whose last run went on for hours opens on a phone in under a second instead of about a minute: the phone gets the run's last steps first and the earlier ones as you scroll up, answers to the phone are compressed, and pi's thinking signatures (about a third of a long chat) no longer travel to the phone or the window.
- A chat with many inline visuals runs only the ones near what you are reading: each visual is a process of its own, so a chat with 30 of them used about 1 GB and now uses about 0.37 GB, and it shows its first visual in about 0.2 s instead of 0.9 s. A visual you scroll back to draws again, starting from its first state.
- Chats full of screenshots use less memory: your attached images and tool screenshots now show as small thumbnails made once, instead of full-size images kept twice (a chat with 98 Computer Use screenshots settled at about 520 MB instead of 610 once scrolled through; the lightbox still opens the full image). In the window, an image not yet scrolled to holds its exact place instead of growing when it loads.
- pi-gna lists your chats sooner after a relaunch: it keeps the chat list's summaries on disk and reads only the session files that changed since, instead of every chat's first lines (941 chats took about 600 ms each launch, now about 17 ms). A chat whose first message carried a large image no longer goes missing from the list.
- A finished run updates the chat lists without rereading every chat: the Mac re-reads only that chat's session file and sends its row to the window and the phones (each run used to list the whole sessions folder twice, about 1,900 files read for their size and date; now one).

## 0.9.1 - 2026-10-08

- Inline visuals can animate: agents can draw a flow that plays through its stages (work handed off, sent back, built in parallel) with Pause, Restart, speed and clickable stage chips. It plays once and stops on its last frame; with reduced motion it opens on the last frame. The visual prompt no longer sets a size budget beyond the 64 KB cap.

## 0.9.0 - 2026-10-08

- Laments: Mark resolved, Reopen and Delete take effect at once instead of waiting for pi-gna's host, and Fix shows "Starting Fix…" on the lament and its button while the worktree is made, then "Fix started" (a double click starts one chat). A pull request's Review on the GitHub page shows the same starting state.
- ⌘K opens a search over every chat (all projects, newest first before you type), the Kanban board's cards (by title, id or tag), the pages, the Settings sections (by topic too: "theme" finds Appearance), new chats in a project, and app commands with their shortcuts. Pages, settings and commands come before chats that match as well; ↑↓ or ⌃N/⌃P select, ↩ opens, Esc clears the search and then closes. It also works while the browser pane has focus (View > Search…).
- Phone: images a chat's answers embed now show on the phone wherever the file is (a screenshot in /tmp, say), not only inside the chat's folders. Only images the chat's own answers show load; other paths outside its folders are still refused.
- Phone: a chat started anywhere shows up in the Projects and Chats lists right away, instead of only after pi writes its first message to disk. A chat whose first message was only an image is listed as "New chat" instead of never.
- ATP: once you talk to the orchestrator, its chat moves to a side column next to the plan, with the selected node's and workers' chats as tabs; the floating composer stays over the graph while the chat is empty.
- Yolo (Settings > Agent > Approvals, off by default): agents' browser, Computer Use and extension approvals are allowed without asking, in every chat. Nothing is saved as "Always allow", and apps Computer Use never controls stay off-limits. Desktop only.
- Projects: Hide project in a project's right-click menu takes it out of the sidebar and the phone's list (its chats stay on disk). A toggle shows hidden projects to unhide them, and starting a new chat in one brings it back.
- Browser: closing the pane's last tab closes the pane.
- The chat header's browser toggle is a right-panel icon instead of a globe.
- Card links in chat show the card's title instead of its id once the answer is done; the tooltip keeps the full title, column and id.

## 0.8.0 - 2026-10-07

- Screenshots in replies show as galleries, like T3 Code: several images in one paragraph or list item become a row of thumbnails, a table of images becomes a borderless grid with each caption under its image, and raw `<img>` tags of local files work too (with their width and height). Clicking an image opens a lightbox that pages through every image in the answer (chevrons, ←/→ and an n / m counter; swipe on the phone).
- Inline visuals look cleaner, after T3 Code's inline charts: text at the chat's size, big sans headline numbers, thicker rounded bars with bold values, section subtitles next to their titles, and boxes without borders. Visuals now show at their full height instead of being cut off at 720 px behind Show all.

## 0.7.0 - 2026-10-07

- ATP: a new plan's chat runs in its own git worktree of the project, so the plan's workers and commits stay off your checkout.
- Setup opens on the first launch even when pi already has a provider signed in.
- Full-screen photos fit tall images on the screen instead of showing only their top, on the Mac and the phone.
- Composer: + opens the files-and-folders picker directly (it takes images too); the separate Add photos item is gone.
- Windows beta: Node's bundled npm.cmd runs through its CLI (no more spawn EINVAL), npm's global folder joins PATH after installing pi, C:\ projects are accepted, and card worktrees of a C:\ or \\server\share project get a valid path.
- Files (⌘P) is now a folder picker: it opens on the project's top folder, folders first, and you click into folders, go back through the path above the list or Backspace, and search finds folders as well as files inside the folder you are in.
- Windows beta: pi-gna builds an unsigned per-user installer for Windows x64, published by hand as a GitHub prerelease (Actions > Windows beta). pi and npm start through their .cmd shims without a shell; Computer Use and in-app updates stay macOS-only for now. See docs/WINDOWS.md.

## 0.6.9 - 2026-10-07

- Inline visuals can mock UI: when an agent weighs a UI change, it can draw each treatment as a clickable mock in the reply (composer fields, buttons, model chips, banners, menus, popovers that open and close, switches) in the look of the product being changed (its own colors, fonts and corners, read from its code, not pi-gna's theme), so you can compare the options before anything is built.
- Computer Use: the agent cursor now travels along hand-tuned curves instead of a straight 0.2 s slide, and leans into its direction of travel. Pick one of six motions (Signature arc, Spring settle, Magnetic, Comet swoop, Adaptive, Classic; ported from Cua Driver) in Settings > Computer use. Moves are timed by distance and target size, and with Reduce Motion on the cursor still jumps.
- Project wallpapers over about 1.5 MB now show behind a new chat on desktop. The window put the image inline in a CSS variable, which Chromium drops past 2 MiB; it now uses a short blob: URL.
- Computer Use: a chat's preview of the app shows the window the agent last read, instead of the app's largest window (the phone showed a different window than the one being driven).
- Browser: opening a tab's context menu or a dialog keeps a still of the page under it, instead of blanking the pane to the tab's title.

## 0.6.8 - 2026-10-07

- Phone: going back from a file or the browser opened from a chat returns to where you were reading, instead of jumping to the end of the chat.

## 0.6.7 - 2026-10-07

- Phone: text files and images open on the phone itself instead of a laggy, letterboxed stream of the Mac's preview. Markdown renders like a chat message and its links work from the file's folder; code, JSON and text are highlighted with line numbers, wrapped, with the linked line marked; CSV opens as a table, images zoom. Rendered/Raw and Copy are on top. PDF, Office, HTML and media still stream from the Mac. Only files in the chat's folder and project open, as before.
- ATP: a big plan opens readable at the part being worked on (the running node, else a failed or ready one; a finished plan at its outcome) instead of a fitted map of unlabeled blocks; Fit still shows the whole plan. On the phone the minimap sits above the zoom controls instead of covering them.
- ATP: when the orchestrator cannot start, the error stays in the dock in plain words, with Try again and a shortcut to the orchestrator's model setting, instead of a raw toast and no composer.
- Errors explain themselves: the phone says when the Mac's Computer Use helper cannot be reached, the never-allowed apps are listed by name and reason, plugin and provider errors show their commands as code, and a pi that fails to start shows its own error output on the setup screen with Copy the details.
- Laments show their severity as a colored word (Annoying, Costly, Blocking) on each row and report, on the Mac and the phone.
- Card and lament rows, the phone's turn list and notification previews show plain text instead of raw Markdown; card reports render as Markdown.
- With the browser open, the chat keeps at least 400 px instead of being squeezed to a sliver; the browser gives way first, down to 280 px.
- Phone: toasts sit under the header and at most two show; the turn list button moved into the chat header instead of floating over messages; queued messages take one line each; long paths wrap and the board's column tabs fit the screen; Sign out lives in Settings > Remote access only.
- Chats are called chats everywhere: "New chat" instead of "New session".

## 0.6.6 - 2026-10-06

- New icons: pi-gna draws its own set, softer and rounder (2px round strokes, gentle corners), replacing lucide-react everywhere on the Mac and the phone. The sidebar is roomier: 16px icons and 14px labels, and a project's folder opens and closes with it instead of a chevron, with its chats lined up under the name.

## 0.6.5 - 2026-10-06

- New browser tab: + now opens a start tab instead of a blank web page, with the address bar focused, Open file…, a Tools grid, a ⌘P finder over the chat's project files and suggested dev servers. Whatever you pick opens in that tab.
- Settings has an About section: the version, Electron, Chromium and Node versions (with Copy for bug reports), the changelog, source, issue and pi.dev links, license and credits. The app menu's About pi-gna opens it.
- The browser tab strip now scrolls smoothly across the gaps between tabs instead of stalling at each tab's edge.
- Updates: a release published while pi-gna downloads an update, or after one is ready to install, is now downloaded too, so a restart always installs the newest version instead of skipping ahead later. The update that is already ready stays installable until the newer one is ready, and stays ready if the newer download fails.

## 0.6.4 - 2026-10-06

- Phone: chat links open what the Mac would. A file link, a mention or a tool's file path opens the Mac's preview in a tab of that chat, at the phone's size; a card link opens the card; a localhost link opens in the Mac's browser (other web links still open in Safari); images an answer embeds show inline. Only files inside the chat's folder and project open from the phone; others read as plain text.
- Phone browser: a page that is not moving (a file preview, a page that finished loading) now shows; before, it stayed blank until it repainted, and the picture lagged one frame behind. Leaving the Browser screen now closes its stream, so the phone no longer stalls after viewing a few tabs.
- Phone: the browser now opens from a chat's header, not the Projects header. It shows that chat's tabs, as the Mac does, with their count on the globe, which pulses while the agent drives one; "All tabs" shows the rest. A new tab opened there belongs to the chat, and Back returns to it with your comments in the composer.
- Comment on elements in rendered Markdown and HTML previews too (the speech-bubble button in the tab strip). In the comment card, Add (Enter) keeps the comment for your next message as before, and the new Send (⌘Enter) sends it to the chat right away with any other waiting comments, in previews and web pages alike; on the phone the comment sheet has Send now, which sends to the chat you opened the browser from. Comments now tell the agent the file and line on previews, plus the element's size, the viewport and its key styles.

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
