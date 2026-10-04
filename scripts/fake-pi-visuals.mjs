// Fixtures for fake-pi's FAKE_FIXTURE: replies holding ```visual fences, good and hostile. See docs/DESIGN.md
// ("Verifying inline visuals"). Hostile fragments call out to http://127.0.0.1:$FAKE_HOSTILE_PORT, which must see nothing.
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

const loop = fence(`<div>loop</div><script>while (true) {}</script>`);

const FIXTURES = {
  architecture: "Here is how the pieces fit together.\n\n" + architecture + "That is the flow.\n",
  comparison: "Cache beats the origin on both counts.\n\n" + comparison + "Option A is cheaper.\n",
  slider: "Drag the slider to see the count change.\n\n" + slider + "Done.\n",
  two: "First the flow.\n\n" + architecture + "Then the numbers.\n\n" + comparison + "End.\n",
  stream: "Streaming a visual in small chunks.\n\n" + architecture + "After the visual.\n",
  oversized: "Too big.\n\n" + fence(`<div>${"x".repeat(70 * 1024)}</div>`) + "After.\n",
  hostile: "Hostile fragments, one per fence.\n\n" + hostile.map(fence).join("") + "Done.\n",
  loop: "An infinite loop in a frame.\n\n" + loop + "Still responsive?\n",
};

export const fixtureText = (name) => {
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`unknown FAKE_FIXTURE ${name}; have ${Object.keys(FIXTURES).join(", ")}`);
  return text;
};
