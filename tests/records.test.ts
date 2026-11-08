import { describe, expect, it } from 'vitest';
import { computeMatchKey, createRecord, isHttpUrl, parseTags } from '@/lib/records';

describe('computeMatchKey', () => {
  it('uses the normalized URL for exact records', () => {
    expect(computeMatchKey('https://www.site.com/a/?utm_source=x', 'exact')).toBe('site.com/a');
  });

  it('uses the prefix for series records, with or without a scheme', () => {
    expect(computeMatchKey('https://site.com/novel/abc/ch-3', 'prefix', 'site.com/novel/abc/')).toBe('site.com/novel/abc');
    expect(computeMatchKey('https://site.com/novel/abc/ch-3', 'prefix', 'https://WWW.site.com/novel/abc')).toBe(
      'site.com/novel/abc',
    );
    expect(computeMatchKey('https://localhost:8080/a/b', 'prefix', 'localhost:8080/a')).toBe('localhost:8080/a');
  });

  it('falls back to the URL when the prefix is blank', () => {
    expect(computeMatchKey('https://site.com/novel/abc', 'prefix', '  ')).toBe('site.com/novel/abc');
  });

  it.each(['site.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://site.com/x', ''])(
    'rejects a non-http(s) record URL %j in both modes',
    (url) => {
      expect(computeMatchKey(url, 'exact')).toHaveProperty('error');
      expect(computeMatchKey(url, 'prefix', 'site.com/novel')).toHaveProperty('error');
    },
  );

  it.each(['javascript:alert(1)', 'ftp://site.com/x', 'chrome://extensions'])(
    'rejects a prefix with a non-http(s) scheme %j',
    (prefix) => {
      expect(computeMatchKey('https://site.com/a', 'prefix', prefix)).toHaveProperty('error');
    },
  );
});

describe('createRecord', () => {
  it('builds a record with defaults', () => {
    const r = createRecord({ title: '  T ', url: ' https://site.com/a ', matchMode: 'exact', tags: ['B', 'a', 'b', ' '] });
    expect(r).toMatchObject({
      title: 'T',
      url: 'https://site.com/a',
      matchKey: 'site.com/a',
      status: 'unread',
      tags: ['b', 'a'],
      hasThumbnail: false,
      readAt: undefined,
    });
  });

  it('sets readAt when created as read', () => {
    const r = createRecord({ title: 'T', url: 'https://site.com/a', matchMode: 'exact', status: 'read' });
    expect('readAt' in r && typeof r.readAt).toBe('number');
  });

  it('returns an error for an invalid URL', () => {
    expect(createRecord({ title: 'T', url: 'javascript:alert(1)', matchMode: 'prefix', prefix: 'site.com' })).toHaveProperty(
      'error',
    );
  });
});

describe('helpers', () => {
  it('isHttpUrl', () => {
    expect(isHttpUrl('https://a.com')).toBe(true);
    expect(isHttpUrl('a.com')).toBe(false);
    expect(isHttpUrl(5)).toBe(false);
  });
  it('parseTags', () => {
    expect(parseTags(' Fantasy, sci-fi ,,fantasy')).toEqual(['fantasy', 'sci-fi']);
  });
});
