// Fixtures for fake-pi's FAKE_FIXTURE: replies holding ```visual fences, good and hostile. See docs/DESIGN.md
// ("Verifying inline visuals"). Hostile fragments call out to http://127.0.0.1:$FAKE_HOSTILE_PORT, which must see nothing.
import { readFileSync } from "node:fs";
const fence = (html) => "```visual\n" + html.trim() + "\n```\n\n";
const port = process.env.FAKE_HOSTILE_PORT || "9";
const host = `http://127.0.0.1:${port}`;

const architecture = fence(`
<div class="stack">
  <ol class="steps"><li>Renderer sends prompt</li><li>Main spawns pi</li><li>Events stream back</li></ol>
  <svg viewBox="0 0 300 60" width="100%" height="60"><rect x="4" y="10" width="80" height="40" rx="6" fill="none" stroke="var(--accent)"/><text x="44" y="35" text-anchor="middle" fill="var(--fg)" font-size="12">Renderer</text><path d="M84 30H110" stroke="var(--muted)"/><rect x="110" y="10" width="80" height="40" rx="6" fill="none" stroke="var(--ok)"/><text x="150" y="35" text-anchor="middle" fill="var(--fg)" font-size="12">Main</text><path d="M190 30H216" stroke="var(--muted)"/><rect x="216" y="10" width="80" height="40" rx="6" fill="none" stroke="var(--warn)"/><text x="256" y="35" text-anchor="middle" fill="var(--fg)" font-size="12">pi</text></svg>
</div>`);

const comparison = fence(`
<div class="stack">
  <div class="row muted"><span>Cache hit rate</span><span class="mono">82%</span></div>
  <div class="bar ok" style="--v:82%"><span></span></div>
  <div class="row muted"><span>Error rate</span><span class="mono">12%</span></div>
  <div class="bar bad" style="--v:12%"><span></span></div>
  <table class="table"><tr><th>Option</th><th>Cost</th></tr><tr><td>A</td><td>$1</td></tr><tr><td>B</td><td>$3</td></tr></table>
</div>`);

const slider = fence(`
<div class="stack controls">
  <label>Workers <input id="w" type="range" min="1" max="16" value="4"></label>
  <div class="stat"><span class="stat-value" id="out">4</span><span class="stat-label">workers</span></div>
  <script>document.getElementById("w").addEventListener("input", (e) => { document.getElementById("out").textContent = e.target.value; });</script>
</div>`);

