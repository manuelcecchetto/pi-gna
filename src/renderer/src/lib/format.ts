export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)}s`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Whole seconds for "Working for 13m 16s" style headers. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

const digits = (value: number) => (value < 10 ? String(Number(value.toPrecision(2))) : String(Math.round(value)));

/** "7", "0.25", "13", "999", "1.5k", "1.4M", "2B": at most two significant digits below 10, whole numbers above. */
export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (const [size, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (abs >= size * 0.9995) return sign + digits(abs / size) + unit;
  }
  return sign + digits(abs);
}

export function formatCost(dollars: number): string {
  return dollars < 0.01 && dollars > 0 ? "<$0.01" : `$${dollars.toFixed(2)}`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function tildify(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** "512 B", "1.5 KB", "142 MB", "2.7 GB": decimal units, two significant digits below 10. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${digits(value)} ${units[unit]}`;
}

/** Codex-style stamps: "5:22 PM" today, "Yesterday 5:22 PM", "Thursday 5:23 PM" this week, else "Sep 12, 5:22 PM". */
export function formatStamp(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}
