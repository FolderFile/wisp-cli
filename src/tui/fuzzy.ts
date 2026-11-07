/**
 * Subsequence fuzzy match. Higher is better; null = no match. Rewards
 * consecutive runs, matches at word/path boundaries, and basename hits.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const base = t.lastIndexOf('/') + 1;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    let s = 1;
    if (found === prev + 1) s += 5; // consecutive
    const before = t[found - 1];
    if (found === 0 || before === '/' || before === '-' || before === '_' || before === '.' || before === ' ') s += 4;
    if (found >= base) s += 2; // in the file name, not the directory
    score += s;
    prev = found;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 10;
  if (t.slice(base).startsWith(q)) score += 8;
  return score - t.length * 0.05; // prefer shorter paths
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string, limit = 50): T[] {
  if (!query) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, key(item));
    if (s !== null) scored.push({ item, score: s });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}
