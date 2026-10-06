import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { PUSH_TEXT } from "./src/shared/push-rules";

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

// Web Push (REMOTE.md 13a): the payload is {kind, chat, t} plus the chat title and a reply excerpt; the status text comes from here. iOS revokes a subscription whose pushes
// show nothing, so a notification is always shown unless the app is visibly open (then the app already shows the state).
const PUSH_TEXT = ${JSON.stringify(PUSH_TEXT)};
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const kind = typeof data.kind === "string" && PUSH_TEXT[data.kind] ? data.kind : "approval";
  const chat = typeof data.chat === "string" ? data.chat : "";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => client.visibilityState === "visible")) return;
    const title = typeof data.title === "string" && data.title ? data.title : "pi-gna";
    const preview = typeof data.preview === "string" && data.preview ? data.preview : "";
    await self.registration.showNotification(title, { body: preview ? PUSH_TEXT[kind] + ": " + preview : PUSH_TEXT[kind], tag: kind + ":" + chat, data: { chat } });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chat = event.notification.data && event.notification.data.chat;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows[0];
    if (open) {
      await open.focus();
      if (chat) open.postMessage({ type: "open-chat", chat });
    } else {
      await self.clients.openWindow(chat ? "/#/chat/" + chat : "/");
    }
  })());
});

// Only the app shell is cached; /api (and anything else) always goes to the network.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/visual/")) return;
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
