// Pure viewport model shared by main, renderer and the pi extension. No Electron or DOM imports.

export const UA_PROFILES = ["native", "iphone", "android", "ipad"] as const;
export type UaProfileId = (typeof UA_PROFILES)[number];

export interface ViewportSpec {
  /** CSS px */
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  touch: boolean;
  /** User agent profile; "native" keeps Electron's own UA. */
  userAgent: UaProfileId;
  label: string;
  source: "user" | "agent";
}

export interface ViewportRequest {
  preset?: string;
  width?: number;
  height?: number;
  /** '9:19.5', '16/9' or a number (width / height). Needs one known edge. */
  aspect?: string | number;
  dpr?: number;
  mobile?: boolean;
  orientation?: "portrait" | "landscape";
  /** Keeps a mobile device's UA profile across edits without a preset (the Dimensions bar sends the current one). */
  userAgent?: UaProfileId;
  source?: "user" | "agent";
}

export interface DevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  userAgent: UaProfileId;
}

export const VIEWPORT_LIMITS = { minEdge: 200, maxEdge: 3840, minDpr: 1, maxDpr: 4 } as const;

const DEFAULT_SIZE = { width: 1280, height: 800 };

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "laptop", label: "Laptop", width: 1440, height: 900, dpr: 2, mobile: false, userAgent: "native" },
  { id: "desktop", label: "Desktop", width: 1920, height: 1080, dpr: 1, mobile: false, userAgent: "native" },
  { id: "iphone-15", label: "iPhone 15", width: 393, height: 852, dpr: 3, mobile: true, userAgent: "iphone" },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, dpr: 2, mobile: true, userAgent: "iphone" },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915, dpr: 2.625, mobile: true, userAgent: "android" },
  { id: "ipad", label: "iPad", width: 820, height: 1180, dpr: 2, mobile: true, userAgent: "ipad" },
];

