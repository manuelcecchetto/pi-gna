# Performance sweep (2026-10-08): P01–P42

One chat implements every card of the performance sweep (Kanban cards P01–P42, coordination card P00 `fi02kg`),
one after another, on branch `pigna/perf-sweep` in the checkout. **Every card gets done.** There are no questions to
the user and no skipping: the decisions below are final, chosen for the best performance. Where something is still
open, pick the option that performs best without breaking behaviour, note it on the card and keep going. If the
card's suggested approach does not deliver once measured, find another one that reaches the card's outcome.

## Read first

- Card P00 (`fi02kg`): conflict map, hot files, baseline numbers. Card ids are on P00 and in `kanban_list`
  (column todo); titles start with `Pxx ·`.
- Before starting a card, read it in full (`kanban_list` with its id): problem, evidence, file:line references,
  fix, "Done when".
- docs/DESIGN.md: the sections a card touches, and the test-instance rules near the end.

## Setup (done once)

- Branch `pigna/perf-sweep` from `main` (20f9605) in /Users/manuelcecchetto/Code/personal/pi-gna. Leave the
  untracked `.pi/` alone.
- First card commit: `git cherry-pick 4b5f752` (P31, already done and tested), then P31 to in_review with its sha.
- Old drafts from the stopped parallel chats: `~/.pi-gna/worktrees/<card id>/Users/manuelcecchetto/Code/personal/pi-gna`
  (`git -C <path> diff`). Reference only: two chats sometimes wrote the same worktree, so re-verify anything taken
  from them. Never modify, commit in or delete those worktrees or their branches. The P05 draft (incremental scanner
  in partial-json.ts, throttle in session-state.ts) is a good start.

## For each card

1. `kanban_claim` the card (column in_progress).
2. Read the card and the code. Measure "before" wherever the card states a number.
3. Make the smallest coherent change, in the style of the surrounding code. Add or adjust tests.
4. Verify: `pnpm typecheck`, `pnpm vitest run <touched tests>`; the full `pnpm test` before committing anything
   under src/shared or src/main. Measure "after".
5. One commit per card: `perf(Pxx): <card title>`, with its tests, docs and a CHANGELOG line under Unreleased when
   user-visible.
6. `kanban_update` (pass `card`): in_review, with what changed, the sha, before/after numbers, verification
   commands and results.
7. Compact context (`compact_context`): card done, sha, numbers, next card.

## Order

Respects the dependencies on P00, biggest wins first.

1. P31 → P01 → P05 → P02 → P04 → P03
2. P19 → P20 → P06 → P07 → P29 → P08
3. P09 → P13 → P41 → P15 → P10 → P11
4. P12 → P14 → P21 → P16 → P17 → P18 → P22 → P23 → P24
5. P25 → P26 → P28 → P27 → P30
6. P32 → P33 → P34 → P35 → P36 → P37 → P38 → P42 → P39 → P40

## Decisions (final)

- **P04:** one selector helper in lib/store.ts, `useStoreShallow(store, selector)`; P09, P13 and P41 reuse it.
- **P02:** remove `await env()` from handlers that only read files; keep it wherever a process is spawned. Never
  cache the shell environment to disk (it holds API keys).
- **P05:** scanner state per streaming block; parse on every delta while the arguments are ≤ 8 KB, then at most
  every 100 ms; `toolcall_end` replaces the arguments with the final ones.
- **P06:** the desktop opens a chat as the phone does: `{handle, seq}` plus the paged snapshot (SNAPSHOT_TURNS);
  earlier turns are paged from the host; rail jumps, bookmarks and "Show earlier turns" page in what is missing.
- **P07:** coalesce each chat's events over 16 ms, merging consecutive deltas of the same contentIndex; flush at
  once on any other event. Stringify each event once; the image replacer runs only on events with image blocks.
  Attention compared field by field.
