import { describe, expect, it } from 'vitest';
import { buildBackup, parseBackup, planImport } from '@/lib/backup';
import { BACKUP_FORMAT, SCHEMA_VERSION } from '@/lib/types';
import { rec } from './fixtures';

const IMG = 'data:image/webp;base64,AAAA';

describe('planImport (merge by id)', () => {
  it('adds records with new ids', () => {
    const incoming = rec({ id: 'new' });
    const plan = planImport([rec({ id: 'a' })], buildBackup([incoming], {}));
    expect(plan.write.map((r) => r.id)).toEqual(['new']);
    expect(plan).toMatchObject({ added: 1, updated: 0, skipped: 0 });
  });

  it('replaces a stored record when the incoming one is newer', () => {
    const stored = rec({ id: 'a', title: 'old', updatedAt: 100 });
    const incoming = { ...stored, title: 'new', updatedAt: 200 };
    const plan = planImport([stored], buildBackup([incoming], {}));
    expect(plan.write).toEqual([{ ...incoming, hasThumbnail: false }]);
    expect(plan).toMatchObject({ added: 0, updated: 1, skipped: 0 });
  });

  it('keeps the stored record when it is newer', () => {
    const stored = rec({ id: 'a', updatedAt: 300 });
    const plan = planImport([stored], buildBackup([{ ...stored, title: 'stale', updatedAt: 200 }], {}));
    expect(plan.write).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('keeps the stored record on a tie', () => {
    const stored = rec({ id: 'a', updatedAt: 300 });
    const plan = planImport([stored], buildBackup([{ ...stored, title: 'same age' }], {}));
    expect(plan.write).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('leaves stored records that are not in the backup untouched', () => {
    const plan = planImport([rec({ id: 'a' }), rec({ id: 'b' })], buildBackup([], {}));
    expect(plan.write).toEqual([]);
    expect(plan.deleteThumbnails).toEqual([]);
  });

  it('imports thumbnails only for winning records', () => {
    const stored = rec({ id: 'a', updatedAt: 500, hasThumbnail: true });
    const winner = rec({ id: 'b', hasThumbnail: true });
    const loser = { ...stored, updatedAt: 100 };
    const plan = planImport([stored], buildBackup([winner, loser], { a: IMG, b: IMG }));
    expect(plan.putThumbnails).toEqual({ b: IMG });
    expect(plan.deleteThumbnails).toEqual([]);
  });

  it('sets hasThumbnail from what the file actually contains', () => {
    const claimsThumb = rec({ id: 'x', hasThumbnail: true });
    const plan = planImport([], buildBackup([claimsThumb], {}));
    expect(plan.write[0]?.hasThumbnail).toBe(false);

    const hasData = rec({ id: 'y', hasThumbnail: false });
    expect(planImport([], buildBackup([hasData], { y: IMG })).write[0]?.hasThumbnail).toBe(true);
  });

  it('removes the stored thumbnail when the newer incoming copy has none', () => {
    const stored = rec({ id: 'a', updatedAt: 100, hasThumbnail: true });
    const plan = planImport([stored], buildBackup([{ ...stored, hasThumbnail: false, updatedAt: 200 }], {}));
    expect(plan.deleteThumbnails).toEqual(['a']);
  });

  it('uses the newest copy when the file repeats an id', () => {
    const a1 = rec({ id: 'dup', title: 'first', updatedAt: 100 });
    const a2 = { ...a1, title: 'second', updatedAt: 300 };
    const a3 = { ...a1, title: 'third', updatedAt: 200 };
    const plan = planImport([], buildBackup([a1, a2, a3], {}));
    expect(plan.write.map((r) => r.title)).toEqual(['second']);
    expect(plan.added).toBe(1);
  });
});

describe('parseBackup (validation)', () => {
  const valid = () => buildBackup([rec({ id: 'a' })], { a: IMG });

  it('round-trips a built backup', () => {
    const b = valid();
    const parsed = parseBackup(JSON.stringify(b));
    expect(parsed.records).toEqual(b.records);
    expect(parsed.thumbnails).toEqual({ a: IMG });
    expect(parsed.version).toBe(SCHEMA_VERSION);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseBackup('{nope')).toThrow(/valid JSON/);
  });

  it('rejects files that are not backups', () => {
    expect(() => parseBackup(JSON.stringify({ records: [] }))).toThrow(/Not a Read Tracker backup/);
    expect(() => parseBackup('[]')).toThrow(/Not a Read Tracker backup/);
  });

  it('rejects a missing or malformed version', () => {
    for (const version of [undefined, '1', 0, 1.5]) {
      expect(() => parseBackup(JSON.stringify({ ...valid(), version }))).toThrow(/version/);
    }
  });

  it('rejects a backup from a newer schema', () => {
    expect(() => parseBackup(JSON.stringify({ ...valid(), version: SCHEMA_VERSION + 1 }))).toThrow(/newer version/);
  });

  it('rejects records with missing or wrong-typed fields', () => {
    const bad = (patch: object) =>
      JSON.stringify({ format: BACKUP_FORMAT, version: SCHEMA_VERSION, records: [{ ...rec(), ...patch }] });
    expect(() => parseBackup(bad({ id: 5 }))).toThrow(/"id"/);
    expect(() => parseBackup(bad({ matchMode: 'fuzzy' }))).toThrow(/"matchMode"/);
    expect(() => parseBackup(bad({ status: 'done' }))).toThrow(/"status"/);
    expect(() => parseBackup(bad({ tags: 'a,b' }))).toThrow(/"tags"/);
    expect(() => parseBackup(bad({ updatedAt: '2024-01-01' }))).toThrow(/"updatedAt"/);
    expect(() => parseBackup(bad({ notes: 5 }))).toThrow(/"notes"/);
    expect(() => parseBackup(bad({ readAt: 'yesterday' }))).toThrow(/"readAt"/);
  });

  it('rejects non-http(s) links', () => {
    const bad = (patch: object) =>
      JSON.stringify({ format: BACKUP_FORMAT, version: SCHEMA_VERSION, records: [{ ...rec(), ...patch }] });
    expect(() => parseBackup(bad({ url: 'javascript:alert(1)' }))).toThrow(/"url"/);
    expect(() => parseBackup(bad({ url: 'site.com/x' }))).toThrow(/"url"/);
    expect(() => parseBackup(bad({ lastReadUrl: 'javascript:alert(1)' }))).toThrow(/"lastReadUrl"/);
    expect(parseBackup(bad({ lastReadUrl: 'https://example.com/ch-2' })).records[0]?.lastReadUrl).toBe(
      'https://example.com/ch-2',
    );
  });

  it('drops thumbnails that are not image data URLs', () => {
    const text = JSON.stringify({ ...valid(), thumbnails: { a: 'https://evil.example/x.png', b: 42, c: IMG } });
    expect(parseBackup(text).thumbnails).toEqual({ c: IMG });
  });
});
