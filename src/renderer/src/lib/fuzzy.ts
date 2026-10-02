// Small subsequence matcher for the @ file and / command menus.

export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const base = c.slice(c.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 1000 - base.length;
  const contiguous = c.indexOf(q);
  if (contiguous !== -1) return 500 - contiguous - c.length / 100;
  let score = 0;
  let position = 0;
  let previous = -2;
  for (const char of q) {
    const found = c.indexOf(char, position);
    if (found === -1) return 0;
    score += found === previous + 1 ? 5 : 1;
    if (found === 0 || "/-_. ".includes(c[found - 1] ?? "")) score += 3;
    previous = found;
    position = found + 1;
  }
  return score - c.length / 200;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string, limit = 50): T[] {
  if (!query) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, key(item));
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}