// The richer kit end to end: stats, head + tabs, a scripted treemap colored with kit.heat and data-tip, scale, bars.
const dashboard = fence(`
<div class="stack">
  <div class="stats">
    <div class="stat"><span class="stat-value">96.4k</span><span class="stat-label">lines of code</span></div>
    <div class="stat"><span class="stat-value">412</span><span class="stat-label">files</span></div>
    <div class="stat"><span class="stat-value">38%</span><span class="stat-label">of lines are tests</span></div>
    <div class="stat"><span class="stat-value">1,904</span><span class="stat-label">file edits, last 60 days</span></div>
  </div>
  <div class="head"><span>src</span><div class="row" style="gap:16px"><div class="tabs" id="metric"><button value="churn">Churn</button><button value="size">Size</button></div><div class="tabs"><button data-show="map">Map</button><button data-show="list">List</button></div></div></div>
  <div id="map"><svg id="tm" style="width:100%;height:300px"></svg></div>
  <div id="list" class="bars"></div>
  <div class="row" style="justify-content:space-between"><span class="scale"><span>0</span><span>68 edits</span></span><span class="hint">Hover a box for its numbers.</span></div>
  <div class="head"><span>Hottest files</span></div>
  <div class="bars" id="hot"></div>
  <div class="head"><span>Edits peak on Thursday afternoon</span><span class="scale"><span>fewer</span><span>more</span></span></div>
  <div id="week"></div>
  <div class="head"><span>Where the edits land</span></div>
  <div class="split"><span style="--v:46%;--c:var(--c1)">main 46%</span><span style="--v:38%;--c:var(--c6)">renderer 38%</span><span style="--v:16%;--c:var(--c5)">16%</span></div>
  <table class="table"><tr><th>Area</th><th class="num">Files</th><th class="num">Edits</th></tr><tr><td>main</td><td class="num">142</td><td class="num">876</td></tr><tr><td>renderer</td><td class="num">198</td><td class="num">724</td></tr><tr><td>shared, mobile</td><td class="num">72</td><td class="num">304</td></tr></table>
  <script>
    const files = [["main/session-host.ts",980,68],["renderer/Transcript.tsx",1210,51],["main/index.ts",640,45],["renderer/Sidebar.tsx",820,42],["renderer/Composer.tsx",700,32],["main/remote-server.ts",610,28],["renderer/Settings.tsx",900,24],["shared/settings.ts",300,24],["renderer/Markdown.tsx",260,18],["main/kanban.ts",450,15],["renderer/Kanban.tsx",520,12],["mobile/chat-ui.ts",180,9],["main/visual-frame.ts",90,6],["shared/ipc.ts",240,5],["renderer/lib/markdown.ts",210,4],["main/app-protocol.ts",70,2]];
    const max = Math.max(...files.map((f) => f[2]));
    let metric = "churn";
    function layout(items, x, y, w, h, out) {
      if (items.length === 1) return out.push([items[0], x, y, w, h]);
      const total = items.reduce((s, f) => s + f[1], 0);
      let acc = 0, i = 0;
      while (i < items.length - 1 && acc + items[i][1] < total / 2) acc += items[i++][1];
      if (i === 0) acc = items[i++][1];
      const r = acc / total, a = items.slice(0, i), b = items.slice(i);
      if (w >= h) { layout(a, x, y, w * r, h, out); layout(b, x + w * r, y, w * (1 - r), h, out); }
      else { layout(a, x, y, w, h * r, out); layout(b, x, y + h * r, w, h * (1 - r), out); }
      return out;
    }
    function draw() {
      const svg = document.getElementById("tm");
      svg.innerHTML = "";
      const W = svg.clientWidth || 600;
      const sorted = [...files].sort((p, q) => q[1] - p[1]);
      for (const [f, x, y, w, h] of layout(sorted, 0, 0, W, 300, [])) {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        Object.entries({ x: x + 1, y: y + 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2), rx: 2 }).forEach(([k, v]) => r.setAttribute(k, v));
        r.style.fill = metric === "churn" ? kit.heat(f[2] / max) : kit.color(files.indexOf(f));
        r.style.stroke = "none";
        g.setAttribute("data-tip", f[0] + "\\n" + kit.fmt(f[1]) + " lines · " + f[2] + " edits");
        g.append(r);
        if (w > 70 && h > 18) {
          const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
          t.setAttribute("x", x + 6); t.setAttribute("y", y + 15); t.setAttribute("font-size", "11");
          t.style.fill = "#fff"; t.textContent = f[0].split("/").pop();
          g.append(t);
        }
        svg.append(g);
      }
      const list = document.getElementById("list");
      list.innerHTML = [...files].sort((p, q) => (metric === "churn" ? q[2] - p[2] : q[1] - p[1])).slice(0, 8).map((f) => {
        const v = metric === "churn" ? f[2] : f[1], top = metric === "churn" ? max : 1210;
        return "<span>" + f[0] + "</span><div class=bar style='--v:" + (100 * v / top) + "%'><span></span></div><span>" + kit.fmt(v) + "</span>";
      }).join("");
    }
    document.getElementById("hot").innerHTML = files.slice(0, 6).map((f) => "<span>" + f[0] + "</span><div class=bar data-tip='" + f[2] + " edits' style='--v:" + (100 * f[2] / max) + "%;--c:" + kit.heat(f[2] / max) + "'><span></span></div><span>" + f[2] + "</span>").join("");
    document.getElementById("metric").addEventListener("tab", (e) => { if (e.detail === "churn" || e.detail === "size") { metric = e.detail; draw(); } });
    draw();
    addEventListener("resize", draw); // drawn at the real width, so text keeps its size when the visual is expanded
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], week = document.getElementById("week");
    week.style.cssText = "display:grid;grid-template-columns:32px repeat(24,1fr);gap:2px;font-size:11px";
    for (let d = 0; d < 7; d++) {
      week.insertAdjacentHTML("beforeend", "<span class=muted>" + days[d] + "</span>");
      for (let h = 0; h < 24; h++) {
        const v = Math.max(0, Math.round((d < 5 ? 30 : 12) * Math.exp(-((h - 15) ** 2) / 30) + (d === 3) * 8));
        const cell = document.createElement("div");
        cell.style.cssText = "height:14px;border-radius:2px;background:" + kit.heat(v / 38);
        cell.addEventListener("pointermove", (e) => kit.tip("<b>" + days[d] + " " + h + ":00</b><br><i class='sw' style='--c:" + kit.heat(v / 38) + "'></i>" + v + " edits", e.clientX, e.clientY));
        cell.addEventListener("pointerleave", () => kit.tip(null));
        week.append(cell);
      }
    }
  </script>
</div>`);

const hostile = [
  `<script>fetch("${host}/fetch").catch(() => {});</script>`,
  `<img src="${host}/img" width="10" height="10">`,
  `<script>try { top.location = "https://example.invalid/top"; } catch (e) {}</script>`,
  `<script>try { window.open("${host}/open"); } catch (e) {}</script>`,
  `<form action="${host}/form" method="post" id="f"><input name="a" value="1"></form><script>try { document.getElementById("f").submit(); } catch (e) {}</script>`,
  `<script>try { alert("hostile"); } catch (e) {}</script>`,
  `<script>try { parent.studio.openExternal("https://example.invalid/x"); window.__parentAccess = "reached"; } catch (e) { window.__parentAccess = "blocked"; }</script>`,
  `<a id="js" href="javascript:alert(1)">click me</a>`,
  `<a id="ext" href="${host}/link">link out</a>`,
];

