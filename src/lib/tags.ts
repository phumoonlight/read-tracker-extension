import { hasTag, normalizeTags, tagKey } from './records';

/**
 * Existing tags to suggest for what's being typed: tags containing `draft` (case-insensitive),
 * not already chosen. Tags that start with it come first, then by how many records use them,
 * then alphabetically. `all` is [tag, count] pairs.
 */
export function suggestTags(
  all: readonly (readonly [string, number])[],
  draft: string,
  chosen: readonly string[],
  limit = 6,
): string[] {
  const q = draft.trim().toLowerCase();
  if (!q) return [];
  return all
    .filter(([t]) => tagKey(t).includes(q) && !hasTag(chosen, t))
    .sort(([a, ac], [b, bc]) => {
      const ap = tagKey(a).startsWith(q) ? 0 : 1;
      const bp = tagKey(b).startsWith(q) ? 0 : 1;
      return ap - bp || bc - ac || a.localeCompare(b);
    })
    .slice(0, limit)
    .map(([t]) => t);
}

/** Add tags typed or pasted as text ("a, b") to a list: normalized, no duplicates, order kept. */
export function addTagText(current: readonly string[], text: string): string[] {
  return normalizeTags([...current, ...text.split(',')]);
}

/**
 * [tag, count] pairs for tags as they appear on records, grouped ignoring case ("Manga" and
 * "manga" count together). Each group is shown in its most used spelling (ties: the first seen).
 */
export function countTags(tags: Iterable<string>): [string, number][] {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const t of tags) {
    const g = groups.get(tagKey(t)) ?? { count: 0, spellings: new Map<string, number>() };
    g.count++;
    g.spellings.set(t, (g.spellings.get(t) ?? 0) + 1);
    groups.set(tagKey(t), g);
  }
  return [...groups.values()].map((g) => {
    let best = '';
    let bestN = 0;
    for (const [s, n] of g.spellings) if (n > bestN) [best, bestN] = [s, n];
    return [best, g.count];
  });
}