- **P15:** tool runs move onto the assistant item. The snapshot shape changes for desktop and phone together (one
  build; the phone's build-id check reloads an outdated app). Documented in DESIGN.md.
- **P29:** a once-a-minute check in SessionHost. Idle: ready, not running or compacting, no dialogs, not unread, no
  holds, no client showing it. Stop after 30 min idle; cap idle live chats at 8 (least recently used stops first).
  No setting. A `shown` presence, separate from window focus, so a chat any client has on screen is never stopped
  (unread keeps using focus). Running, waiting, unread and ATP-held chats are never stopped (a test each). Reopen
  through the existing openSession path. DESIGN.md: replace "a chat you prompted stays alive" with this policy.
- **P08:** one spare pi in total, for the project of the most recently opened chat; spawned 2 s after a chat is
  ready, only when the 1-minute load average is below the CPU count and P29's cap (which counts the spare) has room.
  Only a plain New chat (no sessionPath, no atp) with matching cwd, trust and feature fingerprint adopts it; the
  records it emitted while starting are buffered and replayed on adoption. Retired on any settings or features
  change, after 10 min unused, at the load or cap limit, and on quit. Logged as `spare+`, `adopted`, `spare-` with
  the reason. No setting; no switch_session reuse.
- **P30:** the renderer keeps only loaded pages; a chat off screen for 60 s drops back to its latest page. Main keeps
  full items for the last 8 user turns; older turns lose tool-result payloads over 32 KB and all image data, re-read
  from the session file (a scan) when a client pages back, with the last restored page cached. chat-tasks, the push
  preview and runOutcome keep working (tests).
- **P31:** 128 MB cap.
- **P16:** keep the look; animate transform or opacity of pseudo-elements instead of background-position under blur;
  one shimmer (the Working header); page-enter opacity only; solid fills instead of large backdrop blurs on ATP
  panels.
- **P22:** 30 KB per-block highlight limit; highlight blocks near the viewport, one per idle callback.
- **P25:** cache persisted to `userData/session-index.json` (path, mtime, size → summary), missing files pruned.
- **P26:** when a run settles, main re-summarizes that chat's session file and publishes an index upsert on the
  global topic; the renderer and the phone patch their lists. Full rescan only at startup, on window focus and on
  manual refresh.
- **P32:** writes debounced 250 ms (flushed on quit), no indentation; the whole board still published, at most once
  per 50 ms.
- **P34:** stills at JPEG 75, cached until navigation, repaint or layout change; screencast frames gated before
  decoding; favicons by key; browser state published only when changed.
- **P35:** brotli and gzip computed once per file and memoized; Accept-Encoding honored, `Vary` added; images never
  compressed.
- **P36:** precache only the app shell; hashed `/assets/*` cached at runtime, cache-first; wallpaper labels split
  from the full-size image glob so the phone build carries only thumbnails.
- **P39:** convert the preview fonts to woff2 at build time (a build-time devDependency or a tool already on the
  machine is fine; nothing ships at runtime) and keep editor chunks off the read-only path.
- **P42:** vendor chunk; build targets: Electron 44's Chromium for the renderer, mobile per docs/REMOTE_IOS.md
  (es2022 if it does not say). cpp highlighting stays, lazily loaded.
- **Everything else:** as its card describes.

## Guardrails

- Never push, merge into main, tag or release. The branch stays local; the user ships it.
- Never edit `.atp.json` files. Run only formatters the repo configures.
- Test instances per DESIGN.md: their own `PIGNA_USER_DATA`, a debugging port checked free, `PIGNA_BACKGROUND=1`;
  stop them by PID only, never pkill or killall (the user runs pi-gna, and this chat runs inside it). Streaming
  checks use `PIGNA_PI_BIN=scripts/fake-pi.mjs`.
- The phone shares renderer code: after cards touching Transcript, Markdown, lib/store, fuzzy, highlight,
  TokenRate, ContextMeter or Dialogs, run `pnpm e2e:remote`, at least at the end of each order group.
- Benchmarks: /tmp/pigna-bench (bench.ts, pj.ts, spread.mjs), bundled with
  `node_modules/.pnpm/@esbuild+darwin-arm64*/node_modules/@esbuild/darwin-arm64/bin/esbuild`; recreate them if /tmp
  was cleared. Real sessions in ~/.pi/agent/sessions are read only.

## Finish

1. `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm e2e:remote`, `pnpm verify:preview`, `pnpm verify:responsive`.
2. `node scripts/measure-startup.mjs` (median of 7) against P00's baseline. Fix regressions.
3. Final report on P00 (`fi02kg`): each card's sha and before/after numbers, and the commands that passed.
4. P00 to in_review.
