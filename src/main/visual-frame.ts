// Pure parts of the visual frame scheme (no Electron import, so vitest can load them). See docs/DESIGN.md, Visuals.
export const VISUAL_SCHEME = "pigna-visual";

/** Frame document header: no network, navigation, forms or plugins. unsafe-inline is fine because the frame has an opaque origin. */
export const VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The only paths the scheme serves: URL path -> [file under resources/visual, content type]. */
const ASSETS: Record<string, readonly [string, string]> = {
  "/doc": ["doc.html", "text/html; charset=utf-8"],
  "/kit.css": ["kit.css", "text/css; charset=utf-8"],
  "/kit.js": ["kit.js", "text/javascript; charset=utf-8"],
};

/** Map a request URL to a bundled asset, or null for anything else (other scheme, empty host, unknown or traversing path). */
export function visualAsset(rawUrl: string): { file: string; type: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${VISUAL_SCHEME}:` || !/^[a-z0-9-]{8,64}$/.test(url.hostname)) return null;
  const asset = Object.hasOwn(ASSETS, url.pathname) ? ASSETS[url.pathname] : undefined;
  return asset ? { file: asset[0], type: asset[1] } : null;
}
