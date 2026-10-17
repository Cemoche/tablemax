/**
 * Fuzzy score of `query` against `text`: 0 = no match, higher is better. Prefix beats
 * substring beats in-order subsequence; shorter text wins within a tier. Cheap enough to
 * score thousands of names per keystroke.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const s = text.toLowerCase();
  if (s === q) return 3000;
  const at = s.indexOf(q);
  if (at === 0) return 2000 - s.length;
  if (at > 0) return 1500 - at * 10 - s.length;
  let from = 0;
  let span = 0;
  let first = -1;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return 0;
    if (first < 0) first = i;
    from = i + 1;
    span = i - first + 1;
  }
  return Math.max(1, 1000 - (span - q.length) * 10 - first - s.length * 0.1);
}

/** The best `limit` items scoring above 0, best first (stable for ties). */
export function rank<T>(items: readonly T[], query: string, text: (item: T) => string, limit: number) {
  const scored: { item: T; score: number; index: number }[] = [];
  for (let index = 0; index < items.length; index++) {
    const score = fuzzyScore(query, text(items[index]));
    if (score > 0) scored.push({ item: items[index], score, index });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return { items: scored.slice(0, limit).map((x) => x.item), total: scored.length };
}
