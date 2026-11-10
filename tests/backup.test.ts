import { describe, expect, it } from 'vitest';
import {
  BACKUP_LAYOUT,
  buildBackup,
  buildManifest,
  describeIssues,
  imagePath,
  imageIndex,
  imagesFromZip,
  parseManifest,
  parseRecordLine,
  planImport,
  RECORD_KEYS,
  decodeRecord,
  encodeRecord,
  recordLine,
  typeForImagePath,
} from '@/lib/backup';
import { MAX_IMAGES, MAX_URLS, SCHEMA_VERSION, type BackupImage, type ReadingRecord } from '@/lib/types';
import { rec } from './fixtures';

const img = (id: string, recordId: string): BackupImage => ({ id, recordId, file: `images/${id}.webp` });

describe('planImport (merge by id)', () => {
  it('adds records with new ids', () => {
    const incoming = rec({ id: 'new' });
    const plan = planImport([rec({ id: 'a' })], [], buildBackup([incoming], [], []));
    expect(plan.write.map((r) => r.id)).toEqual(['new']);
    expect(plan).toMatchObject({ added: 1, updated: 0, skipped: 0 });
  });

  it('replaces a stored record when the incoming one is newer', () => {
    const stored = rec({ id: 'a', title: 'old', updatedAt: 100 });
    const incoming = { ...stored, title: 'new', updatedAt: 200 };
    const plan = planImport([stored], [], buildBackup([incoming], [], []));
    expect(plan.write).toEqual([incoming]);
    expect(plan).toMatchObject({ added: 0, updated: 1, skipped: 0 });
  });

  it('keeps the stored record when it is newer', () => {
    const stored = rec({ id: 'a', updatedAt: 300 });
    const plan = planImport([stored], [], buildBackup([{ ...stored, title: 'stale', updatedAt: 200 }], [], []));
    expect(plan.write).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('keeps the stored record on a tie', () => {
    const stored = rec({ id: 'a', updatedAt: 300 });
    const plan = planImport([stored], [], buildBackup([{ ...stored, title: 'same age' }], [], []));
    expect(plan.write).toEqual([]);
    expect(plan.skipped).toBe(1);
  });

  it('leaves stored records that are not in the backup untouched', () => {
    const plan = planImport([rec({ id: 'a' }), rec({ id: 'b' })], [], buildBackup([], [], []));
    expect(plan.write).toEqual([]);
    expect(plan.deleteImages).toEqual([]);
  });

  it('imports images only for winning records', () => {
    const stored = rec({ id: 'a', updatedAt: 500, images: ['a1'] });
    const winner = rec({ id: 'b', images: ['b1', 'b2'] });
    const loser = { ...stored, updatedAt: 100, images: ['a1', 'a9'] };
    const plan = planImport([stored], [], buildBackup([winner, loser], [], [img('a9', 'a'), img('b1', 'b'), img('b2', 'b')]));
    expect(plan.putImages.map((i) => i.id)).toEqual(['b1', 'b2']);
    expect(plan.deleteImages).toEqual([]);
    expect(plan.write[0]?.images).toEqual(['b1', 'b2']);
  });

  it('drops image ids the file does not carry for that record', () => {
    const r = rec({ id: 'x', images: ['missing', 'other', 'ok'] });
    const plan = planImport([], [], buildBackup([r], [], [img('other', 'someone-else'), img('ok', 'x')]));
    expect(plan.write[0]?.images).toEqual(['ok']);
    expect(plan.putImages.map((i) => i.id)).toEqual(['ok']);
  });

  it('keeps already stored images without re-importing them', () => {
    const stored = rec({ id: 'a', updatedAt: 100, images: ['a1'] });
    const plan = planImport([stored], [], buildBackup([{ ...stored, updatedAt: 200, images: ['a1', 'a2'] }], [], [img('a2', 'a')]));
    expect(plan.write[0]?.images).toEqual(['a1', 'a2']);
    expect(plan.putImages.map((i) => i.id)).toEqual(['a2']);
  });

  it('deletes stored images the newer incoming copy no longer lists', () => {
    const stored = rec({ id: 'a', updatedAt: 100, images: ['a1', 'a2'] });
    const plan = planImport([stored], [], buildBackup([{ ...stored, updatedAt: 200, images: ['a2'] }], [], []));
    expect(plan.deleteImages).toEqual(['a1']);
    expect(plan.write[0]?.images).toEqual(['a2']);
  });

  it("never re-points another record's stored image", () => {
    const other = rec({ id: 'other', images: ['shared'] });
    const plan = planImport([other], [], buildBackup([rec({ id: 'x', images: ['shared'] })], [], [img('shared', 'x')]));
    expect(plan.write[0]?.images).toEqual([]);
    expect(plan.putImages).toEqual([]);
  });

  it('uses the newest copy when the file repeats an id', () => {
    const a1 = rec({ id: 'dup', title: 'first', updatedAt: 100 });
    const a2 = { ...a1, title: 'second', updatedAt: 300 };
    const a3 = { ...a1, title: 'third', updatedAt: 200 };
    const plan = planImport([], [], buildBackup([a1, a2, a3], [], []));
    expect(plan.write.map((r) => r.title)).toEqual(['second']);
    expect(plan.added).toBe(1);
  });
});

describe('parseRecordLine (validation)', () => {
  /** A records.jsonl line for rec() with these (possibly invalid) fields. */
  const line = (patch: object) => JSON.stringify(encodeRecord({ ...rec(), ...patch } as ReadingRecord));
  const parse = (patch: object) => parseRecordLine(line(patch), 1, SCHEMA_VERSION);

  it('accepts a valid record', () => {
    const r = rec({ id: 'a', lastReadUrl: 'https://example.com/ch-2' });
    expect(parseRecordLine(recordLine(r).trim(), 1, SCHEMA_VERSION)).toEqual(r);
  });

  it('rejects lines that are not JSON objects, with the line number', () => {
    expect(() => parseRecordLine('{"id":', 7, SCHEMA_VERSION)).toThrow(/records\.jsonl line 7: not valid JSON/);
    expect(() => parseRecordLine('[]', 3, SCHEMA_VERSION)).toThrow(/records\.jsonl line 3 is not an object/);
  });

  it('rejects records with missing or wrong-typed fields', () => {
    expect(() => parse({ id: 5 })).toThrow(/"id"/);
    expect(() => parse({ matchMode: 'fuzzy' })).toThrow(/"matchMode"/);
    expect(() => parse({ status: 'done' })).toThrow(/"status"/);
    expect(() => parse({ status: 'reading' })).toThrow(/"status"/);
    expect(() => parse({ tags: 'a,b' })).toThrow(/"tags"/);
    expect(() => parse({ updatedAt: '2024-01-01' })).toThrow(/"updatedAt"/);
    expect(() => parse({ notes: 5 })).toThrow(/"notes"/);
    expect(() => parse({ readAt: 'yesterday' })).toThrow(/"readAt"/);
    for (const folderId of [5, '']) expect(() => parse({ folderId })).toThrow(/"folderId"/);
    for (const favorite of [false, 1, 'yes']) expect(() => parse({ favorite })).toThrow(/"favorite"/);
  });

  it('rejects non-http(s) links, naming the line', () => {
    expect(() => parseRecordLine(line({ url: 'javascript:x' }), 9, SCHEMA_VERSION)).toThrow(
      /records\.jsonl line 9: missing or invalid "url"/,
    );
    expect(() => parse({ url: 'site.com/x' })).toThrow(/"url"/);
    expect(() => parse({ lastReadUrl: 'javascript:alert(1)' })).toThrow(/"lastReadUrl"/);
  });

  it('validates extra URLs', () => {
    const ok = { url: 'https://b.com/x', matchMode: 'exact', matchKey: 'b.com/x' };
    expect(parse({ otherUrls: [ok] }).otherUrls).toEqual([ok]);
    expect(() => parse({ otherUrls: 'x' })).toThrow(/"otherUrls"/);
    expect(() => parse({ otherUrls: [{ ...ok, url: 'javascript:alert(1)' }] })).toThrow(/"otherUrls"/);
    expect(() => parse({ otherUrls: [{ ...ok, matchMode: 'fuzzy' }] })).toThrow(/"otherUrls"/);
    expect(() => parse({ otherUrls: [{ ...ok, matchKey: '' }] })).toThrow(/"otherUrls"/);
    expect(() => parse({ otherUrls: Array.from({ length: MAX_URLS }, () => ok) })).toThrow(/"otherUrls"/);
  });

  it('rejects records with an invalid images list', () => {
    expect(() => parse({ images: 'x' })).toThrow(/"images"/);
    expect(() => parse({ images: [1] })).toThrow(/"images"/);
    expect(() => parse({ images: ['a', 'a'] })).toThrow(/"images"/);
    expect(() => parse({ images: Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `i${i}`) })).toThrow(/"images"/);
  });

  it('rejects records from a newer schema', () => {
    expect(() => parseRecordLine(line({}), 1, SCHEMA_VERSION + 1)).toThrow(/supports up to/);
  });
});

describe('ZIP backup image paths', () => {
  it('names image files by id and type, filename-safe', () => {
    expect(imagePath('abc-123', 'image/jpeg')).toBe('images/abc-123.jpg');
    expect(imagePath('a/../b', 'image/png')).toBe('images/a____b.png');
    expect(imagePath('x', 'application/octet-stream')).toBe('images/x.bin');
    expect(typeForImagePath('images/x.jpg')).toBe('image/jpeg');
    expect(typeForImagePath('images/x.JPEG')).toBe('image/jpeg');
    expect(typeForImagePath('images/x.svg')).toBe('image/svg+xml');
    expect(typeForImagePath('images/x.bin')).toBe('');
  });
  it('indexes image files directly under images/ by stem', () => {
    const index = imageIndex(['manifest.json', 'images/a.png', 'images/b', 'images/x/c.png', 'images/a.jpg', 'other/d.png', 'images/']);
    expect([...index]).toEqual([
      ['a', 'images/a.png'],
      ['b', 'images/b'],
    ]);
  });
  it('finds each record\'s images by id; the first record listing an id gets it', () => {
    const index = imageIndex(['images/i1.png', 'images/i2.webp', 'images/legacy-r.webp']);
    const records = [
      rec({ id: 'r', title: 'R', images: ['i1', 'missing', 'legacy-r'] }),
      rec({ id: 's', title: 'S', images: ['i1', 'i2'] }),
    ];
    expect(imagesFromZip(records, index)).toEqual([
      { id: 'i1', recordId: 'r', file: 'images/i1.png' },
      { id: 'legacy-r', recordId: 'r', file: 'images/legacy-r.webp' },
      { id: 'i2', recordId: 's', file: 'images/i2.webp' },
    ]);
    // planImport then reports the missing one and the shared one.
    const plan = planImport([], [], buildBackup(records, [], imagesFromZip(records, index)));
    expect(plan.issues).toEqual([
      'Record “R”: image missing is not in the backup, skipped.',
      'Record “S”: image i1 belongs to another record, skipped.',
    ]);
  });
});

describe('manifest.json', () => {
  const folderA = { id: 'f', name: 'A', createdAt: 1, updatedAt: 1 };
  it('round-trips the manifest', () => {
    const m = buildManifest({ records: 3, images: 2 }, [folderA], { updatedAt: 4, imageSize: 'large' }, 123);
    const parsed = parseManifest(JSON.stringify(m));
    expect(parsed).toEqual({ ...m, counts: { records: 3, folders: 1, images: 2 } });
    expect(parsed.layout).toBe(BACKUP_LAYOUT);
  });
  it('rejects manifests that are not ours or are newer', () => {
    const m = buildManifest({ records: 0, images: 0 }, []);
    expect(() => parseManifest('{')).toThrow(/manifest\.json is not valid JSON/);
    expect(() => parseManifest(JSON.stringify({ ...m, format: 'x' }))).toThrow(/Not a Read Tracker/);
    expect(() => parseManifest(JSON.stringify({ ...m, layout: BACKUP_LAYOUT + 1 }))).toThrow(/newer version/);
    expect(() => parseManifest(JSON.stringify({ ...m, layout: 'x' }))).toThrow(/layout/);
    expect(() => parseManifest(JSON.stringify({ ...m, version: SCHEMA_VERSION + 1 }))).toThrow(/newer version/);
    for (const version of [undefined, '1', 0, 1.5]) {
      expect(() => parseManifest(JSON.stringify({ ...m, version }))).toThrow(/version/);
    }
    expect(() => parseManifest(JSON.stringify({ ...m, folders: 'x' }))).toThrow(/folders/);
  });
  it('reports invalid folder domains instead of failing', () => {
    const issues: string[] = [];
    const m = buildManifest({ records: 0, images: 0 }, [{ ...folderA, domains: ['x.com', 'not a domain', 5 as never] }]);
    expect(parseManifest(JSON.stringify(m), issues).folders[0]?.domains).toEqual(['x.com']);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/Folder “A”.*"not a domain"/);
  });
});

