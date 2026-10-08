#!/usr/bin/env node
// Builds /tmp/vis-eval/<label>/page.html: every visual of a run on the real kit, for screenshots.
// Open with ?theme=light|dark like resources/visual/gallery.html. Usage: node scripts/visual-eval-page.mjs <label>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { score } from "./visual-eval.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join("/tmp/vis-eval", process.argv[2]);
const kit = readFileSync(join(root, "resources/visual/kit.css"), "utf8");
// Fragment scripts call window.kit (kit.player, kit.color), so the runtime loads before them.
const kitJs = readFileSync(join(root, "resources/visual/kit.js"), "utf8");
const parts = readdirSync(dir).filter((f) => /^S\d\.md$|^N\d\.md$/.test(f)).sort().flatMap((f) =>
  score(readFileSync(join(dir, f), "utf8")).frags.map((h) => `<h3 class="muted">${f}</h3><div class="visual-box">${h}</div>`));
writeFileSync(join(dir, "page.html"), `<!doctype html><meta charset=utf-8><style>${kit}
body{max-width:720px;margin:16px auto;background:var(--canvas)}.visual-box{padding:8px;border:1px solid var(--line);border-radius:8px;margin-bottom:12px}</style>
<script>const t=new URLSearchParams(location.search).get("theme");if(t)document.documentElement.style.colorScheme=t</script>
<body><div id="visual" hidden></div><script>${kitJs}</script>${parts.join("\n")}</body>`);
console.log(join(dir, "page.html"));
