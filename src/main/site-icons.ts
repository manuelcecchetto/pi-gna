// Favicons for the web links of rendered answers. The renderer's CSP blocks remote images, so main fetches them
// from Google's favicon service, as the ChatGPT app does (one request per origin, no cookies, no referrer), and hands
// back data URLs. Origins that cannot be public (localhost, IPs, single labels, .local and the like) are never sent.

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const MAX_CACHED = 500;

export interface SiteIcon {
  mimeType: string;
  data: string;
}

const cache = new Map<string, Promise<SiteIcon | null>>();

/** The origin whose icon a web link shows, or null when there is nothing to fetch publicly (exported for tests). */
export function publicOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (/\.(local|localhost|internal|lan|home|test|invalid|example|ts\.net)$/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
}

/** Google's favicon service; `drop_404_icon` answers 404 instead of a generic globe for sites without one. */
export function iconServiceUrl(origin: string): string {
  return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=32&drop_404_icon=true`;
}

async function fetchIcon(origin: string, fetcher: typeof fetch): Promise<SiteIcon | null> {
  const response = await fetcher(iconServiceUrl(origin), { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  return { mimeType, data: bytes.toString("base64") };
}

/** The icon of the site a web link points to, or null (no public origin, no icon, network error). Cached per origin. */
export function siteIcon(url: string, fetcher: typeof fetch = fetch): Promise<SiteIcon | null> {
  const origin = publicOrigin(url);
  if (!origin) return Promise.resolve(null);
  const cached = cache.get(origin);
  if (cached) return cached;
  const pending = fetchIcon(origin, fetcher).catch(() => null);
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(origin, pending);
  return pending;
}

/** Forget cached icons (tests). */
export function clearSiteIcons(): void {
  cache.clear();
}
