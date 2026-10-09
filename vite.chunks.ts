import type { Rollup } from "vite";

/**
 * `output.manualChunks` for the window and the phone: the packages an entry imports statically (react, react-dom, marked,
 * dompurify) go to one `vendor` chunk. It changes only with a dependency update, so its hashed name survives app builds
 * and a phone's update leaves it in the caches (P42). Packages only lazy code reaches (shiki, its grammars) stay in
 * their own chunks, off the startup path.
 */
export const vendorChunk: Rollup.GetManualChunk = (id, { getModuleInfo }) => {
  if (!id.includes("/node_modules/")) return undefined;
  const seen = new Set<string>();
  const queue = [id];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const info = getModuleInfo(next);
    if (!info || seen.has(next)) continue;
    if (info.isEntry) return "vendor";
    seen.add(next);
    queue.push(...info.importers);
  }
  return undefined;
};