export function findPreset(id: string): DevicePreset | undefined {
  const key = id.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return DEVICE_PRESETS.find((p) => p.id === key || p.label.toLowerCase() === id.trim().toLowerCase());
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const clampEdge = (n: number) => clamp(Math.round(n), VIEWPORT_LIMITS.minEdge, VIEWPORT_LIMITS.maxEdge);
const clampDpr = (n: number) => Math.round(clamp(n, VIEWPORT_LIMITS.minDpr, VIEWPORT_LIMITS.maxDpr) * 1000) / 1000;

function finite(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a finite number, got ${JSON.stringify(v)}`);
  return v;
}

/** Parses '9:19.5', '16/9', '0.5' or a number into width / height. */
export function parseAspect(aspect: string | number): number {
  let ratio: number;
  if (typeof aspect === "number") ratio = aspect;
  else {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:[:/x]\s*(\d+(?:\.\d+)?))?\s*$/.exec(aspect);
    if (!m) throw new Error(`aspect "${aspect}" is not understood; use '9:19.5', '16/9' or a number like 0.46`);
    ratio = m[2] === undefined ? Number(m[1]) : Number(m[1]) / Number(m[2]);
  }
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`aspect must be positive, got ${JSON.stringify(aspect)}`);
  return ratio;
}

export function resolveViewport(request: ViewportRequest): ViewportSpec {
  let base: DevicePreset | undefined;
  if (request.preset !== undefined) {
    base = findPreset(request.preset);
    if (!base) throw new Error(`unknown preset "${request.preset}"; known: ${DEVICE_PRESETS.map((p) => p.id).join(", ")}`);
  }
  const hasW = request.width !== undefined;
  const hasH = request.height !== undefined;
  if (hasW) finite("width", request.width);
  if (hasH) finite("height", request.height);

  let width: number;
  let height: number;
  if (request.aspect !== undefined) {
    if (hasW && hasH) throw new Error("aspect needs exactly one of width or height, not both");
    if (!hasW && !hasH) throw new Error("aspect needs width or height");
    const ratio = parseAspect(request.aspect);
    if (hasW) {
      width = request.width!;
      height = width / ratio;
    } else {
      height = request.height!;
      width = height * ratio;
    }
  } else {
    const fallback = base ?? DEFAULT_SIZE;
    width = hasW ? request.width! : fallback.width;
    height = hasH ? request.height! : fallback.height;
  }
  width = clampEdge(width);
  height = clampEdge(height);

  if (request.orientation !== undefined) {
    if (request.orientation !== "portrait" && request.orientation !== "landscape") {
      throw new Error(`orientation must be 'portrait' or 'landscape', got ${JSON.stringify(request.orientation)}`);
    }
    const wrong = request.orientation === "portrait" ? width > height : height > width;
    if (wrong) [width, height] = [height, width];
  }

  const dpr = clampDpr(request.dpr !== undefined ? finite("dpr", request.dpr) : (base?.dpr ?? 1));
  const mobile = request.mobile ?? base?.mobile ?? false;
  const kept = request.userAgent;
  if (kept !== undefined && !(UA_PROFILES as readonly unknown[]).includes(kept)) {
    throw new Error(`userAgent must be one of ${UA_PROFILES.join(", ")}, got ${JSON.stringify(kept)}`);
  }
  let userAgent: UaProfileId = "native";
  if (mobile) userAgent = base?.mobile ? base.userAgent : kept && kept !== "native" ? kept : width >= 600 ? "ipad" : "iphone";

  const sized = !base || hasW || hasH || request.aspect !== undefined || request.orientation !== undefined;
  const label = base && !sized && dpr === base.dpr && mobile === base.mobile ? base.label : "Custom";
  return { width, height, dpr, mobile, touch: mobile, userAgent, label, source: request.source ?? "user" };
}

export function rotateViewport(spec: ViewportSpec): ViewportSpec {
  return { ...spec, width: spec.height, height: spec.width };
}

export interface FitOptions {
  /** User-chosen zoom; used as is, may exceed 1. Otherwise the viewport is scaled down to fit. */
  zoom?: number;
}

export interface ViewportFit {
  /** Native view bounds relative to the pane's top-left, centred. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Value for Emulation.setDeviceMetricsOverride `scale`. */
  scale: number;
}

export function fitViewport(
  pane: { width: number; height: number },
  spec: Pick<ViewportSpec, "width" | "height">,
  opts: FitOptions = {},
): ViewportFit {
  let scale: number;
  if (opts.zoom !== undefined && Number.isFinite(opts.zoom) && opts.zoom > 0) scale = opts.zoom;
  else scale = Math.min(1, Math.max(0, pane.width) / spec.width, Math.max(0, pane.height) / spec.height);
  scale = Math.max(scale, 0.01);
  const width = Math.max(1, Math.round(spec.width * scale));
  const height = Math.max(1, Math.round(spec.height * scale));
  return { bounds: { x: Math.round((pane.width - width) / 2), y: Math.round((pane.height - height) / 2), width, height }, scale };
}

/** Emulated CSS px to the view pixels CDP Input.dispatchMouseEvent expects. */
export function toInputCoords(x: number, y: number, scale: number): { x: number; y: number } {
  return { x: x * scale, y: y * scale };
}

export interface UserAgentProfile {
  userAgent: string;
  platform: string;
  metadata: {
    brands: { brand: string; version: string }[];
    fullVersionList: { brand: string; version: string }[];
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
  /** Request headers Electron does not send itself; inject them for emulated tabs. */
  headers: Record<string, string>;
}

/** Null for "native". `chromiumVersion` is the running process.versions.chrome, e.g. "152.0.7778.96". */
export function userAgentFor(profile: UaProfileId, chromiumVersion: string): UserAgentProfile | null {
  if (profile === "native") return null;
  const full = /^\d+(\.\d+){3}$/.test(chromiumVersion) ? chromiumVersion : `${chromiumVersion.split(".")[0] || "0"}.0.0.0`;
  const major = full.split(".")[0] ?? "0";
  const reduced = `${major}.0.0.0`;
  let userAgent: string;
  let platform: string;
  let platformVersion: string;
  let model: string;
  switch (profile) {
    case "iphone":
      userAgent = `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${reduced} Mobile/15E148 Safari/604.1`;
      platform = "iOS";
      platformVersion = "18.0.0";
      model = "iPhone";
      break;
    case "ipad":
      userAgent = `Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${reduced} Mobile/15E148 Safari/604.1`;
      platform = "iOS";
      platformVersion = "18.0.0";
      model = "iPad";
      break;
    case "android":
      userAgent = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reduced} Mobile Safari/537.36`;
      platform = "Android";
      platformVersion = "14.0.0";
      model = "Pixel 8";
      break;
  }
  const brands = [
    { brand: "Not.A/Brand", version: "99" },
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
  ];
  return {
    userAgent,
    platform: profile === "android" ? "Linux armv81" : model,
    metadata: {
      brands,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Not.A/Brand" ? "99.0.0.0" : full })),
      fullVersion: full,
      platform,
      platformVersion,
      architecture: "",
      model,
      mobile: true,
      bitness: "",
      wow64: false,
    },
    headers: {
      "Sec-CH-UA": brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", "),
      "Sec-CH-UA-Mobile": "?1",
      "Sec-CH-UA-Platform": `"${platform}"`,
    },
  };
}
