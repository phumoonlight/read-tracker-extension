import { describe, expect, it } from 'vitest';
import { coveredShare, hasUrlImage, pictureSelector } from '@/lib/pictures';

describe('hasUrlImage', () => {
  it('is true only for a url() background', () => {
    expect(hasUrlImage('url("https://x.test/a.jpg")')).toBe(true);
    expect(hasUrlImage('linear-gradient(red, blue), url(a.png)')).toBe(true);
    expect(hasUrlImage('none')).toBe(false);
    expect(hasUrlImage('linear-gradient(red, blue)')).toBe(false);
  });
});

describe('coveredShare', () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
  it('measures how much of the inner box the outer one covers', () => {
    expect(coveredShare(box(0, 0, 100, 100), box(0, 0, 100, 100))).toBe(1);
    expect(coveredShare(box(0, 0, 100, 100), box(50, 0, 100, 100))).toBe(0.5);
    expect(coveredShare(box(0, 0, 100, 100), box(200, 0, 100, 100))).toBe(0);
    expect(coveredShare(box(0, 0, 100, 100), box(0, 0, 0, 0))).toBe(0);
  });
});

describe('pictureSelector', () => {
  it('matches the tagged value and leaves hovered / focused ones alone', () => {
    const s = pictureSelector('data-p', 'data-c', 'read');
    expect(s.startsWith('[data-p="read"]:not(')).toBe(true);
    for (const part of [':hover', ':focus-within', 'a:hover *', 'a:focus-visible *', '[data-c]:hover *']) {
      expect(s).toContain(part);
    }
  });
});
