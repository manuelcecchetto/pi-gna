#!/usr/bin/env node
// Runs the docs/visual-evals.md prompts through a real `pi -p` with the visual prompt appended,
// then auto-scores what can be scored mechanically. Usage:
//   node scripts/visual-eval.mjs <label> <model> [thinking] [caseId...]
// Output: /tmp/vis-eval/<label>/<case>.md plus a summary table on stdout. Shots: render-eval.html.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CASES = [
  { id: "S1", should: true, prompt: "Explain this repo's session-host spawn flow: how a chat becomes a running pi process, step by step (src/main/session-host.ts)." },
  { id: "S2", should: true, prompt: "Compare three caching strategies (write-through, write-back, cache-aside) on four dimensions: read latency, write latency, consistency, complexity. No need to look at the repo." },
  { id: "S3", should: true, prompt: "Show the timeline of what happens when an ATP plan node fails, from claim to the runner moving on. Read the ATP code in this repo (resources/atp, src/main) for the real states and order." },
  { id: "S4", should: true, prompt: "Show test coverage per module (src/main, src/renderer, src/shared) from real numbers: run the tests with coverage if available, otherwise count test files and tests per module with shell commands." },
  { id: "S5", should: true, prompt: "Draw the state machine of a chat's lifecycle in pi-gna (idle, streaming, tool running, error, etc.). Base it on the code in src/main/session-host.ts and src/renderer." },
  { id: "S6", should: true, prompt: "The composer in this repo could show how full the context window is. Mock three treatments for where that hint could live (a banner over the composer, a meter in the composer's toolbar with a popover, a choice at send time), based on the real composer in src/renderer, and recommend one. Do not edit files." },
  { id: "S7", should: true, prompt: "Walk me through a multi-agent coding pipeline as it runs: an architect writes a design and a critic grades it (sending it back up to 3 times), two implementer/tester pairs build packages in parallel, then a review fans out to several reviewers before a human merges. Show the work moving, including one design sent back. No need to look at the repo." },
  { id: "N1", should: false, prompt: "What port does the Vite dev server use in this repo? Answer in one line." },
  { id: "N2", should: false, prompt: "Fix this typo in my sentence: 'The quick brown fox jumsp over the lazy dog.'" },
  { id: "N3", should: false, prompt: "Write a TypeScript function debounce(fn, ms) with proper generics." },
  { id: "N4", should: false, prompt: "Should I store settings as one JSON file or as one file per key? Yes or no, with a short reason." },
  { id: "N5", should: false, prompt: "I just changed src/shared/settings.ts: renamed `wallpaperLoop` to `loopWallpapers` and updated Settings.tsx and main/settings.ts to match. Summarize the edit for the changelog (do not touch any files)." },
];

const FENCE = /```visual\n([\s\S]*?)```/g;
const BAD = [
  [/https?:\/\/(?!www\.w3\.org\/2000\/svg)|\/\/cdn|@import|<link\b|<img\b[^>]*src|fetch\(|XMLHttpRequest|<iframe/i, "network/resource"],
  [/<style\b/i, "style block"],
  [/style="[^"]*(?<![-\w])(color|background|font-family|font-size|box-shadow|text-shadow|gradient)\s*:/i, "inline color/font/bg style"],
  [/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, "hardcoded color"],
  [/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u, "emoji"],
];

export function score(text) {
  const frags = [...text.matchAll(FENCE)].map((m) => m[1]);
  const flags = new Set();
  // A UI mock pictures the product being changed, so its own colors, fonts and styles are expected there.
  const mockOk = new Set(["style block", "inline color/font/bg style", "hardcoded color"]);
  for (const f of frags) for (const [re, name] of BAD) if (re.test(f) && !(mockOk.has(name) && /class="[^"]*\bmock\b/.test(f))) flags.add(name);
  const prose = text.replace(FENCE, "").trim();
  return { visuals: frags.length, kb: +(frags.join("").length / 1024).toFixed(1), proseChars: prose.length, flags: [...flags], frags };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [label, model, thinking = "medium", ...only] = process.argv.slice(2);
  if (!label || !model) throw new Error("usage: visual-eval.mjs <label> <model> [thinking] [caseId...]");
  const out = join("/tmp/vis-eval", label);
  mkdirSync(out, { recursive: true });
  const rows = [];
  for (const c of CASES.filter((c) => !only.length || only.includes(c.id))) {
    const r = spawnSync("pi", ["-p", "--no-session", "--model", model, "--thinking", thinking,
      "--append-system-prompt", join(root, "resources/pigna-prompt.md"),
      "--append-system-prompt", join(root, "resources/pigna-visual-prompt.md"), c.prompt],
      { cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 32 << 20 });
    const text = r.stdout ?? "";
    writeFileSync(join(out, `${c.id}.md`), text);
    const s = score(text);
    rows.push({ id: c.id, should: c.should, ...s, frags: undefined });
    console.log(JSON.stringify(rows.at(-1)));
  }
  writeFileSync(join(out, "summary.json"), JSON.stringify(rows, null, 1));
}
