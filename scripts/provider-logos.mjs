#!/usr/bin/env node
// Regenerates src/renderer/src/lib/provider-logos.ts, the logos of pi's providers on the Settings page's Providers
// section: `node scripts/provider-logos.mjs`. Most come from LobeHub's AI brand icons (MIT; pinned below), drawn the
// way LobeHub's own Avatar components draw them: the brand's tile background, a single-color mark in the avatar
// color, or the full-color mark. Radius, TypeSafe and Ant Ling are not in LobeHub: their marks are copied from the
// companies' own sites (URLs below). A provider pi adds later gets an initial until it is mapped in BRANDS.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATIC = "@lobehub/icons-static-svg@1.95.1";
const REACT = "@lobehub/icons@5.23.0";
const OUT = new URL("../src/renderer/src/lib/provider-logos.ts", import.meta.url);

/** pi provider id → LobeHub brand (its folder in @lobehub/icons). */
const BRANDS = {
  "amazon-bedrock": "Bedrock",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure",
  baseten: "Baseten",
  cerebras: "Cerebras",
  "claude-bridge": "ClaudeCode",
  "cloudflare-ai-gateway": "Cloudflare",
  "cloudflare-workers-ai": "Cloudflare",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  "github-copilot": "GithubCopilot",
  google: "Google",
  "google-vertex": "VertexAI",
  groq: "Groq",
  huggingface: "HuggingFace",
  "kimi-coding": "Kimi",
  meta: "Meta",
  minimax: "Minimax",
  "minimax-cn": "Minimax",
  mistral: "Mistral",
  moonshotai: "Moonshot",
  "moonshotai-cn": "Moonshot",
  nvidia: "Nvidia",
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  opencode: "OpenCode",
  "opencode-go": "OpenCode",
  openrouter: "OpenRouter",
  "qwen-token-plan": "Qwen",
  "qwen-token-plan-cn": "Qwen",
  "qwen-token-plan-individual": "Qwen",
  together: "Together",
  "vercel-ai-gateway": "Vercel",
  xai: "XAI",
  xiaomi: "XiaomiMiMo",
  "xiaomi-token-plan-ams": "XiaomiMiMo",
  "xiaomi-token-plan-cn": "XiaomiMiMo",
  "xiaomi-token-plan-sgp": "XiaomiMiMo",
  zai: "ZAI",
  "zai-coding-cn": "ZAI",
};

/** Where LobeHub's avatar is hard to read: Fireworks draws its mark black on its violet. */
const OVERRIDES = { Fireworks: { color: "#fff" } };

