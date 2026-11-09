import { describe, expect, it } from 'vitest';
import {
  candidateKeys,
  chooseMatch,
  findMatch,
  lookupTags,
  matchedEntry,
  prefixMatches,
  recordMatchTags,
} from '@/lib/match';
import type { ReadingRecord, UrlEntry } from '@/lib/types';
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

describe('candidateKeys', () => {
  it('lists the URL and every path / query boundary, longest first', () => {
    expect(candidateKeys('site.com/a/b?x=1&y=2')).toEqual(['site.com/a/b?x=1&y=2', 'site.com/a/b', 'site.com/a', 'site.com']);
  });
  it('handles a bare host and a host with a port', () => {
    expect(candidateKeys('site.com')).toEqual(['site.com']);
    expect(candidateKeys('localhost:8080/a')).toEqual(['localhost:8080/a', 'localhost:8080']);
  });
  it('covers exactly the prefixes prefixMatches accepts', () => {
    const url = 'site.com/novel/abc/ch-1?page=2';
    for (let i = 1; i <= url.length; i++) {
      const p = url.slice(0, i);
      expect(candidateKeys(url).includes(p)).toBe(prefixMatches(url, p));
    }
  });
});

/** What the multiEntry matchKeys index returns for each lookup tag. */
function indexHits(records: ReadingRecord[], url: string) {
  return new Map(lookupTags(url).map((t) => [t, records.filter((r) => recordMatchTags(r).includes(t))]));
}

describe('chooseMatch (index lookup) agrees with findMatch (full scan)', () => {
  const fixed = [
    rec({ matchMode: 'prefix', matchKey: 'site.com' }),
    rec({ matchMode: 'prefix', matchKey: 'site.com/novel/abc' }),
    rec({ matchMode: 'exact', matchKey: 'site.com/novel/abc/ch-5' }),
    rec({ matchMode: 'prefix', matchKey: 'site.com/novel/abc/ch-5' }),
    rec({ matchMode: 'exact', matchKey: 'site.com/novel/abc?page=2' }),
  ];

  it.each([
    'site.com',
    'site.com/about',
    'site.com/novel/abc',
    'site.com/novel/abc/ch-1',
    'site.com/novel/abc/ch-5',
    'site.com/novel/abc/ch-5/comments',
    'site.com/novel/abc?page=2',
    'site.com/novel/abc?page=3',
    'site.com/novel/abcdef',
    'other.com/x',
  ])('%s', (url) => {
    expect(chooseMatch(url, indexHits(fixed, url))).toBe(findMatch(fixed, url));
  });

  it('on random record sets', () => {
    // Small deterministic PRNG so failures are reproducible.
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const segs = ['a', 'b', 'ab', 'c'];
    const randomKey = () => {
      let k = ['x.com', 'y.com'][rand(2)]!;
      for (let d = rand(4); d > 0; d--) k += `/${segs[rand(segs.length)]}`;
      if (rand(4) === 0) k += `?p=${rand(3)}`;
      return k;
    };
    for (let round = 0; round < 300; round++) {
      // Distinct matchKeys per mode so the expected winner is unambiguous.
      const seen = new Set<string>();
      const records: ReadingRecord[] = [];
      for (let i = rand(12); i > 0; i--) {
        const matchMode = rand(2) ? 'exact' : 'prefix';
        const matchKey = randomKey();
        if (seen.has(matchMode + matchKey)) continue;
        seen.add(matchMode + matchKey);
        // Some records get extra URLs (any mode); keys stay distinct per mode across all records.
        const otherUrls: UrlEntry[] = [];
        for (let k = rand(3); k > 0; k--) {
          const mode = rand(2) ? 'exact' : 'prefix';
          const key = randomKey();
          if (seen.has(mode + key)) continue;
          seen.add(mode + key);
          otherUrls.push({ url: `https://${key}`, matchMode: mode, matchKey: key });
        }
        records.push(rec({ matchMode, matchKey, otherUrls }));
      }
      const url = randomKey();
      expect(chooseMatch(url, indexHits(records, url))).toBe(findMatch(records, url));
    }
  });
});

describe('records with several URLs', () => {
  const r = rec({
    id: 'multi',
    matchMode: 'exact',
    matchKey: 'a.com/post',
    otherUrls: [
      { url: 'https://mirror.org/post', matchMode: 'exact', matchKey: 'mirror.org/post' },
      { url: 'https://b.com/series', matchMode: 'prefix', matchKey: 'b.com/series' },
    ],
  });
  const other = rec({ id: 'other', matchMode: 'prefix', matchKey: 'b.com' });

  it('matches on any of its URLs', () => {
    for (const url of ['a.com/post', 'mirror.org/post', 'b.com/series/ch-2']) {
      expect(findMatch([r, other], url)).toBe(r);
      expect(chooseMatch(url, indexHits([r, other], url))).toBe(r);
    }
    expect(findMatch([r, other], 'b.com/elsewhere')).toBe(other);
    expect(findMatch([r], 'c.com')).toBeUndefined();
  });

  it('reports which URL matched', () => {
    expect(matchedEntry(r, 'mirror.org/post')?.url).toBe('https://mirror.org/post');
    expect(matchedEntry(r, 'b.com/series/ch-9')).toMatchObject({ matchMode: 'prefix', matchKey: 'b.com/series' });
    expect(matchedEntry(r, 'a.com/post')).toMatchObject({ matchMode: 'exact' });
    expect(matchedEntry(r, 'nowhere.com')).toBeUndefined();
  });

  it('indexes one tag per distinct URL', () => {
    expect(recordMatchTags(r).sort()).toEqual(['e|a.com/post', 'e|mirror.org/post', 'p|b.com/series']);
  });
});
