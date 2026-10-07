// ⌘K search: ranks chats, cards, pages, settings, projects and commands for one query, grouped into sections.

import { fuzzyScore } from "./fuzzy";

export type PaletteGroup = "Chats" | "Cards" | "Pages" | "Settings" | "Projects" | "Commands";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  title: string;
  /** Second line of matching text (a chat's project, a card's column), weaker than the title. */
  detail?: string;
  /** Matched too but not shown (a settings section's topics, a card's tags). */
  keywords?: string;
  /** Last activity: newer chats rank first among equal matches and lead the list before you type. */
  time?: number;
  run: () => void;
}

export interface PaletteSection<T extends PaletteItem = PaletteItem> {
  group: PaletteGroup;
  items: T[];
}

/** Rows each group shows before you type; groups missing here wait for a search. */
const IDLE_LIMITS: Partial<Record<PaletteGroup, number>> = { Chats: 8, Pages: 10, Commands: 20 };
/** Rows each group shows for a search. */
const SEARCH_LIMITS: Record<PaletteGroup, number> = { Chats: 8, Cards: 6, Pages: 10, Settings: 5, Projects: 5, Commands: 8 };
/** The order of the groups before you type; a search orders them by their best match. */
const ORDER: PaletteGroup[] = ["Chats", "Pages", "Commands", "Cards", "Settings", "Projects"];

/**
 * How well `query` matches an item, 0 for not at all. The whole query against the title counts most; failing that,
 * every word must match the title, detail or keywords, and the item scores its words' mean (below the same match of
 * the whole query). Each word scores its best field; detail and keywords weigh less, and only count where the word
 * appears as is (a subsequence spread over a long keyword list is noise). A feature's keywords are its synonyms
 * ("theme" for Appearance), so they weigh nearly as much as its title.
 * Features (pages, settings, commands) beat chats and cards that match as well, and recent activity breaks ties;
 * neither lifts an item over a better kind of match (a title's start over a word's, say).
 */
export function scoreItem(query: string, item: PaletteItem, now = Date.now()): number {
  const q = query.trim();
  if (!q) return 1;
  let score = textScore(q, item.title);
  if (score <= 0) {
    const words = q.split(/\s+/);
    const keywords = FEATURES.has(item.group) ? 0.9 : 0.4;
    score = 0;
    for (const word of words) {
      const best = Math.max(textScore(word, item.title), contained(word, item.detail) * 0.6, contained(word, item.keywords) * keywords);
      if (best <= 0) return 0;
      score += best;
    }
    score = (score / words.length) * (words.length > 1 ? 0.8 : 1);
  }
  return score + (FEATURES.has(item.group) ? FEATURE_BONUS : 0) + recency(item.time, now);
}

const FEATURES = new Set<PaletteGroup>(["Pages", "Settings", "Commands"]);
/** More than recency and title length can add (10 and a few points), less than the gap between kinds of match. */
const FEATURE_BONUS = 25;

/**
 * `query` in a title or label: the whole of it, at its start, then at the start of a word, then anywhere, then as a
 * subsequence whose letters sit close together (scattered letters of a long chat title are noise). Not fuzzyScore
 * alone, which reads text as a path: a chat title with a URL in it would match at its last segment.
 */
export function textScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 1100;
  const at = t.indexOf(q);
  if (at === 0) return 1000 - t.length / 100;
  if (at > 0) {
    const word = t.search(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(q)}`, "u"));
    if (word !== -1) return 800 - word / 10 - t.length / 100;
    return 500 - at / 10 - t.length / 100;
  }
  const hit = subsequence(q, t);
  const first = hit?.[0];
  if (!hit || first === undefined) return 0;
  return fuzzyScore(q, t.slice(first, hit.at(-1)! + 1).replaceAll("/", " ")) - first / 100;
}

/** The positions of `q`'s characters in `t`, in the tightest window up to 3× as long as `q`; undefined if none. */
function subsequence(q: string, t: string): number[] | undefined {
  let best: number[] | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (let start = t.indexOf(q[0] ?? ""); start !== -1 && q; start = t.indexOf(q[0]!, start + 1)) {
    const positions = [start];
    for (const char of q.slice(1)) {
      const found = t.indexOf(char, positions.at(-1)! + 1);
      if (found === -1) return best;
      positions.push(found);
    }
    const span = positions.at(-1)! - start + 1;
    if (span <= q.length * 3 && (!best || span < bestSpan)) {
      best = positions;
      bestSpan = span;
    }
  }
  return best;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const contained = (word: string, text = ""): number => (text.toLowerCase().includes(word.toLowerCase()) ? textScore(word, text) : 0);

/** Up to 10 points for activity today, fading over a month. */
const recency = (time: number | undefined, now: number): number => {
  if (time === undefined) return 0;
  const days = Math.max(0, (now - time) / 86_400_000);
  return 10 * Math.max(0, 1 - days / 30);
};

/** The sections for `query`: before you type, recent chats then pages and commands; for a search, the best group first. */
export function rankPalette<T extends PaletteItem>(items: T[], query: string, now = Date.now()): PaletteSection<T>[] {
  const q = query.trim();
  const byGroup = new Map<PaletteGroup, { item: T; score: number }[]>();
  for (const item of items) {
    const score = scoreItem(q, item, now);
    if (score <= 0) continue;
    const list = byGroup.get(item.group) ?? [];
    list.push({ item, score });
    byGroup.set(item.group, list);
  }
  const sections: (PaletteSection<T> & { best: number })[] = [];
  for (const group of ORDER) {
    const list = byGroup.get(group);
    const limit = q ? SEARCH_LIMITS[group] : (IDLE_LIMITS[group] ?? 0);
    if (!list || limit === 0) continue;
    // Before you type: chats newest first (time unknown means just started), the rest as given.
    if (q) list.sort((a, b) => b.score - a.score);
    else if (group === "Chats") list.sort((a, b) => (b.item.time ?? Number.POSITIVE_INFINITY) - (a.item.time ?? Number.POSITIVE_INFINITY));
    sections.push({ group, items: list.slice(0, limit).map((entry) => entry.item), best: list[0]?.score ?? 0 });
  }
  if (q) sections.sort((a, b) => b.best - a.best);
  return sections.map(({ group, items }) => ({ group, items }));
}

/**
 * The [start, end) ranges of `text` to highlight for `query`: the whole query where it appears as is, else each
 * word's run of characters, else the characters of a subsequence match.
 */
export function matchRanges(query: string, text: string): [number, number][] {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return [];
  const whole = t.indexOf(q);
  if (whole !== -1) return [[whole, whole + q.length]];
  const ranges: [number, number][] = [];
  const words = q.split(/\s+/);
  if (words.length > 1) {
    for (const word of words) {
      const at = t.indexOf(word);
      if (at !== -1) ranges.push([at, at + word.length]);
    }
    return merge(ranges);
  }
  return merge((subsequence(q, t) ?? []).map((at): [number, number] => [at, at + 1]));
}

const merge = (ranges: [number, number][]): [number, number][] => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push([...range]);
  }
  return out;
};
