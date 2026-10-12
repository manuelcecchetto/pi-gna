---
name: inline-visuals
description: Craft guide for pi-gna's inline `visual` fences beyond simple charts. Read it before building a dashboard or report (several charts of usage, CI, a release or other metrics), drawing a technical illustration (a cutaway, section or exploded view of an engine, device, circuit or building), an animated flow with kit.player, a UI mock of a product change, or any visual that shows local images. Has the techniques, worked examples and a pre-send checklist.
---

# Inline visuals: dashboards, illustrations, animation, mocks

The always-on visual instructions hold the contract (fragment, kit classes, tokens, when one visual is warranted). This skill is how to make the ambitious ones look finished. Everything here still obeys that contract: one visual (in a dashboard, one per section), after prose that answers alone, no network.

## Dashboards

When the user asks for a dashboard, report or overview, answer as a short report: a sentence or two stating a section's finding, then that section's visual, then the next. Use 2 to 5 sections, each in its own fence: the headline `stats` and the mix first, then change over time, then rhythm or distribution, then health or detail. Separate fences stay well under the 64 KB cap. Say once, in the prose before the first section, what the data covers (source, window, what counts); a caveat for one chart goes in its `hint`.

- Each chart sits in its own `card`, and its `head` states the finding. Put cards side by side in a `grid` with a wider minimum (`style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))"`).
- Build charts in a script from an inline data array into kit classes, so they reflow with the panel and need no resize handler. Use `cols` for values over time (one `<span>` per series, `data-tip` with the total on each column), `cells` for weekday × hour or calendar intensity, `bars` for a ranked list and `split` for one whole.
- Color `cells` with `kit.heat(value / max)` and put a `scale` under the grid. Keep it linear: a square root pushes most cells into the hot end, so the peak no longer stands out. Leave empty cells uncolored.
- For a donut, draw an SVG with `viewBox="0 0 42 42"` and one `<circle r="15.915">` per slice. The circumference is 100, so `stroke-dasharray="share 100-share"` and `stroke-dashoffset="-start"`, rotated -90 to start at the top. Put a `--raised` track under the slices, a `data-tip` on each slice and the values in a list beside it.
- Give each series one color across every section (Opus is `--c1` in the donut and in the columns), and name it once: the first chart's legend names it, later charts reuse the color without another legend.
- Keep labels sparse: the finding title, first and last ticks on an axis, values on hover. The section's prose already says the numbers that matter, so the chart does not print them again.

