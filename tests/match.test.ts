import { describe, expect, it } from 'vitest';
import { findMatch, prefixMatches } from '@/lib/match';
import { normalizeUrl } from '@/lib/url';
import { rec } from './fixtures';

describe('prefixMatches', () => {
  it('matches the prefix itself and pages under it', () => {
    expect(prefixMatches('site.com/novel/abc', 'site.com/novel/abc')).toBe(true);
    expect(prefixMatches('site.com/novel/abc/ch-1', 'site.com/novel/abc')).toBe(true);
    expect(prefixMatches('site.com/novel/abc/vol-2/ch-9', 'site.com/novel/abc')).toBe(true);
    expect(prefixMatches('site.com/novel/abc?page=3', 'site.com/novel/abc')).toBe(true);
  });

  it('stops at path boundaries', () => {
    expect(prefixMatches('site.com/novel/abcdef', 'site.com/novel/abc')).toBe(false);
    expect(prefixMatches('site.com/novel', 'site.com/novel/abc')).toBe(false);
  });

  it('treats a host-only prefix as the whole site, but not other hosts', () => {
    expect(prefixMatches('site.com/anything', 'site.com')).toBe(true);
    expect(prefixMatches('site.community/x', 'site.com')).toBe(false);
  });

  it('never matches an empty prefix', () => {
    expect(prefixMatches('site.com', '')).toBe(false);
  });
});

describe('findMatch', () => {
  const series = rec({ matchMode: 'prefix', matchKey: 'site.com/novel/abc' });
  const site = rec({ matchMode: 'prefix', matchKey: 'site.com' });
  const chapter = rec({ matchMode: 'exact', matchKey: 'site.com/novel/abc/ch-5' });
  const other = rec({ matchMode: 'exact', matchKey: 'other.com/post' });
  const all = [site, series, chapter, other];

  it('returns undefined when nothing matches', () => {
    expect(findMatch(all, 'nowhere.org/x')).toBeUndefined();
    expect(findMatch([], 'site.com')).toBeUndefined();
  });

  it('matches exact records on the full normalized URL only', () => {
    expect(findMatch([other], 'other.com/post')).toBe(other);
    expect(findMatch([other], 'other.com/post/2')).toBeUndefined();
  });

  it('prefers the longest matching prefix', () => {
    expect(findMatch(all, 'site.com/novel/abc/ch-1')).toBe(series);
    expect(findMatch([series, site], 'site.com/novel/abc/ch-1')).toBe(series);
    expect(findMatch(all, 'site.com/about')).toBe(site);
  });

  it('prefers an exact match over any prefix match', () => {
    expect(findMatch(all, 'site.com/novel/abc/ch-5')).toBe(chapter);
    expect(findMatch([chapter, series, site].reverse(), 'site.com/novel/abc/ch-5')).toBe(chapter);
  });

  it('works end to end with normalizeUrl', () => {
    const key = normalizeUrl('https://www.SITE.com/novel/abc/ch-2/?utm_source=x#c')!;
    expect(findMatch(all, key)).toBe(series);
  });
});
