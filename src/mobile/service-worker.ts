// The phone app's service worker, written into out/mobile as sw.js by vite.mobile.config.ts at build time. The build id
// names its cache; the shell list is what install downloads, so it stays as small as the first screen needs (P36).
import { PUSH_TEXT } from "../shared/push-rules";

/** The part of Rollup's output bundle the shell list reads (vite's own types pull in Node's). */
export type BundleFile =
  | { type: "chunk"; fileName: string; isEntry: boolean; imports: string[]; viteMetadata?: { importedCss: Set<string> } }
  | { type: "asset"; fileName: string };

/** The hashed files the entry needs before it can run: its chunk, the chunks it imports statically and their CSS.
 * Lazy chunks (grammars, sheets) and images are left to the runtime cache. */
export function shellFiles(bundle: Record<string, BundleFile>): string[] {
  const files = new Set<string>();
  const visit = (name: string) => {
    const chunk = bundle[name];
    if (files.has(name) || chunk?.type !== "chunk") return;
    files.add(name);
    for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(css);
    chunk.imports.forEach(visit);
  };
  for (const file of Object.values(bundle)) if (file.type === "chunk" && file.isEntry) visit(file.fileName);
  return [...files];
}

/** sw.js for one build: `shell` is every path install caches. */
export function serviceWorkerSource(build: string, shell: readonly string[]): string {
  return `const BUILD = ${JSON.stringify(build)};
const CACHE = "pigna-shell-" + BUILD;
const SHELL = ${JSON.stringify(shell)};

// An update downloads only what changed (P42): a hashed file an older build's cache holds is copied, and a file under
// its own name ("/", the manifest, icons) is asked for with the held copy's tag, so an unchanged one answers 304. Every
// answer is in hand before any is kept, so a failed install leaves no half-filled cache.
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const answers = await Promise.all(SHELL.map(async (path) => {
      const held = await caches.match(path);
      if (held && path.startsWith("/assets/")) return held;
      const tag = held && held.headers.get("ETag");
      const response = await fetch(path, tag ? { headers: { "If-None-Match": tag } } : undefined);
      if (response.status === 304) return held;
      if (!response.ok) throw new TypeError("install: " + path + " answered " + response.status);
      return response;
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((path, index) => cache.put(path, answers[index])));
    await self.skipWaiting();
  })());
});

// Drop the shell caches of older builds.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Web Push (REMOTE.md 13a): the payload is {kind, chat, t} plus the chat title and a reply excerpt; the body is the excerpt, else the status text from here. Every push shows a
// notification, even while the app is open: iOS silently ends a subscription after about three pushes that show nothing, and Apple keeps answering 201.
const PUSH_TEXT = ${JSON.stringify(PUSH_TEXT)};
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const kind = typeof data.kind === "string" && PUSH_TEXT[data.kind] ? data.kind : "approval";
  const chat = typeof data.chat === "string" ? data.chat : "";
  event.waitUntil((async () => {
    const title = typeof data.title === "string" && data.title ? data.title : "pi-gna";
    const preview = typeof data.preview === "string" && data.preview ? data.preview : "";
    await self.registration.showNotification(title, { body: preview || PUSH_TEXT[kind], tag: kind + ":" + chat, data: { chat } });
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

// The shell is precached at install; the other hashed files (/assets/*: grammars, lazy screens, images; the server
// sends them immutable) are kept the first time they load. /api (and anything else) always goes to the network.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/visual/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
      // Copied now: once the page has the answer it reads the body, and a read body cannot be copied.
      const copy = response.ok && response.clone();
      if (copy) event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      return response;
    })));
  }
});
`;
}
