export const params = new URLSearchParams(location.search);
export const file = params.get("f") ?? "";
const w = window as any;
w.__marks = {} as Record<string, number>;
export function mark(name: string) { w.__marks[name] ??= Math.round(performance.now()); }
export async function loadBytes(): Promise<Uint8Array> {
  const r = await fetch("/files/" + file);
  if (!r.ok) throw new Error("fetch " + r.status);
  const b = new Uint8Array(await r.arrayBuffer());
  mark("bytes");
  return b;
}
w.__lt = { max: 0, total: 0, count: 0, over200: 0 };
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { const d = Math.round(e.duration); w.__lt.max = Math.max(w.__lt.max, d); w.__lt.total += d; w.__lt.count++; if (d > 200) w.__lt.over200++; } })
    .observe({ type: "longtask", buffered: true });
} catch {}
export function done(extra: Record<string, unknown> = {}) { mark("done"); w.__result = { ok: true, marks: w.__marks, longTasks: { ...w.__lt }, ...extra }; }
/** Poll a page counter until it is stable for `quietMs`, then call done. */
export function settle(count: () => number, extra: () => Record<string, unknown> = () => ({}), quietMs = 1500) {
  let last = -1, since = performance.now();
  const tick = () => {
    const n = count();
    if (n !== last) { last = n; since = performance.now(); w.__marks.settled = Math.round(since); }
    if (performance.now() - since >= quietMs) return done({ pages: n, ...extra() });
    setTimeout(tick, 100);
  };
  tick();
}
export function fail(e: unknown) { w.__result = { ok: false, error: String((e as any)?.stack ?? e), marks: w.__marks }; }
addEventListener("error", (e) => { w.__errors = [...(w.__errors ?? []), String(e.message)]; });
addEventListener("unhandledrejection", (e) => { w.__errors = [...(w.__errors ?? []), String((e as any).reason?.stack ?? (e as any).reason)]; });
