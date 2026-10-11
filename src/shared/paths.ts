// Paths carried by the host protocol and persisted state. A phone/browser can be on a different OS from the host:
// do not use the client's platform, URL parsing or Node's platform-dependent path.isAbsolute here.

/** An absolute POSIX path, Windows drive path or explicit UNC share. This checks syntax, not existence, identity or
 * confinement: filesystem callers must still resolve/check paths on the host. Preserve spelling in persisted keys. */
export function isAbsoluteHostPath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0")) return false;
  // Device namespaces (both separator spellings) are not project paths.
  if (/^[\\/]{2}[?.][\\/]/.test(value)) return false;
  if (value.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  // A single backslash is relative to the current drive; UNC needs a server and share.
  if (!value.startsWith("\\\\")) return false;
  const [server, share] = value.slice(2).split(/[\\/]/);
  return Boolean(server && ![".", "..", "?"].includes(server) && share && ![".", ".."].includes(share));
}
