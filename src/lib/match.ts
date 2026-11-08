import type { ReadingRecord } from './types';

/**
 * True when `url` (normalized) falls under `prefix` (normalized).
 * The match stops at a path boundary, so "site.com/novel/abc" covers
 * "site.com/novel/abc/ch-1" and "site.com/novel/abc?page=2" but not "site.com/novel/abcdef".
 * A prefix with no path (just a host) covers the whole site.
 * Both arguments are normalizeUrl() output, which never ends in "/" (trailing slashes
 * are stripped and "/" inside a query is encoded as %2F).
 */
export function prefixMatches(url: string, prefix: string): boolean {
  if (!prefix || !url.startsWith(prefix)) return false;
  if (url.length === prefix.length) return true;
  const next = url[prefix.length];
  return next === '/' || next === '?';
}

/**
 * Every matchKey that could match `url`, longest first: the URL itself, then the URL cut
 * before each "/" or "?" (the same boundaries prefixMatches accepts).
 * "site.com/a/b?x=1" -> ["site.com/a/b?x=1", "site.com/a/b", "site.com/a", "site.com"].
 * Looking these up on the matchKey index finds a match without loading every record.
 */
export function candidateKeys(url: string): string[] {
  const keys = [url];
  for (let i = url.length - 1; i > 0; i--) {
    if (url[i] === '/' || url[i] === '?') keys.push(url.slice(0, i));
  }
  return keys;
}

/**
 * Pick the record for `url` from index lookups of its candidateKeys().
 * Same rules as findMatch: an exact record on the full URL wins, otherwise the
 * longest prefix record.
 */
export function chooseMatch(
  url: string,
  hitsByKey: ReadonlyMap<string, readonly ReadingRecord[]>,
): ReadingRecord | undefined {
  const exact = hitsByKey.get(url)?.find((r) => r.matchMode === 'exact');
  if (exact) return exact;
  for (const key of candidateKeys(url)) {
    const prefix = hitsByKey.get(key)?.find((r) => r.matchMode === 'prefix');
    if (prefix) return prefix;
  }
  return undefined;
}

/**
 * Reference implementation over a full list (used by tests to check chooseMatch).
 * An exact match wins over any prefix match; among prefix records the longest matchKey wins.
 */
export function findMatch(
  records: Iterable<ReadingRecord>,
  normalizedUrl: string,
): ReadingRecord | undefined {
  let best: ReadingRecord | undefined;
  for (const r of records) {
    if (r.matchMode === 'exact') {
      if (r.matchKey === normalizedUrl) return r;
    } else if (prefixMatches(normalizedUrl, r.matchKey)) {
      if (!best || r.matchKey.length > best.matchKey.length) best = r;
    }
  }
  return best;
}
