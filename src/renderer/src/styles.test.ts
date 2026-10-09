import { describe, expect, it } from "vitest";
import source from "./styles.css?raw";

const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level blocks of a stylesheet (or of a block's body): [prelude, body], nested blocks kept whole in the body. */
function blocks(source: string): [string, string][] {
  const found: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "{" && depth++ === 0) open = index;
    else if (char === "}" && --depth === 0) {
      found.push([source.slice(start, open).trim(), source.slice(open + 1, index)]);
      start = index + 1;
    } else if (char === ";" && depth === 0) start = index + 1;
  }
  return found;
}

/** Every style rule, nested ones (media queries, `:root[...] { .x {} }`) flattened: [selector, declarations]. */
function rules(source: string): [string, string][] {
  return blocks(source).flatMap(([prelude, body]) => (prelude.startsWith("@keyframes") ? [] : body.includes("{") ? rules(body) : [[prelude, body] as [string, string]]));
}

/** Split on commas outside parentheses (cubic-bezier(...) lists). */
const list = (value: string) => value.split(/,(?![^(]*\))/).map((part) => part.trim());

describe("styles.css", () => {
  // An infinite animation of anything but transform or opacity restyles and repaints on the main thread every frame
  // for as long as it runs (P16): a focused composer, a spinner or a shimmer kept the renderer busy while idle.
  it("animates only transform and opacity in endless animations", () => {
    const keyframes = new Map(
      blocks(css)
        .filter(([prelude]) => prelude.startsWith("@keyframes"))
        .map(([prelude, body]) => [prelude.split(/\s+/)[1], new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]))]),
    );
    const endless = new Set(
      rules(css).flatMap(([, body]) =>
        [...body.matchAll(/(?:^|;|\s)animation\s*:\s*([^;]+)/g)].flatMap((match) => list(match[1]!).filter((one) => /\binfinite\b/.test(one)).map((one) => one.split(/\s+/)[0])),
      ),
    );
    expect(endless).toContain("composer-flow");
    expect(endless).toContain("shimmer-band");
    // The ATP graph's running node and live edge still animate a shadow and a dash offset (only while a plan runs).
    const allowed: Record<string, string[]> = { "atp-glow": ["box-shadow"], "atp-march": ["stroke-dashoffset"] };
    for (const name of endless) {
      const properties = keyframes.get(name!);
      expect(properties, name).toBeDefined();
      expect([...properties!].filter((property) => !["transform", "opacity", ...(allowed[name!] ?? [])].includes(property!)), name).toEqual([]);
    }
  });

  // The focused composer's border and glow flow only while the composer has data-flow (typing), so it idles at rest.
  it("pauses the composer's flow unless the composer is flowing", () => {
    const flowing = rules(css).filter(([, body]) => /animation\s*:\s*composer-flow\b/.test(body));
    expect(flowing.map(([selector]) => selector)).toEqual([".composer-box:focus-within > .composer-ring::before", ".composer:focus-within .composer-glow::before"]);
    for (const [, body] of flowing) expect(body).toMatch(/animation\s*:\s*composer-flow [^;]*\bpaused\s*;/);
    const running = rules(css).find(([, body]) => /animation-play-state\s*:\s*running/.test(body));
    expect(running?.[0]).toBe(".composer[data-flow] .composer-box:focus-within > .composer-ring::before,\n.composer[data-flow]:focus-within .composer-glow::before");
  });
});
