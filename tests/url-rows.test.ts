import { describe, expect, it } from 'vitest';
import { urlRowsFor, validateUrlRows } from '@/components/RecordForm';
import { rec } from './fixtures';

describe('validateUrlRows', () => {
  it('returns the main URL first and computes keys per row', () => {
    const out = validateUrlRows([
      { url: 'https://www.a.com/post/', matchMode: 'exact', prefix: '' },
      { url: 'https://b.com/novel/x/ch-1', matchMode: 'prefix', prefix: 'b.com/novel/x' },
    ]);
    expect(out).toEqual([
      { url: 'https://www.a.com/post/', matchMode: 'exact', matchKey: 'a.com/post' },
      { url: 'https://b.com/novel/x/ch-1', matchMode: 'prefix', matchKey: 'b.com/novel/x' },
    ]);
  });

  it('ignores blank extra rows but requires the main URL', () => {
    expect(
      validateUrlRows([
        { url: 'https://a.com', matchMode: 'exact', prefix: '' },
        { url: '  ', matchMode: 'exact', prefix: '' },
      ]),
    ).toHaveLength(1);
    expect(validateUrlRows([{ url: '', matchMode: 'exact', prefix: '' }])).toHaveProperty('error');
  });

  it('names the row with a problem', () => {
    const out = validateUrlRows([
      { url: 'https://a.com', matchMode: 'exact', prefix: '' },
      { url: 'javascript:alert(1)', matchMode: 'exact', prefix: '' },
    ]);
    expect(out).toEqual({ error: expect.stringMatching(/^URL 2:/) });
  });

  it('rejects two rows that match the same pages', () => {
    const out = validateUrlRows([
      { url: 'https://a.com/x', matchMode: 'exact', prefix: '' },
      { url: 'http://www.a.com/x/', matchMode: 'exact', prefix: '' },
    ]);
    expect(out).toEqual({ error: expect.stringMatching(/same pages/) });
    // Same key with different modes is fine (one page vs. everything under it).
    expect(
      validateUrlRows([
        { url: 'https://a.com/x', matchMode: 'exact', prefix: '' },
        { url: 'https://a.com/x', matchMode: 'prefix', prefix: 'a.com/x' },
      ]),
    ).toHaveLength(2);
  });
});

describe('urlRowsFor', () => {
  it('lists the main URL then the others, with prefixes for series URLs', () => {
    const r = rec({
      url: 'https://a.com/post',
      matchMode: 'exact',
      matchKey: 'a.com/post',
      otherUrls: [{ url: 'https://b.com/s/ch-1', matchMode: 'prefix', matchKey: 'b.com/s' }],
    });
    expect(urlRowsFor(r)).toEqual([
      { url: 'https://a.com/post', matchMode: 'exact', prefix: 'a.com' },
      { url: 'https://b.com/s/ch-1', matchMode: 'prefix', prefix: 'b.com/s' },
    ]);
  });
});