describe('planImport issues', () => {
  it('reports images it drops and records moved to Home', () => {
    const other = rec({ id: 'o', images: ['shared'] });
    const r = rec({ id: 'x', title: 'X', images: ['shared', 'missing'], folderId: 'ghost' });
    const plan = planImport([other], [], buildBackup([r], [], [img('shared', 'x')]));
    expect(plan.issues).toEqual([
      'Record “X”: image shared belongs to another record, skipped.',
      'Record “X”: image missing is not in the backup, skipped.',
      'Record “X”: its folder isn\'t in the backup, added to Home.',
    ]);
  });
  it('reports skipped renames and domain clashes', () => {
    const local = [
      { id: 'a', name: 'Art', domains: ['x.com'], createdAt: 1, updatedAt: 1 },
      { id: 'b', name: 'Books', createdAt: 1, updatedAt: 1 },
    ];
    const incoming = [
      { id: 'b', name: 'art', createdAt: 1, updatedAt: 5 },
      { id: 'n', name: 'New', domains: ['x.com'], createdAt: 1, updatedAt: 1 },
    ];
    const plan = planImport([], local, buildBackup([], incoming, []));
    expect(plan.issues).toEqual([
      'Folder “Books”: not renamed to “art”, another folder already has that name.',
      'Folder “New”: preferred domain x.com already belongs to “Art”, not added.',
    ]);
  });
  it('has no issues for a clean import, and describeIssues caps the list', () => {
    expect(planImport([], [], buildBackup([rec({ id: 'a', images: ['i'] })], [], [img('i', 'a')])).issues).toEqual([]);
    const many = Array.from({ length: 105 }, (_, i) => `issue ${i}`);
    expect(describeIssues(many)).toEqual({ shown: many.slice(0, 100), more: 5 });
  });
});

