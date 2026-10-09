import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(root, "electron-builder.yml"), "utf8");

// The `- entry` lines under a top-level key of electron-builder.yml.
function list(key) {
  const block = config.split(new RegExp(`^${key}:\\n`, "m"))[1] ?? "";
  const entries = [];
  for (const line of block.split("\n")) {
    const match = /^ {2}- "?([^"]+)"?$/.exec(line);
    if (!match) break;
    entries.push(match[1]);
  }
  return entries;
}

// Relative imports that survive type erasure (`import type` lines are dropped when pi loads the file).
function runtimeImports(file) {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^import (?!type )[^;]*?from "(\.{1,2}\/[^"]+)";/gms)].map(([, spec]) => {
    const base = join(dirname(file), spec);
    return [`${base}.ts`, `${base}.mts`, base].find((candidate) => existsSync(candidate));
  });
}

// pi loads the extensions straight from app.asar.unpacked, so every file they reach must ship and be unpacked.
function shippedExtensionDependencies() {
  const excluded = new Set(list("files").filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1)));
  const pending = readdirSync(join(root, "resources"))
    .filter((name) => /\.m?ts$/.test(name))
    .map((name) => `resources/${name}`)
    .filter((path) => !excluded.has(path))
    .map((path) => join(root, path));
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    for (const dependency of runtimeImports(file)) {
      expect(dependency, `unresolved import in ${relative(root, file)}`).toBeDefined();
      const path = relative(root, dependency);
      if (path.startsWith("resources/") || seen.has(path)) continue;
      seen.add(path);
      pending.push(dependency);
    }
  }
  return [...seen].sort();
}

describe("mobile bundle", () => {
  it("ships out/mobile (covered by out/**) and the build produces the PWA shell", () => {
    expect(list("files")).toContain("out/**");
    const out = join(root, "out", "mobile");
    if (!existsSync(out)) return; // present after `pnpm build`
    for (const file of ["index.html", "sw.js", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    expect(readFileSync(join(out, "index.html"), "utf8")).not.toMatch(/<script(?![^>]*\bsrc=)/);
    // One missing file fails the worker's whole install.
    const shell = JSON.parse(readFileSync(join(out, "sw.js"), "utf8").match(/const SHELL = (\[.*\]);/)[1]);
    expect(shell).toContain("/");
    for (const path of shell.filter((path) => path !== "/")) expect(existsSync(join(out, path)), path).toBe(true);
  });
});

describe("electron-builder.yml", () => {
  it("ships and unpacks every source file the bundled pi extensions import", () => {
    const dependencies = shippedExtensionDependencies();
    expect(dependencies).toContain("src/shared/viewport.ts");
    for (const key of ["files", "asarUnpack"]) {
      const missing = dependencies.filter((path) => !list(key).includes(path));
      expect(missing, `add to ${key}: in electron-builder.yml`).toEqual([]);
    }
  });
});
