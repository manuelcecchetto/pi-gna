// The renderer is served from app://pigna instead of file:// (Electron security checklist #18): a standard,
// secure origin gets normal web isolation, V8 code caching and a CSP response header, and the file:// fuse
// privileges can stay off.
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { VISUAL_SCHEME } from "./visual-frame";

export const APP_ORIGIN = "app://pigna";

// index.html's meta CSP also allows ws: for Vite's dev server. Pages served here get this header too, and since
// both policies apply, the stricter one wins everywhere but the dev server.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src pigna-visual:",
  "frame-ancestors 'none'",
].join("; ");

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  // One call: registerSchemesAsPrivileged replaces the earlier list. pigna-visual needs `standard` for relative URLs and
  // script-src 'self' (measured, docs/DESIGN.md Visuals); the frame cannot fetch, so no other privilege.
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: VISUAL_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/** Serve `root` (the built renderer) on app://pigna, refusing anything outside it. */
export function serveRenderer(root: string): void {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (url.host !== "pigna" || !file.startsWith(root + sep)) return new Response("not found", { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(file).href);
      if (!file.endsWith(".html")) return response;
      const headers = new Headers(response.headers);
      headers.set("content-security-policy", CSP);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
