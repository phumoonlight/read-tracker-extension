import { describe, expect, it } from 'vitest';
import { sniffImageType } from '@/lib/images';

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