/** Marks from the companies' own sites, single paths drawn in `color` on `background`. */
const VENDORED = {
  // https://radius.earendil.com (its logo mark; #111111 and #f6f6f6 are the site's own mark colors).
  radius: { brand: "Radius", viewBox: "0 0 560 560", d: "M560 140h-70c0 71.3-21.4 137.7-58 193l128 128-99 99-128-128a348 348 0 0 1-193 58v70H0V140h140V0h420zm-420 0v210c116 0 210-94 210-210z", rule: "evenodd", background: "#111111", color: "#f6f6f6", scale: 0.55 },
  // https://typesafe.ai (the white mark on the dark tile of the site's header logo).
  typesafe: { brand: "TypeSafe", viewBox: "0 0 16.487 24", d: "M 12.756 2.928 L 12.756 7.067 L 16.486 9.487 L 16.487 18.652 L 8.244 24 L 3.732 21.073 L 3.732 16.82 L 0 14.399 L 0 5.35 L 0.355 5.118 L 8.244 0 Z M 5.94 20.65 L 8.242 22.144 L 14.275 18.227 L 11.975 16.735 Z M 9.022 10.332 L 9.022 14.4 L 5.29 16.822 L 5.29 19.216 L 11.197 15.383 L 11.197 8.921 Z M 12.756 15.384 L 14.928 16.794 L 14.928 10.332 L 12.756 8.922 Z M 2.21 13.976 L 4.511 15.47 L 6.812 13.976 L 4.512 12.485 Z M 1.559 6.193 L 1.559 12.544 L 3.731 11.134 L 3.731 7.066 L 7.464 4.643 L 7.464 2.36 L 1.56 6.193 Z M 5.291 11.132 L 7.463 12.542 L 7.463 10.332 L 5.292 8.921 L 5.292 11.132 Z M 5.94 7.487 L 8.244 8.981 L 10.544 7.488 L 8.244 5.994 Z M 9.024 4.643 L 11.196 6.054 L 11.196 3.774 L 9.024 2.359 Z", background: "#1e1e1e", color: "#fff", scale: 0.62 },
  // https://www.ant-ling.com (百灵 Ant Ling Logo: mdn.alipayobjects.com/huamei_yj1ans/afts/img/g8JZRrqn3R8AAAAAQCAAAAgADqLdAQFr/original).
  "ant-ling": { brand: "AntLing", viewBox: "0 0 56 56", d: "M23.0837 4.14727C23.4047 3.94871 23.8119 3.94526 24.1139 4.17071L29.7956 6.88457C30.0573 7.08052 30.0169 7.47596 29.7311 7.63164C21.9807 11.8619 17.302 15.9874 14.8425 19.9949C13.2514 22.5852 10.3251 29.6555 12.9733 36.0359C15.716 42.6364 21.9322 45.0203 26.5329 45.0203C30.0087 45.0203 32.3712 43.9761 34.7712 42.3523C41.2785 37.9448 42.0285 29.3468 37.1852 23.4334V23.4305C37.2025 23.4453 39.8831 25.7483 41.5759 29.2352C41.2532 28.0697 40.7733 26.9511 40.1374 25.909C38.7028 23.5552 36.7695 21.5823 34.0407 20.2107C27.9675 17.1587 15.2951 18.6299 13.2995 31.7693C13.5017 22.6565 19.5393 16.9388 25.0056 15.1697C28.0421 14.1873 31.2569 13.9996 34.2907 14.5418C38.3385 11.2644 42.8127 9.79064 44.4147 9.33965C44.7842 9.23496 45.1834 9.33932 45.4557 9.61309C45.9141 10.0747 46.7149 10.8772 47.7341 11.8836H47.7399C48.0446 12.1842 47.8852 12.7025 47.4645 12.783C43.5274 13.5426 40.839 14.2947 37.9968 15.6072C41.4431 17.0031 44.3933 19.4488 46.1921 22.8201C46.4048 23.2172 46.2189 23.7081 45.7956 23.8611L43.3874 24.7332C45.5043 28.3329 46.0487 32.7462 45.0104 37.2664C43.2467 44.9513 37.3384 50.3896 29.7956 51.6834C28.6146 51.8848 27.444 52.0193 26.2927 51.9979C25.9026 51.9909 25.5967 51.6853 25.569 51.3162C25.4877 51.1735 25.4521 51.0025 25.4831 50.826L25.945 48.2361C23.8389 48.0884 21.8642 47.7391 19.8874 46.9393C8.15393 42.188 6.92433 30.5948 8.60711 23.5701C10.7915 14.4599 17.5068 7.55894 23.0837 4.14727Z", background: "#fff", color: "#000", scale: 0.86 },
};

