// Small subsequence matcher for the @ file and / command menus.

/**
 * How well `query` matches `candidate` as a path, 0 for not at all: the last segment starting with the query, then the
 * query anywhere as is, then its letters in order (more for runs and word starts). fuzzySearch ranks by this score.
 */
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

/**
 * The `limit` best of `entries` by score, best first; equal scores keep their order, as a stable sort would. Keeps only
 * the best `limit` sorted instead of sorting every match.
 */
export function topK<T extends { score: number }>(entries: Iterable<T>, limit: number): T[] {
  const best = new Best<T>(limit);
  for (const entry of entries) if (best.wants(entry.score)) best.add(entry);
  return best.done();
}

/** Lists past this many sort once at the end: inserting into a long sorted list costs more than one sort. */
const SORT_AT_END = 256;

/** The best `limit` entries offered to it, best first and ties in the order offered. */
class Best<T extends { score: number }> {
  private readonly entries: T[] = [];
  constructor(private readonly limit: number) {}

  /** Whether an entry scoring this would make it in (offer only those, to skip building the rest). */
  wants(score: number): boolean {
    const { entries, limit } = this;
    return limit > 0 && (limit > SORT_AT_END || entries.length < limit || score > entries[entries.length - 1]!.score);
  }

  /** Takes an entry `wants` agreed to, after every entry scoring as much. */
  add(entry: T): void {
    const { entries, limit } = this;
    if (limit > SORT_AT_END) {
      entries.push(entry);
      return;
    }
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (entries[middle]!.score >= entry.score) low = middle + 1;
      else high = middle;
    }
    entries.splice(low, 0, entry);
    if (entries.length > limit) entries.pop();
  }

  done(): T[] {
    const { entries, limit } = this;
    if (limit > SORT_AT_END) return entries.sort((a, b) => b.score - a.score).slice(0, limit);
    return entries;
  }
}

export type FuzzySearch<T> = (query: string, limit?: number) => T[];

/** A query fuzzySearch answered: the items it matched, how far their letter walks got, and its result. */
interface Answered<T> {
  q: string;
  /** The items whose key has the query as a subsequence, in list order. */
  hits: Int32Array;
  /** fuzzyScore's points for each hit's letters, before the length penalty. */
  points: Int32Array;
  /** Where each hit's last letter matched. */
  last: Int32Array;
  /** Where the query first appears as is in each hit, -1 where it does not. */
  inside: Int32Array;
  limit: number;
  found: T[];
}

/** The characters fuzzyScore counts as word starts after them: / - _ . and space. */
const isBoundary = (code: number): boolean => code === 47 || code === 45 || code === 95 || code === 46 || code === 32;

/**
 * fuzzyFilter over a fixed list, for a menu you type into: the same ranking, without redoing work per keystroke. The
 * keys are lowercased once; a query that extends an earlier one scans only the items that one matched, goes on with
 * each item's letter walk where it stopped and looks for itself as is only where that one was; deleting back to an
 * earlier query gives its result again. Build it once per list (useMemo on the list).
 */
export function fuzzySearch<T>(items: T[], key: (item: T) => string): FuzzySearch<T> {
  const keys = items.map((item) => key(item).toLowerCase());
  const bases = keys.map((k) => k.lastIndexOf("/") + 1);
  // The queries typed since the field was empty, each extending the one before.
  const typed: Answered<T>[] = [];
  return (query, limit = 50) => {
    if (!query) {
      typed.length = 0;
      return items.slice(0, limit);
    }
    const q = query.toLowerCase();
    while (typed.length && !q.startsWith(typed.at(-1)!.q)) typed.pop();
    const same = typed.at(-1);
    if (same?.q === q) {
      if (same.limit === limit) return same.found.slice();
      typed.pop();
    }
    // Walks go by code points: one that stopped inside a surrogate pair starts over.
    if (/[\ud800-\udbff]$/.test(typed.at(-1)?.q ?? "")) typed.length = 0;
    const from = typed.at(-1);
    const rest = from ? q.slice(from.q.length) : q;
    const size = from ? from.hits.length : keys.length;
    const hits = new Int32Array(size);
    const points = new Int32Array(size);
    const last = new Int32Array(size);
    const inside = new Int32Array(size);
    let count = 0;
    const best = new Best<{ index: number; score: number }>(limit);
    for (let at = 0; at < size; at++) {
      const index = from ? from.hits[at]! : at;
      const c = keys[index]!;
      // fuzzyScore's letter walk, from where the shorter query left it.
      let score = from ? from.points[at]! : 0;
      let previous = from ? from.last[at]! : -2;
      let i = 0;
      while (i < rest.length) {
        const wide = rest.codePointAt(i)! > 0xffff;
        const found = c.indexOf(wide ? rest.slice(i, i + 2) : rest[i]!, previous + 1);
        if (found === -1) break;
        score += found === previous + 1 ? 5 : 1;
        if (found === 0 || isBoundary(c.charCodeAt(found - 1))) score += 3;
        previous = found;
        i += wide ? 2 : 1;
      }
      if (i < rest.length) continue;
      // The query appears as is only where the one it extends did, and not before it.
      const contiguous = from && from.inside[at]! === -1 ? -1 : c.indexOf(q, from ? from.inside[at]! : 0);
      hits[count] = index;
      points[count] = score;
      last[count] = previous;
      inside[count] = contiguous;
      count++;
      const base = bases[index]!;
      let total: number;
      if (contiguous !== -1 && c.startsWith(q, base)) total = 1000 - (c.length - base);
      else total = contiguous === -1 ? score - c.length / 200 : 500 - contiguous - c.length / 100;
      if (total > 0 && best.wants(total)) best.add({ index, score: total });
    }
    const found = best.done().map((entry) => items[entry.index]!);
    const kept = (column: Int32Array) => column.slice(0, count);
    typed.push({ q, hits: kept(hits), points: kept(points), last: kept(last), inside: kept(inside), limit, found });
    return found.slice();
  };
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string, limit = 50): T[] {
  return query ? fuzzySearch(items, key)(query, limit) : items.slice(0, limit);
}
