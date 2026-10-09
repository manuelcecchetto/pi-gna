import { describe, expect, it } from "vitest";

// The window parses its whole startup bundle before the first paint: everything main.tsx reaches through static
// imports. The pages, the browser pane, the command palette and Setup load later (lib/deferred.ts, P27).
const sources = import.meta.glob<string>(["./**/*.{ts,tsx}", "../../shared/**/*.ts", "!./**/*.test.ts"], { query: "?raw", import: "default", eager: true });

/** The modules a file imports statically: not `import type`, not dynamic `import()`. */
function staticImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const [statement, specifier] of source.matchAll(/^(?:import|export)\s+(?:[^"';]*?\sfrom\s+)?"([^"]+)"/gms)) {
    if (!/^(?:import|export)\s+type\s/.test(statement)) specifiers.push(specifier!);
  }
  return specifiers;
}

/** `from` + a relative specifier, as a key of `sources` ("./lib/x.ts", "../../shared/y.ts"), if it is one. */
function resolveModule(from: string, specifier: string): string | undefined {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.replace(/\?.*$/, "").split("/")) {
    if (part !== "..") {
      if (part !== ".") parts.push(part);
    } else if (parts.at(-1) === ".") parts[parts.length - 1] = "..";
    else if (parts.at(-1) === "..") parts.push("..");
    else parts.pop();
  }
  const base = parts.join("/");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((key) => key in sources);
}

/** Files (as `sources` keys, without the leading "./") and packages reachable from main.tsx through static imports. */
function startupBundle(): Set<string> {
  const seen = new Set<string>();
  const queue = ["./main.tsx"];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticImports(sources[file] ?? "")) {
      if (!specifier.startsWith(".")) seen.add(specifier);
      else {
        const target = resolveModule(file, specifier);
        if (target) queue.push(target);
      }
    }
  }
  return new Set([...seen].map((name) => name.replace(/^\.\//, "")));
}

describe("the startup bundle", () => {
  const bundle = startupBundle();

  it("finds what the first paint needs", () => {
    for (const name of ["App.tsx", "components/Sidebar.tsx", "components/SessionPane.tsx", "components/Transcript.tsx", "components/SettingsNav.tsx", "lib/file-finder.ts", "../../shared/board.ts", "react-dom/client", "marked"]) {
      expect(bundle, name).toContain(name);
    }
  });

  it("leaves out the pages, the browser pane, the command palette, Setup and what only they use", () => {
    const deferred = [
      "components/Atp.tsx",
      "components/AtpGraph.tsx",
      "components/BrowserPane.tsx",
      "components/CardDialog.tsx",
      "components/CommandPalette.tsx",
      "components/GitHub.tsx",
      "components/Kanban.tsx",
      "components/Laments.tsx",
      "components/Plugins.tsx",
      "components/Providers.tsx",
      "components/Remote.tsx",
      "components/Settings.tsx",
      "components/Setup.tsx",
      "lib/provider-logos.ts",
      "qrcode-generator",
    ];
    expect(deferred.filter((name) => bundle.has(name))).toEqual([]);
  });

  it("reads multi-line imports and skips type-only ones", () => {
    const source = `import {
  a,
  b,
} from "./x";
import type { T } from "./t";
import "./side.css";
export { c } from "./c";
const lazy = () => import("./lazy");`;
    expect(staticImports(source)).toEqual(["./x", "./side.css", "./c"]);
  });
});