```visual
<div class="stack">
  <div class="stats">
    <div class="stat"><span class="stat-value">96.5k</span><span class="stat-label">turns, Sep 11 to Oct 10</span></div>
    <div class="stat"><span class="stat-value">1,674</span><span class="stat-label">sessions</span></div>
    <div class="stat"><span class="stat-value">0.48%</span><span class="stat-label">turns that errored</span></div>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
    <div class="card stack">
      <div class="head"><span>Opus does 44% of turns</span></div>
      <div class="row" style="align-items:center;gap:16px">
        <svg viewBox="0 0 42 42" style="width:84px">
          <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--raised)" stroke-width="5"/>
          <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--c1)" stroke-width="5" stroke-dasharray="43.4 56.6" stroke-dashoffset="0" transform="rotate(-90 21 21)" data-tip="Opus · 42,697 turns"/>
          <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--c2)" stroke-width="5" stroke-dasharray="25.8 74.2" stroke-dashoffset="-44.2" transform="rotate(-90 21 21)" data-tip="Astra · 25,642 turns"/>
          <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--c3)" stroke-width="5" stroke-dasharray="28.4 71.6" stroke-dashoffset="-70.8" transform="rotate(-90 21 21)" data-tip="Other models · 28,191 turns"/>
        </svg>
        <div class="legend" style="flex-direction:column"><span style="--c:var(--c1)">Opus 44%</span><span style="--c:var(--c2)">Astra 27%</span><span style="--c:var(--c3)">Other 29%</span></div>
      </div>
    </div>
    <div class="card stack">
      <div class="head"><span>Opus drove the October climb</span></div>
      <div class="cols" id="days" style="--h:110px"></div>
      <div class="row hint" style="justify-content:space-between"><span>Oct 1</span><span>Oct 10</span></div>
    </div>
  </div>
  <div class="card stack">
    <div class="head"><span>Weekdays peak at 11:00</span></div>
    <div class="cells" id="week"></div>
    <span class="scale"><span>Less</span><span>More</span></span>
  </div>
</div>
<script>
  const days = [[320,0,2299],[1985,25,3425],[2165,0,1890],[1729,10,878],[2205,716,3264],[4060,280,954],[6343,40,1055],[7323,0,3247],[6003,0,102],[4544,270,1361]];
  const cols = document.getElementById("days");
  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.dataset.tip = "Oct " + (i + 1) + " · " + kit.fmt(d[0] + d[1] + d[2]) + " turns";
    d.forEach((v, k) => {
      const s = document.createElement("span");
      s.style.setProperty("--v", (v / 11000) * 100 + "%");
      s.style.setProperty("--c", "var(--c" + (k + 1) + ")");
      col.append(s);
    });
    cols.append(col);
  });
  const week = [
    ["Mon", [527,289,127,0,0,0,156,224,149,124,615,412,411,563,400,476,559,1126,1356,768,428,775,280,484]],
    ["Wed", [118,240,67,0,0,0,5,465,558,759,571,1217,856,897,897,603,622,1129,1244,1064,854,1008,1034,986]],
    ["Thu", [383,682,528,357,279,232,253,187,268,983,1731,1740,1456,1080,641,577,1211,910,520,311,1198,832,731,358]],
    ["Sun", [545,352,243,321,164,430,0,173,351,312,448,520,187,317,359,464,280,695,351,239,228,322,393,370]],
  ];
  const grid = document.getElementById("week");
  const label = (text) => Object.assign(document.createElement("span"), { textContent: text });
  grid.append(label(""));
  for (let h = 0; h < 24; h++) grid.append(label(h % 6 ? "" : String(h).padStart(2, "0")));
  for (const [day, hours] of week) {
    grid.append(label(day));
    hours.forEach((v, h) => {
      const cell = document.createElement("div");
      if (v) cell.style.setProperty("--c", kit.heat(v / 1740));
      cell.dataset.tip = day + " " + h + ":00 · " + v + " turns";
      grid.append(cell);
    });
  }
</script>
```

## Local images

`<img src="path">` and, inside an `<svg>`, `<image href="path" x y width height>` show an image file from this machine: absolute or relative to the project; png, jpg, gif, webp, avif or svg; up to 20 MB. pi-gna reads the file and inlines it, so the image does not count toward the 64 KB cap. Write the path literally in the markup: a path set from a script (`img.src = ...`) is not seen. Remote URLs never load.

Use real images the work produced: a screenshot you saved (`browser_screenshot` with `save`), a generated render, a photo in the project. Size them with `width`/`height` or CSS; inside an SVG, place them in the drawing's coordinates. Never use an image for something the SVG can draw (a label, an arrow, a chart).

## Technical illustrations

When the answer explains how a physical or spatial thing is built or works, draw the thing.

- **Form**: a cutaway, section or exploded view, in proportion. Sketch the silhouette first (casing, inlet, nozzle), then interior parts on the centerline, then the base it stands on. A `viewBox` around 720 wide keeps coordinates simple; `style="width:100%"`.
- **Line work**: `stroke="var(--fg)"` at 1 px for edges, `var(--line)` for leaders and secondary edges, `var(--muted)` for repeated parts (blade rows). Cut material is hatched: a `<pattern>` of 45-degree lines in `var(--line)`.
- **Labels**: 11 px text in `var(--muted)` above or below the drawing, each with a straight leader line to its part. Stagger the label rows so they never collide.
- **Color**: literal colors only for what the picture depicts (a flame, coolant, a glow, a hot material), and a gradient may show one (a `radialGradient` from white-yellow to transparent orange for a flame). Everything around the drawing (heads, tabs, readouts) stays on the kit tokens, so it follows the theme.
- **States**: give the thing's operating states controls that change the drawing, not a second drawing. `tabs` in the `head` for discrete settings (IDLE, PART, MIL, AB 1, AB 2), a slider for a continuous one, and a readout of the numbers each state stands for (thrust, nozzle opening). A state table in the script maps each state to its numbers; one `show(state)` function sets attributes (a path's `d`, an `opacity`, a readout's text). Use `kit.player` instead when the motion is the point (a cycle, a sequence).
- **Head**: the title states the finding ("Thrust climbs from 8.1 to 79.3 kN as the nozzle opens"), and the tabs sit on its right.

