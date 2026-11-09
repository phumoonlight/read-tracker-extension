import { describe, expect, it } from 'vitest';
import { addTagText, suggestTags } from '@/lib/tags';

const all: [string, number][] = [
  ['animated', 2],
  ['anime', 5],
  ['banana', 9],
  ['cute', 3],
  ['plant', 1],
];

describe('suggestTags', () => {
  it('suggests tags containing the text, prefix matches first, then by use, then name', () => {
    expect(suggestTags(all, 'an', [])).toEqual(['anime', 'animated', 'banana', 'plant']);
  });
  it('is case-insensitive and trims', () => {
    expect(suggestTags(all, '  CU ', [])).toEqual(['cute']);
  });
  it('leaves out tags already chosen', () => {
    expect(suggestTags(all, 'an', ['anime', 'banana'])).toEqual(['animated', 'plant']);
  });
  it('returns nothing for empty text and respects the limit', () => {
    expect(suggestTags(all, '', [])).toEqual([]);
    expect(suggestTags(all, 'a', [], 2)).toHaveLength(2);
  });
});

describe('addTagText', () => {
  it('adds comma-separated text, normalized and without duplicates', () => {
    expect(addTagText(['cute'], ' Anime , CUTE,, later ')).toEqual(['cute', 'anime', 'later']);
  });
  it('ignores blank text', () => {
    expect(addTagText(['cute'], '  ')).toEqual(['cute']);
  });
});
