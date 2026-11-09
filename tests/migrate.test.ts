import { describe, expect, it } from 'vitest';
import { migrateRecord } from '@/lib/migrate';
import { SCHEMA_VERSION } from '@/lib/types';
import { rec } from './fixtures';

describe('migrateRecord', () => {
  it('returns a current record unchanged', () => {
    const r = rec({ id: 'a' });
    expect(migrateRecord({ ...r } as unknown as Record<string, unknown>, SCHEMA_VERSION)).toEqual(r);
  });

  it('refuses data from a newer schema', () => {
    expect(() => migrateRecord({}, SCHEMA_VERSION + 1)).toThrow(/supports up to/);
  });
});
