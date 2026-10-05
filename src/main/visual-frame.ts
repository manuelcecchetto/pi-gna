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

/** The remote server's path for the same frame: `/visual/<frameId>/<asset>`, relative links in doc.html resolve beside it. */
export function visualRemoteAsset(path: string): { file: string; type: string } | null {
  const match = /^\/visual\/[a-z0-9-]{8,64}(\/[^/]*)$/.exec(path);
  const asset = match && Object.hasOwn(ASSETS, match[1]!) ? ASSETS[match[1]!] : undefined;
  return asset ? { file: asset[0], type: asset[1] } : null;
}

/** The process to kill for a stuck frame: the one hosting `pigna-visual://<frameId>/`, never the app window's own. */
export function visualFrameToKill(frames: readonly { url: string; osProcessId: number }[], frameId: string, appPid: number): number | undefined {
  if (!/^[0-9a-f]{16}$/.test(frameId)) return undefined;
  const frame = frames.find((f) => f.url.startsWith(`${VISUAL_SCHEME}://${frameId}/`));
  return frame && frame.osProcessId > 0 && frame.osProcessId !== appPid ? frame.osProcessId : undefined;
}