````
```visual
<div class="stack">
  <div class="head"><span>Thrust climbs from 8.1 to 79.3 kN as the nozzle opens</span><span class="tabs" id="thr"><button>IDLE</button><button class="on">PART</button><button>MIL</button><button>AB 1</button><button>AB 2</button></span></div>
  <svg viewBox="0 0 720 230" style="width:100%">
    <defs>
      <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V5" stroke="var(--line)" stroke-width="1.2"/></pattern>
      <radialGradient id="flame" cx="0.25" cy="0.5" r="0.75"><stop offset="0" stop-color="#fff4c2"/><stop offset="0.35" stop-color="#ff9a3c"/><stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/></radialGradient>
    </defs>
    <g fill="none" stroke="var(--fg)">
      <path d="M40 200H700M180 200V170H200V200M520 200V170H540V200"/>
      <path d="M70 52C90 70 100 90 110 96H520V84H612M70 168C90 150 100 130 110 124H520V136H612"/>
      <path id="petals" d="M612 84L650 90M612 136L650 130"/>
    </g>
    <path d="M140 110C140 104 150 102 160 102H470L520 110L470 118H160C150 118 140 116 140 110Z" fill="url(#hatch)" stroke="var(--fg)"/>
    <ellipse id="burn" cx="590" cy="110" rx="70" ry="18" fill="url(#flame)" opacity="0"/>
    <g font-size="11" fill="var(--muted)"><text x="72" y="36">Inlet</text><text x="320" y="36">Combustor</text><text x="610" y="24">Nozzle petals</text></g>
    <path d="M84 40V62M340 40V96M640 28V88" stroke="var(--line)"/>
  </svg>
  <div class="hint">Load cell <b class="num" id="kn">16.2</b> kN · nozzle <span class="num" id="noz">78</span>%</div>
  <script>
    const states = { "IDLE": [8.1, 62, 0], "PART": [16.2, 78, 0], "MIL": [52.9, 70, 0], "AB 1": [66.0, 88, 0.6], "AB 2": [79.3, 100, 1] };
    const show = (name) => {
      const [kn, noz, burn] = states[name];
      document.getElementById("kn").textContent = kn.toFixed(1);
      document.getElementById("noz").textContent = noz;
      const open = 92 - (noz - 60) / 40 * 12;
      document.getElementById("petals").setAttribute("d", "M612 84L650 " + open + "M612 136L650 " + (220 - open));
      document.getElementById("burn").setAttribute("opacity", burn);
    };
    document.getElementById("thr").addEventListener("tab", (e) => show(e.detail));
    show("PART");
  </script>
</div>
```
````

The full version, with blade rows, a combustor, a turbine, V-gutters and local images, is the `illustration` fixture in pi-gna's `scripts/fake-pi-visuals.mjs`.

## Animated flows

`kit.player(el, [{ name, ms }], draw)` adds a toolbar (pause, restart, speed) and clickable stage chips around `el`'s content and calls `draw(s)` every frame. `s.stage`, `s.p` (0..1 through the current stage) and `s.at(i)` (stage i's progress: 0 before, 1 after) make the drawing a pure function of time, so jumps and restarts just work. `kit.along(path, f)` gives the `{ x, y }` at fraction f along an SVG path, for a moving token.

Draw the whole diagram statically in markup, then let `draw(s)` only set attributes from `s`: the token's position from `kit.along`, each node's `stroke` by state (`var(--accent)` in progress, `var(--bad)` sent back, `var(--ok)` approved, `var(--line)` not reached), a path filling in with `pathLength="1" stroke-dasharray="1"` and `stroke-dashoffset` from 1 to 0, labels such as "round 2 of 3". Give each stage 1 to 4 seconds, put the state colors in a `legend`, and keep the last frame meaningful: it plays once and stays there (reduced motion shows only the last frame). Never use `setInterval` or your own animation loop.

