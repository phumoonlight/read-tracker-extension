import { describe, expect, it } from 'vitest';
import { isPermutation, moveItem, sniffImageType } from '@/lib/images';

const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

describe('sniffImageType', () => {
  it.each([
    ['image/png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)],
    ['image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['image/gif', bytes('GIF89a')],
    ['image/webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')],
    ['image/avif', bytes(0, 0, 0, 0x1c, 'ftypavif')],
    ['image/bmp', bytes('BM', 0, 0)],
  ])('detects %s', (type, b) => {
    expect(sniffImageType(b)).toBe(type);
  });

  it('returns undefined for other data', () => {
    expect(sniffImageType(bytes('<html>'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
    expect(sniffImageType(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBeUndefined();
  });
});

describe('moveItem', () => {
  it('moves an item forward and backward', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c']);
  });
  it('is a no-op for the same index or an out-of-range source, and clamps the target', () => {
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b']);
  });
  it('does not mutate the input', () => {
    const list = ['a', 'b'];
    moveItem(list, 0, 1);
    expect(list).toEqual(['a', 'b']);
  });
});

describe('isPermutation', () => {
  it('accepts a reordering of the same ids', () => {
    expect(isPermutation(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isPermutation([], [])).toBe(true);
  });
  it('rejects added, removed or duplicated ids', () => {
    expect(isPermutation(['a', 'b'], ['a'])).toBe(false);
    expect(isPermutation(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
    expect(isPermutation(['a', 'b'], ['a', 'a'])).toBe(false);
    expect(isPermutation(['a', 'b'], ['a', 'x'])).toBe(false);
  });
});
