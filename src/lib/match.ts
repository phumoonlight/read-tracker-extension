import { urlEntries } from './records';
import type { MatchMode, ReadingRecord, UrlEntry } from './types';

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
 */
export function candidateKeys(url: string): string[] {
  const keys = [url];
  for (let i = url.length - 1; i > 0; i--) {
    if (url[i] === '/' || url[i] === '?') keys.push(url.slice(0, i));
  }
  return keys;
}

/**
 * Index key for one URL entry: mode and key together ("e|site.com/a", "p|site.com/novel"),
 * so one multiEntry index over all of a record's URLs answers both kinds of lookup.
 */
export const matchTag = (mode: MatchMode, key: string) => `${mode === 'exact' ? 'e' : 'p'}|${key}`;

/** All index tags of a record (one per URL). */
export const recordMatchTags = (r: ReadingRecord) => [
  ...new Set(urlEntries(r).map((e) => matchTag(e.matchMode, e.matchKey))),
];

/** The tags to look up for a page: its exact tag, then a prefix tag per candidate key (longest first). */
export function lookupTags(url: string): string[] {
  return [matchTag('exact', url), ...candidateKeys(url).map((k) => matchTag('prefix', k))];
}

/**
 * Pick the record for `url` from index lookups of lookupTags(url).
 * Same rules as findMatch: an exact URL wins, otherwise the longest prefix.
 */
export function chooseMatch(
  url: string,
  hitsByTag: ReadonlyMap<string, readonly ReadingRecord[]>,
): ReadingRecord | undefined {
  for (const tag of lookupTags(url)) {
    const hit = hitsByTag.get(tag)?.[0];
    if (hit) return hit;
  }
  return undefined;
}

/** Which of a record's URLs matches `url` (exact first, then the longest prefix), if any. */
export function matchedEntry(record: ReadingRecord, url: string): UrlEntry | undefined {
  const entries = urlEntries(record);
  const exact = entries.find((e) => e.matchMode === 'exact' && e.matchKey === url);
  if (exact) return exact;
  let best: UrlEntry | undefined;
  for (const e of entries) {
    if (e.matchMode === 'prefix' && prefixMatches(url, e.matchKey) && (!best || e.matchKey.length > best.matchKey.length)) {
      best = e;
    }
  }
  return best;
}

/**
 * Reference implementation over a full list (used by tests to check chooseMatch).
 * An exact URL on any record wins over any prefix; among prefixes the longest wins.
 */
export function findMatch(
  records: Iterable<ReadingRecord>,
  normalizedUrl: string,
): ReadingRecord | undefined {
  let best: { record: ReadingRecord; length: number } | undefined;
  for (const r of records) {
    const e = matchedEntry(r, normalizedUrl);
    if (!e) continue;
    if (e.matchMode === 'exact') return r;
    if (!best || e.matchKey.length > best.length) best = { record: r, length: e.matchKey.length };
  }
  return best?.record;
}