// A technical illustration with local images: the chat inlines `<img src>` and SVG `<image href>` as data URLs.
const localImage = process.env.FAKE_IMAGE || new URL("../resources/icon.png", import.meta.url).pathname;
const illustration = fence(`
<div class="stack">
  <div class="head"><span>Thrust climbs from 8.1 to 79.3 kN as the nozzle opens</span><span class="tabs" id="thr"><button>IDLE</button><button class="on">PART</button><button>MIL</button><button>AB 1</button><button>AB 2</button></span></div>
  <svg id="eng" viewBox="0 0 720 230" style="width:100%">
    <defs>
      <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V5" stroke="var(--line)" stroke-width="1.2"/></pattern>
      <radialGradient id="flame" cx="0.25" cy="0.5" r="0.75"><stop offset="0" stop-color="#fff4c2"/><stop offset="0.35" stop-color="#ff9a3c"/><stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/></radialGradient>
    </defs>
    <g fill="none" stroke="var(--fg)" stroke-width="1">
      <path d="M40 200H700M60 200V214M680 200V214M180 200V170H200V200M520 200V170H540V200"/>
      <path d="M70 52C90 70 100 90 110 96H520V84H612M70 168C90 150 100 130 110 124H520V136H612"/>
      <path id="petals" d="M612 84L650 92M612 136L650 128"/>
    </g>
    <path d="M140 110C140 104 150 102 160 102H470L520 110L470 118H160C150 118 140 116 140 110Z" fill="url(#hatch)" stroke="var(--fg)"/>
    <g stroke="var(--muted)">${Array.from({ length: 14 }, (_, i) => `<path d="M${170 + i * 9} ${100 - (14 - i)}V${120 + (14 - i)}"/>`).join("")}</g>
    <g fill="#ff9a3c" opacity="0.8">${[300, 318, 336, 354].map((x) => `<rect x="${x}" y="96" width="10" height="4"/><rect x="${x}" y="120" width="10" height="4"/>`).join("")}</g>
    <g stroke="var(--fg)">${[400, 412, 424].map((x) => `<path d="M${x} 98V122"/>`).join("")}</g>
    <path d="M536 100L528 104L536 108M536 112L528 116L536 120" fill="none" stroke="var(--fg)"/>
    <ellipse id="burn" cx="590" cy="110" rx="70" ry="18" fill="url(#flame)" opacity="0"/>
    <g font-size="11" fill="var(--muted)" stroke="none">
      <text x="72" y="36">Inlet</text><text x="190" y="24">Compressor</text><text x="320" y="36">Combustor</text><text x="400" y="24">Turbine</text><text x="510" y="36">V-gutters</text><text x="610" y="24">Nozzle petals</text>
    </g>
    <path d="M84 40V62M216 28V90M340 40V96M412 28V98M532 40V100M640 28V90" stroke="var(--line)"/>
    <image href="${localImage}" x="44" y="150" width="28" height="28"/>
  </svg>
  <div class="row"><img src="${localImage}" width="48" height="48" alt="reference"><span class="hint">Load cell <b class="num" id="kn">16.2</b> kN · nozzle <span class="num" id="noz">78</span>%</span></div>
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
</div>`);

// The worked examples of the inline-visuals skill, exactly as agents read them: they must render.
const skillExamples = () =>
  [...readFileSync(new URL("../resources/skills/inline-visuals/SKILL.md", import.meta.url), "utf8").matchAll(/^```visual\n([\s\S]*?)^```$/gm)].map((m) => fence(m[1]));

const loop = fence(`<div>loop</div><script>while (true) {}</script>`);

const FIXTURES = {
  architecture: "Here is how the pieces fit together.\n\n" + architecture + "That is the flow.\n",
  comparison: "Cache beats the origin on both counts.\n\n" + comparison + "Option A is cheaper.\n",
  dashboard: "Churn is concentrated in the session host and the transcript.\n\n" + dashboard + "The session host is the hottest file.\n",
  slider: "Drag the slider to see the count change.\n\n" + slider + "Done.\n",
  two: "First the flow.\n\n" + architecture + "Then the numbers.\n\n" + comparison + "End.\n",
  stream: "Streaming a visual in small chunks.\n\n" + architecture + "After the visual.\n",
  oversized: "Too big.\n\n" + fence(`<div>${"x".repeat(70 * 1024)}</div>`) + "After.\n",
  hostile: "Hostile fragments, one per fence.\n\n" + hostile.map(fence).join("") + "Done.\n",
  loop: "An infinite loop in a frame.\n\n" + loop + "Still responsive?\n",
  skill: "The inline-visuals skill's examples.\n\n" + skillExamples().join("") + "Done.\n",
  illustration: "A turbojet on a thrust stand, cut open.\n\n" + illustration + "Click a throttle setting.\n",
};

export const fixtureText = (name) => {
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`unknown FAKE_FIXTURE ${name}; have ${Object.keys(FIXTURES).join(", ")}`);
  return text;
};