const work = mkdtempSync(join(tmpdir(), "provider-logos-"));
try {
  for (const pkg of [STATIC, REACT]) {
    const tarball = execFileSync("npm", ["view", pkg, "dist.tarball"], { encoding: "utf8" }).trim();
    const dir = join(work, pkg.startsWith("@lobehub/icons-static") ? "static" : "react");
    execFileSync("mkdir", ["-p", dir]);
    execFileSync("sh", ["-c", `curl -fsSL "$0" | tar xz -C "$1"`, tarball, dir]);
  }
  const logos = {};
  for (const brand of new Set(Object.values(BRANDS))) logos[brand] = { ...lobe(brand), ...OVERRIDES[brand] };
  for (const { brand, viewBox, d, rule, background, color, scale } of Object.values(VENDORED)) {
    logos[brand] = { viewBox, body: `<path fill="currentColor"${rule ? ` fill-rule="${rule}" clip-rule="${rule}"` : ""} d="${d}"/>`, background, color, scale };
  }
  const providers = { ...BRANDS, ...Object.fromEntries(Object.entries(VENDORED).map(([id, { brand }]) => [id, brand])) };
  writeFileSync(OUT, render(logos, providers));
  console.log(`wrote ${Object.keys(logos).length} logos for ${Object.keys(providers).length} providers to ${OUT.pathname}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** A brand drawn as LobeHub's Avatar draws it. */
function lobe(brand) {
  const es = join(work, "react", "package", "es", brand);
  const style = readFileSync(join(es, "style.js"), "utf8");
  const constants = Object.fromEntries([...style.matchAll(/export var (\w+) = ([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  const value = (name) => {
    const raw = constants[name];
    if (raw === undefined) throw new Error(`${brand}: no ${name}`);
    return /^['"]/.test(raw) ? JSON.parse(raw.replace(/^'|'$/g, '"')) : /^[\d.]+$/.test(raw) ? Number(raw) : value(raw);
  };
  const icon = /Icon: (\w+)/.exec(readFileSync(join(es, "components", "Avatar.js"), "utf8"))?.[1];
  if (icon !== "Mono" && icon !== "Color") throw new Error(`${brand}: its avatar draws a ${icon} icon`);
  const svg = readFileSync(join(work, "static", "package", "icons", `${brand.toLowerCase()}${icon === "Color" ? "-color" : ""}.svg`), "utf8");
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  let body = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>.*?<\/title>/, "");
  // The root's paint (a mono mark's fill="currentColor" and its fill rule) moves to a group around the mark.
  const paint = [.../\b(fill|fill-rule|clip-rule)="([^"]*)"/g[Symbol.matchAll](/^<svg([^>]*)>/.exec(svg)?.[1] ?? "")].map(([attribute]) => attribute);
  if (paint.length) body = `<g ${paint.join(" ")}>${body}</g>`;
  // Gradient ids get a per-use prefix (ProviderLogo), so two logos on a page never share one.
  const ids = [...body.matchAll(/id="([^"]+)"/g)].map(([, id]) => id);
  ids.forEach((id, index) => (body = body.replaceAll(`id="${id}"`, `id="{id}${index}"`).replaceAll(`url(#${id})`, `url(#{id}${index})`)));
  return { viewBox, body, background: value("AVATAR_BACKGROUND"), color: value("AVATAR_COLOR"), scale: value("AVATAR_ICON_MULTIPLE") };
}

function render(logos, providers) {
  const entries = Object.entries(logos)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([brand, logo]) => `  ${brand}: ${JSON.stringify(logo)},`);
  const map = Object.entries(providers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, brand]) => `  ${JSON.stringify(id)}: "${brand}",`);
  return `// Generated by scripts/provider-logos.mjs; edit that and run it again. Brand marks are their owners' trademarks.
// LobeHub icons (${STATIC}, ${REACT}): MIT License, Copyright (c) 2023 LobeHub.
// Radius, TypeSafe and Ant Ling: from radius.earendil.com, typesafe.ai and ant-ling.com.

/** A provider's mark (SVG markup; {id} prefixes its gradient ids) on its tile. */
export interface ProviderLogo {
  viewBox: string;
  body: string;
  /** The tile: a color or a CSS gradient. */
  background: string;
  /** The color of a single-color mark. */
  color: string;
  /** The mark's size, as a share of the tile. */
  scale: number;
}

export const LOGOS: Record<string, ProviderLogo> = {
${entries.join("\n")}
};

/** pi's provider ids → their brand in LOGOS. */
export const PROVIDER_BRANDS: Record<string, string> = {
${map.join("\n")}
};
`;
}
