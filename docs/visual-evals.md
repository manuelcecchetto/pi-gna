# Inline visual evals

Checks with real models that agents use `visual` fences when they help and skip them otherwise.

## Run

```bash
node scripts/visual-eval.mjs <label> <provider/model> [thinking] [caseId...]   # runs `pi -p` with resources/pigna-prompt.md + pigna-visual-prompt.md
node scripts/visual-eval-page.mjs <label>                                       # /tmp/vis-eval/<label>/page.html: every visual on the real kit.css
```

Outputs land in `/tmp/vis-eval/<label>/` (one `.md` per case). The script scores mechanically: visual count, fragment KB, and flags for network/resource use, `<style>`, inline color/font styles, hardcoded colors and emoji. Use `claude-bridge/claude-sonnet-5-5` (the plain `anthropic/` provider is out of plan quota here) and `openai-codex/gpt-5.6-sol`, both at `medium`.

## Cases

| Id | Expect | Prompt |
|---|---|---|
| S1 | visual | Explain the session-host spawn flow in this repo |
| S2 | visual | Compare write-through, write-back, cache-aside on four dimensions |
| S3 | visual | Timeline of a failed ATP plan node, from the real ATP code |
| S4 | visual | Test coverage per module from real numbers (`@vitest/coverage-v8` is not installed, so models count tests) |
| S5 | visual | State machine of a chat's lifecycle |
| S6 | visual | Three UI mocks of a context-window hint in the real composer (kit mock classes, `data-toggle`) |
| N1 | none | One-line question (Vite port) |
| N2 | none | Fix a typo |
| N3 | none | `debounce` snippet |
| N4 | none | Yes/no design question (one JSON file or one per key) |
| N5 | none | Changelog summary of an edit just made |

## Rubric results

Automatic columns: visual present where expected, KB, flags. Manual columns (read from the outputs and screenshots): prose stands alone, kit-only styling, no filler, data real.

| Run | Prompt | Should-cases with a sensible visual | Should-not-cases with a visual | Flags | Size |
|---|---|---|---|---|---|
| Sonnet 5.5 | before | 1/5 (S5) | 0/5 | none | 2.9 KB |
| GPT 5.6 sol | before | 2/5 (S3, S5) | 0/5 | none | 1.6 to 7 KB |
| Sonnet 5.5 | after | 5/5 | 0/5 | none | 0.6 to 2.5 KB |
| GPT 5.6 sol | after | 5/5 | 0/5 | none | 0.6 to 7.2 KB |

The "after" Sonnet run is the final full run; the earlier partial runs (after1: 3/5, then S2 and S4 fixed by the second edit) are the tuning steps.

Manual notes (final runs):

- Prose alone: yes in all 20 cases; Sonnet's S2/S4 and GPT's S2/S4 give the findings in text and the visual holds the grid or the bars.
- Kit-only: no `<style>`, no hex or rgb colors, no URLs or scripts. SVGs use `var(--panel|--line|--ok|--warn|--bad|--accent)`; the GPT S5 state machine is 7.2 KB of inline SVG, still under the 20 KB limit.
- Data real: S1/S3/S5 reflect the code the agent read (`piArgs`, `PiProcess`, `get_state`, READY/CLAIMED/FAILED); S4 uses counted test files and tests (Sonnet: tested files per module; GPT: tests per module from the vitest JSON report, with the caption "not line coverage").
- Filler: none seen (no banners, no emoji, no "Key insights").
- Legibility: dark theme screenshots checked (`/tmp/vis-eval/shots`, not in git). The light theme could not be forced in the page file because the kit follows `prefers-color-scheme`; light was verified on the kit in T08 and the eval SVGs use only tokens.

## Failure clusters and tuning

Before: both models under-used visuals. They answered comparisons with Markdown tables and per-module numbers with tables, as the old prompt said to skip a visual when a table "already shows" it.

Changes to `resources/pigna-visual-prompt.md`:

1. "Use it rarely" became a list of shapes that warrant exactly one visual (flows of 3+ stages, state machines, timelines, 3x3+ comparisons, per-item numbers) and a list of cases that do not (one-liners, yes/no, typo fixes, code, recaps of edits).
2. A Markdown table does not replace the visual for those shapes; put findings in prose and let the visual hold the grid, so the two do not duplicate.
3. A short SVG section: colors only through tokens, `viewBox` plus `width:100%`, labels on the marks, no title inside the visual.

Kit CSS was not changed. Known cosmetic issue: `steps` items that wrap onto their own line still show a trailing arrow (seen in S1 for both models).

Residual variance: one model run per case; a different seed may flip a borderline case (S2, S4 were the flaky ones for Sonnet before the second edit).

## UI mocks (S6)

Sonnet 5.5, medium, after the mock vocabulary was added: one 3 to 3.7 KB visual with three treatments of the real composer and a recommendation in prose, no flags. Two runs drove kit changes rather than prompt rules:

1. A first prompt let mocks follow pi-gna's theme. A mock pictures the product being changed, so `.mock` now resets the tokens to a neutral product look and the agent sets the product's values; the second run read them from `src/renderer/src/styles.css` and set them on each mock.
2. Both runs drew popovers shown open, once with `popover up` outside any `anchor`: it floated over the previous treatment, and an outside click in one mock closed another mock's open popover. A `popover` now floats only from an `anchor`, and outside clicks and Escape close popovers only within the same `mock`.
