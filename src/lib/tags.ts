import { normalizeTags } from './records';

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
    .filter(([t]) => t.includes(q) && !chosen.includes(t))
    .sort(([a, ac], [b, bc]) => {
      const ap = a.startsWith(q) ? 0 : 1;
      const bp = b.startsWith(q) ? 0 : 1;
      return ap - bp || bc - ac || a.localeCompare(b);
    })
    .slice(0, limit)
    .map(([t]) => t);
}

/** Add tags typed or pasted as text ("a, b") to a list: normalized, no duplicates, order kept. */
export function addTagText(current: readonly string[], text: string): string[] {
  return normalizeTags([...current, ...text.split(',')]);
}
