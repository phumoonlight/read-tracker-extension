import { describe, expect, it } from 'vitest';
import { hueFor, isTrackingParam, normalizeUrl, siteLabel, suggestPrefix } from '@/lib/url';

describe('normalizeUrl', () => {
  it.each([
    ['lowercases the host', 'https://Example.COM/Path', 'example.com/Path'],
    ['strips www.', 'https://www.example.com/a', 'example.com/a'],
    ['only strips a leading www.', 'https://wwwx.example.com/a', 'wwwx.example.com/a'],
    ['keeps other subdomains', 'https://blog.example.com/a', 'blog.example.com/a'],
    ['drops the hash', 'https://example.com/a#section-2', 'example.com/a'],
    ['drops the trailing slash', 'https://example.com/a/b/', 'example.com/a/b'],
    ['drops repeated trailing slashes', 'https://example.com/a//', 'example.com/a'],
    ['reduces the root to the host', 'https://example.com/', 'example.com'],
    ['treats http and https the same', 'http://example.com/a', 'example.com/a'],
    ['drops the default port', 'https://example.com:443/a', 'example.com/a'],
    ['keeps a custom port', 'http://localhost:8080/a/', 'localhost:8080/a'],
    ['drops a trailing dot on the host', 'https://example.com./a', 'example.com/a'],
    ['keeps path case', 'https://example.com/Novel/ABC', 'example.com/Novel/ABC'],
    ['trims whitespace', '  https://example.com/a  ', 'example.com/a'],
  ])('%s', (_, input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('sorts the remaining query params by name, then value', () => {
    expect(normalizeUrl('https://example.com/s?b=2&a=1&c=3')).toBe('example.com/s?a=1&b=2&c=3');
    expect(normalizeUrl('https://example.com/s?a=2&a=1')).toBe('example.com/s?a=1&a=2');
  });

  it('drops tracking params', () => {
    expect(
      normalizeUrl(
        'https://example.com/a?utm_source=x&utm_medium=y&UTM_Campaign=z&fbclid=1&gclid=2&ref=hn&id=7&msclkid=3&_ga=4',
      ),
    ).toBe('example.com/a?id=7');
  });

  it('drops the query mark when only tracking params were present', () => {
    expect(normalizeUrl('https://example.com/a/?utm_source=x')).toBe('example.com/a');
  });

  it('removes the trailing slash before the query', () => {
    expect(normalizeUrl('https://example.com/a/?b=1')).toBe('example.com/a?b=1');
  });

  it('keeps empty-valued params that are not tracking', () => {
    expect(normalizeUrl('https://example.com/a?print')).toBe('example.com/a?print=');
  });

  it('produces the same key for equivalent URLs', () => {
    const a = normalizeUrl('https://WWW.Site.com/novel/abc/?page=2&utm_source=tw#top');
    const b = normalizeUrl('http://site.com/novel/abc?page=2');
    expect(a).toBe('site.com/novel/abc?page=2');
    expect(a).toBe(b);
  });

  it.each(['chrome://extensions', 'file:///C:/a.html', 'about:blank', 'not a url', '', 'javascript:alert(1)'])(
    'returns null for unsupported input %j',
    (input) => {
      expect(normalizeUrl(input)).toBeNull();
    },
  );
});

describe('isTrackingParam', () => {
  it('matches known names and prefixes case-insensitively', () => {
    for (const p of ['utm_source', 'utm_whatever', 'UTM_TERM', 'fbclid', 'gclid', 'ref', 'pk_campaign']) {
      expect(isTrackingParam(p)).toBe(true);
    }
  });
  it('leaves content params alone', () => {
    for (const p of ['id', 'page', 'q', 'chapter', 'v', 'reference', 'source']) {
      expect(isTrackingParam(p)).toBe(false);
    }
  });
});

describe('suggestPrefix', () => {
  it('removes the last path segment', () => {
    expect(suggestPrefix('site.com/novel/abc/chapter-3')).toBe('site.com/novel/abc');
  });
  it('ignores the query', () => {
    expect(suggestPrefix('site.com/novel/abc/read?ch=3')).toBe('site.com/novel/abc');
  });
  it('falls back to the host', () => {
    expect(suggestPrefix('site.com/article')).toBe('site.com');
    expect(suggestPrefix('site.com')).toBe('site.com');
  });
});

describe('siteLabel', () => {
  it('returns the host without www.', () => {
    expect(siteLabel('https://www.YouTube.com/watch?v=1')).toBe('youtube.com');
    expect(siteLabel('http://blog.example.com:8080/a')).toBe('blog.example.com');
  });
  it('returns an empty string for invalid input', () => {
    expect(siteLabel('not a url')).toBe('');
  });
});

describe('hueFor', () => {
  it('is stable and in range', () => {
    expect(hueFor('youtube.com')).toBe(hueFor('youtube.com'));
    for (const s of ['', 'a', 'youtube.com', 'x'.repeat(500)]) {
      const h = hueFor(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
  it('differs between common sites', () => {
    expect(hueFor('youtube.com')).not.toBe(hueFor('github.com'));
  });
});
