import { spawnSync } from "node:child_process";
import electron from "electron";
import { describe, expect, it } from "vitest";
import windowConfig from "./electron.vite.config";
import phoneConfig from "./vite.mobile.config";
import { vendorChunk } from "./vite.chunks";

// A module graph as Rollup reports it: `importers` are the static ones; a module only `import()` reaches has none.
const GRAPH: Record<string, { isEntry?: boolean; importers: string[] }> = {
  "/app/src/main.tsx": { isEntry: true, importers: [] },
  "/app/src/App.tsx": { importers: ["/app/src/main.tsx"] },
  "/app/src/lib/markdown.ts": { importers: ["/app/src/App.tsx"] },
  "/app/node_modules/react-dom/client.js": { importers: ["/app/src/main.tsx"] },
  "/app/node_modules/react/index.js": { importers: ["/app/node_modules/react-dom/client.js", "/app/src/App.tsx"] },
  "/app/node_modules/.pnpm/marked@18/node_modules/marked/lib/marked.esm.js": { importers: ["/app/src/pages/Settings.tsx", "/app/src/lib/markdown.ts"] },
  "/app/src/pages/Settings.tsx": { importers: [] },
  "/app/node_modules/only-settings/index.js": { importers: ["/app/src/pages/Settings.tsx"] },
  "/app/node_modules/shiki/dist/core.mjs": { importers: [] },
  "/app/node_modules/@shikijs/langs/dist/cpp.mjs": { importers: ["/app/node_modules/@shikijs/langs/dist/c.mjs"] },
  "/app/node_modules/@shikijs/langs/dist/c.mjs": { importers: ["/app/node_modules/@shikijs/langs/dist/cpp.mjs"] },
};
const meta = {
  getModuleInfo: (id: string) => (GRAPH[id] ? { id, isEntry: false, ...GRAPH[id] } : null),
  getModuleIds: () => Object.keys(GRAPH)[Symbol.iterator](),
} as unknown as Parameters<typeof vendorChunk>[1];

describe("vendorChunk", () => {
  it("puts the packages an entry reaches through static imports in the vendor chunk, however deep", () => {
    expect(vendorChunk("/app/node_modules/react-dom/client.js", meta)).toBe("vendor");
    expect(vendorChunk("/app/node_modules/react/index.js", meta)).toBe("vendor");
    // Also used by a lazy page: the entry still needs it first.
    expect(vendorChunk("/app/node_modules/.pnpm/marked@18/node_modules/marked/lib/marked.esm.js", meta)).toBe("vendor");
  });

  it("leaves the app's own modules and the packages only lazy code reaches to Rollup", () => {
    for (const id of ["/app/src/main.tsx", "/app/src/App.tsx", "/app/src/pages/Settings.tsx", "/app/node_modules/only-settings/index.js", "/app/node_modules/shiki/dist/core.mjs", "/app/node_modules/@shikijs/langs/dist/cpp.mjs", "/app/node_modules/missing/index.js"]) {
      expect(vendorChunk(id, meta), id).toBeUndefined();
    }
  });
});

describe("build targets", () => {
  it("builds the window for the Chromium of the Electron it runs in", () => {
    const run = spawnSync(electron as unknown as string, ["-p", "process.versions.chrome"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const renderer = (windowConfig as { renderer?: { build?: { target?: unknown } } }).renderer;
    expect(renderer?.build?.target).toBe(`chrome${run.stdout.trim().split(".")[0]}`);
  });

  it("builds the phone for ES2022 and splits the vendor chunk in both", () => {
    expect((phoneConfig as { build?: { target?: unknown } }).build?.target).toBe("es2022");
    const output = (config: unknown) => (config as { build?: { rollupOptions?: { output?: { manualChunks?: unknown } } } }).build?.rollupOptions?.output?.manualChunks;
    expect(output(phoneConfig)).toBe(vendorChunk);
    expect(output((windowConfig as { renderer?: unknown }).renderer)).toBe(vendorChunk);
  });
});
