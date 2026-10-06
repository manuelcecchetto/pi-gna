// Tab favicons: the icon the page declares (Chromium's `page-favicon-updated`, which falls back to /favicon.ico),
// fetched through the tab's own session like a browser would, so local dev servers get theirs too. The result is a
// small data URL carried in the browser state; when the page's icon cannot be had, a public site's icon comes from
// the same service as chat links (site-icons.ts).
import { siteIcon } from "../site-icons";

const MAX_BYTES = 256 * 1024;
/** Raw icons kept as they are (SVG, ICO where the platform cannot decode them) must stay small: the state carries them. */
const MAX_RAW_BYTES = 32 * 1024;
const SIZE = 32;
const TIMEOUT_MS = 5000;

/** Decodes and shrinks a bitmap to a PNG data URL, or null when it cannot decode it (Electron's nativeImage in main). */
export type Shrink = (bytes: Buffer, size: number) => string | null;

/** A data URL for icon bytes: shrunk when decodable, otherwise kept raw if it is a small image (exported for tests). */
export function iconDataUrl(bytes: Buffer, mimeType: string, shrink: Shrink): string | null {
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  if (mimeType !== "image/svg+xml") {
    const small = shrink(bytes, SIZE);
    if (small) return small;
  }
  if (!mimeType.startsWith("image/") || bytes.length > MAX_RAW_BYTES) return null;
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/** The first candidate a tab can fetch: http(s) or data (exported for tests). */
export function pickCandidate(favicons: string[]): string | undefined {
  return favicons.find((url) => /^(https?|data):/i.test(url));
}

/** The favicon of a page as a data URL, or null. `fetcher` is the tab session's fetch. */
export async function tabFavicon(pageUrl: string, favicons: string[], fetcher: typeof fetch, shrink: Shrink): Promise<string | null> {
  const candidate = pickCandidate(favicons);
  if (candidate) {
    try {
      // The session's fetch does not read data: URLs (icons inlined in the page); Node's does, without the network.
      const response = await (/^data:/i.test(candidate) ? fetch(candidate) : fetcher(candidate, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
      if (response.ok) {
        const declared = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        const mimeType = declared.startsWith("image/") ? declared : /\.svg(\?|$)/i.test(candidate) ? "image/svg+xml" : /\.ico(\?|$)/i.test(candidate) ? "image/x-icon" : declared;
        const url = iconDataUrl(Buffer.from(await response.arrayBuffer()), mimeType, shrink);
        if (url) return url;
      }
    } catch {
      // Fall through to the icon service.
    }
  }
  const icon = await siteIcon(pageUrl);
  return icon ? `data:${icon.mimeType};base64,${icon.data}` : null;
}
