import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// Same id as main (scripts/build.mjs sets PIGNA_BUILD for both builds).
const BUILD = process.env.PIGNA_BUILD ?? Date.now().toString(36);
const root = dirname(fileURLToPath(import.meta.url));
const SHELL_STATIC = ["/manifest.webmanifest", "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png"];

// sw.js is generated so it can embed the build id and the exact list of hashed shell files.
function serviceWorker(): Plugin {
  return {
    name: "pigna-sw",
    generateBundle(_options, bundle) {
      const shell = ["/", ...SHELL_STATIC, ...Object.keys(bundle).map((name) => `/${name}`)];
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const BUILD = ${JSON.stringify(BUILD)};
const CACHE = "pigna-shell-" + BUILD;
const SHELL = ${JSON.stringify(shell)};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

// Drop the shell caches of older builds.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Only the app shell is cached; /api (and anything else) always goes to the network.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
  }
});
`,
      });
    },
  };
}

export default defineConfig({
  root: resolve(root, "src/mobile"),
  publicDir: resolve(root, "src/mobile/public"),
  define: { __PIGNA_BUILD__: JSON.stringify(BUILD) },
  plugins: [react(), tailwindcss(), serviceWorker()],
  build: { outDir: resolve(root, "out/mobile"), emptyOutDir: true, minify: true },
});
