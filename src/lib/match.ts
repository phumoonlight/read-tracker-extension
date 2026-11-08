import type { ReadingRecord } from './types';

/**
 * True when `url` (normalized) falls under `prefix` (normalized).
 * The match stops at a path boundary, so "site.com/novel/abc" covers
 * "site.com/novel/abc/ch-1" and "site.com/novel/abc?page=2" but not "site.com/novel/abcdef".
 * A prefix with no path (just a host) covers the whole site.
 */
export function prefixMatches(url: string, prefix: string): boolean {
  if (!prefix || !url.startsWith(prefix)) return false;
  if (url.length === prefix.length) return true;
  if (prefix.endsWith('/')) return true;
  const next = url[prefix.length];
  return next === '/' || next === '?';
}

/**
 * Find the record for a normalized URL. An exact match wins over any prefix match;
 * among prefix records the longest matchKey wins.
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