describe('records.jsonl compact form', () => {
  it('uses unique keys of at most 3 characters', () => {
    const keys = Object.values(RECORD_KEYS);
    expect(keys.every((k) => k.length <= 3)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('leaves out defaults and derivable values', () => {
    const r = rec({ id: 'a', title: 'T', url: 'https://www.x.com/a?utm_source=z', matchKey: 'x.com/a', createdAt: 1, updatedAt: 2 });
    expect(encodeRecord(r)).toEqual({ id: 'a', ttl: 'T', sts: 'unread', ca: 1, ua: 2, url: 'https://www.x.com/a?utm_source=z' });
  });

  it('keeps values that are not derivable or not default', () => {
    const r = rec({
      id: 'a',
      url: 'https://x.com/series/1',
      matchMode: 'prefix',
      matchKey: 'x.com/series', // a custom series prefix
      tags: ['t'],
      images: ['i'],
      folderId: 'f',
      notes: 'n',
      status: 'read',
      readAt: 5,
      favorite: true,
      lastReadUrl: 'https://x.com/series/2',
      otherUrls: [
        { url: 'https://y.com/a', matchMode: 'exact', matchKey: 'y.com/a' },
        { url: 'https://z.com/s/1', matchMode: 'prefix', matchKey: 'z.com/s' },
      ],
    });
    const o = encodeRecord(r);
    expect(o).toMatchObject({ mm: 'prefix', mk: 'x.com/series', tag: ['t'], img: ['i'], fid: 'f', nt: 'n', ra: 5, fav: true });
    expect(o.ou).toEqual([{ url: 'https://y.com/a' }, { url: 'https://z.com/s/1', mm: 'prefix', mk: 'z.com/s' }]);
    // And back, exactly.
    expect(parseRecordLine(recordLine(r).trim(), 1, SCHEMA_VERSION)).toEqual(r);
  });

  it('round-trips the fixture and ignores unknown keys', () => {
    const r = rec();
    expect(parseRecordLine(recordLine(r).trim(), 1, SCHEMA_VERSION)).toEqual(r);
    expect(decodeRecord({ ...encodeRecord(r), zzz: 1 })).toEqual(decodeRecord(encodeRecord(r)));
  });

  it('names the short key in errors', () => {
    expect(() => parseRecordLine(JSON.stringify({ ...encodeRecord(rec()), ttl: 5 }), 4, SCHEMA_VERSION)).toThrow(
      'records.jsonl line 4: missing or invalid "title" (key "ttl").',
    );
  });

  it('is much shorter than the full JSON', () => {
    const r = rec({ url: 'https://www.pinterest.com/pin/1031042908451702272/', matchKey: 'pinterest.com/pin/1031042908451702272' });
    expect(recordLine(r).length).toBeLessThan(JSON.stringify(r).length * 0.6);
  });
});
