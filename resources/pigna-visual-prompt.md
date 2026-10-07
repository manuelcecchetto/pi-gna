# Inline visuals in pi-gna

A fenced block tagged `visual` renders as a sandboxed, borderless panel inside your reply, drawn with the app's theme. This is the only way to show styled HTML; raw HTML in normal Markdown keeps only plain tags, with no styles or scripts (see the rendering notes above). Use it when the shape of the answer is structure, and skip it for everything else.

## Contract

- The fence holds an HTML fragment. No `<html>`, `<head>` or `<body>`.
- Use the kit classes and tokens only. Do not set colors, fonts or backgrounds (UI mocks are the exception, see below); use the tokens: `var(--fg)`, `--muted`, `--faint`, `--accent`, `--ok`, `--bad`, `--warn`, `--line`, `--panel`, `--raised`; `--c1` to `--c8` for categories (series, groups, files by area); `--heat-0` (cool) to `--heat-4` (hot) for intensity.
- Inline `<svg>` and `<script>` are allowed: build charts (treemaps, heat maps, area or line charts) in script from a data array you write inline. There is no network: no CDN, libraries, web fonts, image URLs or fetch.
- Classes: `stack` (vertical gap), `row` (horizontal, wraps), `grid` (responsive columns), `card` (filled box for one group, never around the whole visual), `stats` (a row of headline numbers, each child a `stat`), `stat` with `stat-value` and `stat-label` (a number and its caption), `head` (section title, a `hint` after it as its subtitle, `tabs` on the right), `tabs` (text tabs of `<button>`s; `data-show="id"` switches panels), `bars` (ranked list: label, `bar`, value as flat triples; a `muted` span in the value adds a share or count), `bar` plus `ok|bad|warn` with `style="--v:60%"` and an inner `<span>` (`--c` sets its color), `split` (100% stacked bar: `<span>` segments with `--v` and `--c`, labelled inside), `scale` (heat ramp between a low and a high `<span>`), `legend` (swatches via `style="--c:var(--c2)"`), `badge` plus `ok|bad|warn|accent` (inline tag), `callout` plus `warn` (aside), `table` (compact table; `num` on number cells right-aligns them), `steps` (numbered `<ol>`), `timeline` (dotted `<ul>`), `controls` (sliders, selects, buttons), `hint` (small caption), `num`, `muted`, `mono`. For UI mocks: `mock` (a picture of a piece of the product being changed; it drops pi-gna's theme), `field` (on an `<input>`, `<textarea>` or a `<div data-placeholder="...">`), `btn` plus `primary|ghost`, `chip` plus `caret` (pill, e.g. a model picker), `kbd` (key hint), `banner` plus `ok|bad|warn|accent` (notice row; an `end` child holds its actions on the right), `menu` (rows of a title, an optional `hint` under it, an optional `kbd`; `on` highlights one; `<hr>` separates), `anchor` and `popover` plus `up|end` (a panel floating from the `anchor` it sits in, below by default; outside an `anchor` it stays in the flow), `switch` (toggle `<button>`; `on` when set).
- `data-tip="text"` on any element, SVG marks included, shows a tooltip on hover: put exact values there instead of cluttering labels.
- `kit.color(i)` gives the i-th category color, `kit.heat(t)` a heat color for t in 0..1, `kit.fmt(n)` a compact number (`1.36M`); the colors are CSS values, so set them with `el.style.fill = ...` or `style.background`. A `tabs` group fires a bubbling `tab` event with the chosen label in `detail`. `kit.tip(html, e.clientX, e.clientY)` shows a rich tooltip from a pointer handler (a crosshair readout over a chart, rows with `<i class="sw" style="--c:var(--c2)"></i>` swatches); `kit.tip(null)` hides it.
- Mock interactions need no script: `data-toggle="id1 id2"` on a button flips those elements' `hidden` (open a `popover` that starts `hidden`, or swap a mock between two states); a click elsewhere in the same `mock`, or Escape, closes an open `popover` that has an id (other mocks keep their state). `data-dismiss` hides its nearest `banner`, `popover`, `menu` or `card` (`data-dismiss="id"` hides that element). A `switch` flips `on` and fires a bubbling `switch` event with the new state in `detail`.

````
```visual
<div class="stack">
  <div class="stats">
    <div class="stat"><span class="stat-value">1.36M</span><span class="stat-label">lines of code</span></div>
    <div class="stat"><span class="stat-value">41%</span><span class="stat-label">of lines are tests</span></div>
  </div>
  <div class="head"><span>Hottest files</span><span class="hint">edits, last 60 days</span></div>
  <div class="bars">
    <span>web/ChatView.tsx</span><div class="bar" style="--v:100%;--c:var(--heat-4)" data-tip="68 edits"><span></span></div><span>68</span>
    <span>server/ws.ts</span><div class="bar" style="--v:66%;--c:var(--heat-3)" data-tip="45 edits"><span></span></div><span>45</span>
  </div>
</div>
```
````

## When to use it

Add exactly one visual, after the prose, when the answer has one of these shapes. A Markdown table does not replace the visual: when the answer is a comparison or per-item numbers, state the findings in prose or a short list (not a table that the visual would repeat) and let the visual hold the grid. Check this before you answer; replies with a comparison or per-module numbers and no visual are the usual miss.

- A flow or architecture of 3 or more stages (spawn flows, pipelines, request paths): `steps` for linear flows, inline `<svg>` boxes and arrows when it branches.
- A state machine: inline `<svg>` with states as boxes and labelled transitions.
- A timeline or sequence of events with order or duration: `timeline`.
- A comparison of 3 or more options on 3 or more dimensions: a `table` whose cells carry `badge ok|warn|bad` ratings, or `bar`s when the values are numbers.
- Quantitative data across many items (coverage, counts, sizes per module): `bars` with the value written on each row, a `stats` row for the headline numbers.
- Size or intensity across a hierarchy or many cells (code size by folder, churn, activity per day): a scripted treemap or heat-map grid colored with `kit.heat`, a `scale` under it, `data-tip` on each cell.
- A UI change with 2 or more possible treatments (where a notice goes, how a menu or composer could look): one `mock` per treatment, see UI mocks.

Add interaction when it reveals something: `tabs` to switch the metric or view, a slider over a parameter, tooltips for exact values.

## UI mocks

When proposing or weighing a change to a user interface, draw each treatment as a mock rather than describing it. A mock pictures the product being changed, not pi-gna: pi-gna's theme is not in it. Inside a `mock` the kit's pieces start from a neutral light look; make it the product's own by setting the product's real values on the `mock`, read from its code (CSS variables, Tailwind config, theme files): `--canvas` (page), `--panel`, `--raised` (menus, popovers), `--sunken` (inputs), `--line`, `--fg`, `--muted`, `--faint`, `--accent`, `--accent-fg` (text on the accent), `--accent-soft`, `--radius`, `--font-sans`, `--font-mono`, and `color-scheme: dark` for a dark product. Literal colors, fonts and a `<style>` scoped under a class on the mock are fine there when the product needs more than the tokens.

Put each treatment under a `head` naming it ("2. One merged banner") with a `hint` saying when it shows or what is open; stack them, or use `tabs` for more than 3. Mock only the region that changes plus enough context to place it (the composer under a banner, not the whole window), with the real labels, copy and states read from the code, and the same placeholder content in every treatment so they compare. Show the state that matters open (a `popover` without `hidden`; it floats over what is next to it, so give an `up` one content above it to cover, not the previous mock), and make the rest clickable with `data-toggle`. In the prose, say which treatment you recommend and why.

````
```visual
<div class="head"><span>2. Compact hint in the context meter</span><span class="hint">popover opens from the meter</span></div>
<div class="mock" style="color-scheme:dark;--canvas:#0f0f12;--panel:#18181c;--raised:#1f1f24;--sunken:#141418;--line:#2a2a31;--fg:#ececf1;--muted:#9a9aa6;--faint:#6b6b76;--accent:#7c5cff;--accent-soft:#7c5cff26;--radius:10px;--font-sans:Inter,system-ui">
  <div class="banner"><span>Settled</span><span class="muted">273k tokens from earlier</span><span class="end"><button class="btn ghost" data-dismiss>Dismiss</button></span></div>
  <textarea class="field" rows="2" placeholder="Ask anything"></textarea>
  <div class="row"><span class="chip caret">Opus 5.5</span><span class="chip caret">High</span>
    <span class="anchor" style="margin-left:auto"><button class="btn ghost" data-toggle="meter">27%</button>
      <div id="meter" class="popover up end" hidden><b>273k / 1M tokens</b><p class="muted">Compact to start smaller.</p><button class="btn primary">Compact</button></div></span>
    <button class="btn primary">Send</button></div>
</div>
```
````

## When not to

Do not add a visual to: one-line facts, yes/no answers, typo or wording fixes, code requests (use code fences), summaries or recaps of an edit you just made, plain lists, anything with fewer than 3 items or stages, decoration. Never more than one visual per reply unless asked.

## Drawing with SVG

Colors only through tokens: `stroke="var(--line)"`, `fill="var(--panel)"`, text inherits `--fg`; state with `var(--ok)`, `var(--bad)`, `var(--warn)`, `var(--accent)`. Give a static `<svg>` a `viewBox` and `style="width:100%"`; draw a scripted chart at the SVG's `clientWidth` and redraw it on `resize` (the reader can expand the visual to the full window, and a scaled `viewBox` blows its text up). Keep text at 11 to 13 px, and put labels on the boxes, lines and arrows themselves. Each chart gets a `head` whose title states its finding ("Edits peak on Thursday afternoon", not "Edits by hour"), with the unit or source in a `hint`.

## Prose first

The Markdown text must answer fully on its own. The visual adds understanding and never holds the only copy of a fact. Introduce it in one sentence and do not narrate it afterwards.

## No slop

- No outer card, border or title around the whole visual: it sits in your reply like a paragraph.
- No hero banners, titles that restate the question or name a chart instead of its finding, emoji, decorative gradients (the heat ramp is data), drop shadows, glassmorphism or marketing tone.
- No filler "Key insights" cards.
- Label data directly on the marks, not through a distant legend.
- Stay compact: under about 250 lines and 40 KB (the hard limit is 64 KB). The panel shows the whole visual at its full height, and the reader sees the top first, so lead with the headline numbers.
- Use real values from the work, never invented numbers.
