import { describe, expect, it } from 'vitest';
import { imagePath, imageStem } from '@/lib/backup';
import { newId } from '@/lib/ids';

describe('newId', () => {
  it('makes cuid2 ids: 24 lowercase letters and digits, starting with a letter', () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[a-z][a-z0-9]{23}$/);
  });
  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, newId));
    expect(ids.size).toBe(2000);
  });
  it('is used as-is for backup image file names (no renaming needed)', () => {
    const id = newId();
    expect(imageStem(id)).toBe(id);
    expect(imagePath(id, 'image/png')).toBe(`images/${id}.png`);
  });
});
