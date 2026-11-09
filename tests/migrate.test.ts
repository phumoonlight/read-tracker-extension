import { describe, expect, it } from 'vitest';
import { migrateRecord } from '@/lib/migrate';
import { SCHEMA_VERSION, legacyImageId } from '@/lib/types';
import { rec } from './fixtures';

/** A record as stored before schema v3. */
function oldRecord(hasThumbnail: boolean) {
  const { images: _images, ...r } = rec({ id: 'r1' });
  void _images;
  return { ...r, hasThumbnail };
}

describe('migrateRecord', () => {
  it('v2 -> v3: a thumbnail becomes the first image, with the legacy id', () => {
    const m = migrateRecord(oldRecord(true), 2);
    expect(m.images).toEqual([legacyImageId('r1')]);
    expect(m).not.toHaveProperty('hasThumbnail');
  });

  it('v2 -> v3: no thumbnail means no images', () => {
    const m = migrateRecord(oldRecord(false), 2);
    expect(m.images).toEqual([]);
    expect(m).not.toHaveProperty('hasThumbnail');
  });

  it('v1 -> v3 goes through every step', () => {
    expect(migrateRecord(oldRecord(true), 1).images).toEqual([legacyImageId('r1')]);
  });

  it('keeps an existing images list (idempotent if run twice)', () => {
    const once = migrateRecord(oldRecord(true), 2);
    expect(migrateRecord({ ...once } as unknown as Record<string, unknown>, 2).images).toEqual(once.images);
  });

  it('leaves current records alone and rejects newer ones', () => {
    const r = rec({ images: ['a'] });
    expect(migrateRecord(r as unknown as Record<string, unknown>, SCHEMA_VERSION)).toEqual(r);
    expect(() => migrateRecord({}, SCHEMA_VERSION + 1)).toThrow(/supports up to/);
  });
});

describe('v3 -> v4 (otherUrls)', () => {
  it('leaves records unchanged (otherUrls is optional)', () => {
    const r = rec({ images: [] });
    expect(migrateRecord({ ...r } as unknown as Record<string, unknown>, 3)).toEqual(r);
  });
});

describe('v4 -> v5 (two states)', () => {
  it('turns "reading" into "unread" and leaves the others alone', () => {
    const base = rec({ images: [] }) as unknown as Record<string, unknown>;
    expect(migrateRecord({ ...base, status: 'reading' }, 4).status).toBe('unread');
    expect(migrateRecord({ ...base, status: 'read', readAt: 5 }, 4)).toMatchObject({ status: 'read', readAt: 5 });
    expect(migrateRecord({ ...base, status: 'unread' }, 4).status).toBe('unread');
  });
});
