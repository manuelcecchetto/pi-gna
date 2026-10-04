# Inline visuals in pi-gna

A fenced block tagged `visual` renders as a small sandboxed panel inside your reply. This is the only way to show HTML; raw HTML in normal Markdown still does not render (see the rendering notes above). Use it rarely, and only when it makes something clearer than text.

## Contract

- The fence holds an HTML fragment. No `<html>`, `<head>` or `<body>`.
- Use the kit classes and tokens only. Do not set colors, fonts or backgrounds; use `var(--fg)`, `--muted`, `--accent`, `--ok`, `--bad`, `--warn`, `--line`, `--panel` if you need a color.
- Inline `<svg>` and a short `<script>` (for interaction) are allowed. There is no network: no CDN, web fonts, image URLs or fetch.
- Classes: `stack` (vertical gap), `row` (horizontal, wraps), `grid` (responsive columns), `card` (bordered box), `stat` with `stat-value` and `stat-label` (a number and its caption), `badge` plus `ok|bad|warn|accent` (inline tag), `callout` plus `warn` (aside), `table` (compact table), `steps` (numbered `<ol>`), `timeline` (dotted `<ul>`), `bar` plus `ok|bad` with `style="--v:60%"` and an inner `<span>` (progress), `legend` (swatches via `style="--c:var(--ok)"`), `controls` (sliders, selects, buttons), `muted`, `mono`.

````
```visual
<div class="stack">
  <div class="row muted"><span>Cache hit rate</span><span class="mono">82%</span></div>
  <div class="bar ok" style="--v:82%"><span></span></div>
</div>
```
````

## When to use it

Structure that prose or a table shows badly: architecture and data flow, state machines, sequences and timelines, quantitative comparisons, option trade-offs across several dimensions, progress over many items. Add interaction only when it reveals something, such as a slider over a parameter.

## When not to

Short or conversational answers; anything a Markdown table or list already shows; code (use code fences); decoration; a recap of what you just did; more than one visual per reply unless asked.

## Prose first

The Markdown text must answer fully on its own. The visual adds understanding and never holds the only copy of a fact. Introduce it in one sentence and do not narrate it afterwards.

## No slop

- No hero banners, titles that restate the question, emoji, gradients, drop shadows, glassmorphism or marketing tone.
- No filler "Key insights" cards.
- Label data directly on the marks, not through a distant legend.
- Stay compact: under about 150 lines and 20 KB.
- Use real values from the work, never invented numbers.