````
```visual
<div class="stack">
  <div class="head"><span>A rejected build goes back to the builder once</span><span class="hint">review loop, 2 rounds</span></div>
  <div id="stage"><svg viewBox="0 0 600 120" style="width:100%">
    <rect id="n0" x="10" y="40" width="140" height="40" rx="8" fill="var(--panel)" stroke="var(--line)"/><text x="80" y="65" text-anchor="middle" font-size="12">Builder</text>
    <rect id="n1" x="450" y="40" width="140" height="40" rx="8" fill="var(--panel)" stroke="var(--line)"/><text x="520" y="65" text-anchor="middle" font-size="12">Reviewer</text>
    <path id="go" d="M150 55H450" stroke="var(--line)" fill="none"/><path id="back" d="M450 70C350 110 250 110 150 70" stroke="var(--line)" fill="none"/>
    <circle id="tok" r="5" fill="var(--accent)"/>
  </svg></div>
  <div class="legend"><span style="--c:var(--accent)">in progress</span><span style="--c:var(--bad)">sent back</span><span style="--c:var(--ok)">approved</span></div>
  <script>
    const $ = (id) => document.getElementById(id);
    kit.player($("stage"), [{ name: "Build", ms: 1500 }, { name: "Rejected", ms: 1500 }, { name: "Approved", ms: 1500 }], (s) => {
      const path = s.stage === 1 ? $("back") : $("go");
      const at = kit.along(path, s.p);
      $("tok").setAttribute("cx", at.x); $("tok").setAttribute("cy", at.y);
      $("n1").setAttribute("stroke", s.stage === 2 && s.p === 1 ? "var(--ok)" : s.stage === 1 ? "var(--bad)" : "var(--line)");
    });
  </script>
</div>
```
````

## UI mocks

When proposing or weighing a change to a user interface, draw each treatment as a mock rather than describing it. A mock pictures the product being changed, not pi-gna: pi-gna's theme is not in it. Inside a `mock` the kit's pieces start from a neutral light look; make it the product's own by setting the product's real values on the `mock`, read from its code (CSS variables, Tailwind config, theme files): `--canvas` (page), `--panel`, `--raised` (menus, popovers), `--sunken` (inputs), `--line`, `--fg`, `--muted`, `--faint`, `--accent`, `--accent-fg` (text on the accent), `--accent-soft`, `--radius`, `--font-sans`, `--font-mono`, and `color-scheme: dark` for a dark product. Literal colors, fonts and a `<style>` scoped under a class on the mock are fine there when the product needs more than the tokens.

- Mock classes: `mock` (a picture of a piece of the product being changed; it drops pi-gna's theme), `field` (on an `<input>`, `<textarea>` or a `<div data-placeholder="...">`), `btn` plus `primary|ghost`, `chip` plus `caret` (pill, e.g. a model picker), `kbd` (key hint), `banner` plus `ok|bad|warn|accent` (notice row; an `end` child holds its actions on the right), `menu` (rows of a title, an optional `hint` under it, an optional `kbd`; `on` highlights one; `<hr>` separates), `anchor` and `popover` plus `up|end` (a panel floating from the `anchor` it sits in, below by default; outside an `anchor` it stays in the flow), `switch` (toggle `<button>`; `on` when set).
- Mock interactions need no script: `data-toggle="id1 id2"` on a button flips those elements' `hidden` (open a `popover` that starts `hidden`, or swap a mock between two states); a click elsewhere in the same `mock`, or Escape, closes an open `popover` that has an id (other mocks keep their state). `data-dismiss` hides its nearest `banner`, `popover`, `menu` or `card` (`data-dismiss="id"` hides that element). A `switch` flips `on` and fires a bubbling `switch` event with the new state in `detail`.

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

## Before you send

- The prose answers alone; the visual sits after it, introduced in one sentence.
- The head's title states the finding, not the chart's name.
- Every number is a real value from the work.
- Text is 11 to 13 px and no label overlaps another or a mark (check staggered leader labels by their coordinates).
- Interactive states all draw something sensible: click through each tab or stage in your head, including the first one shown.
- Image paths are literal in the markup and point at files that exist.
- The fragment is under 64 KB, and has no outer card or border around the whole visual.
- A dashboard: each section's prose states its finding, and a series keeps its color in every section.
- Nothing is labelled twice, and no mark prints a value its tooltip could hold.
