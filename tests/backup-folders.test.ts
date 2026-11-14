import { describe, expect, it } from 'vitest';
import { buildBackup, buildManifest, parseManifest, planImport } from '@/lib/backup';
import type { Folder } from '@/lib/types';
import { rec } from './fixtures';

const folder = (id: string, name: string, updatedAt = 100): Folder => ({ id, name, createdAt: 1, updatedAt });

describe('planImport with folders', () => {
  it('adds new folders and keeps record folder links', () => {
    const f = folder('f1', 'Novels');
    const r = rec({ id: 'r', folderId: 'f1' });
    const plan = planImport([], [], buildBackup([r], [f], []));
    expect(plan.writeFolders).toEqual([f]);
    expect(plan.write[0]?.folderId).toBe('f1');
  });

  it('merges folders by id: newer wins, older or equal is ignored', () => {
    const local = folder('f1', 'Novels', 200);
    expect(planImport([], [local], buildBackup([], [folder('f1', 'Renamed', 300)], [])).writeFolders).toEqual([
      folder('f1', 'Renamed', 300),
    ]);
    expect(planImport([], [local], buildBackup([], [folder('f1', 'Old', 100)], [])).writeFolders).toEqual([]);
    expect(planImport([], [local], buildBackup([], [folder('f1', 'Same', 200)], [])).writeFolders).toEqual([]);
  });

  it('reuses an existing folder with the same name instead of creating a duplicate', () => {
    const local = folder('mine', 'Novels');
    const theirs = folder('theirs', '  novels ');
    const r = rec({ id: 'r', folderId: 'theirs' });
    const plan = planImport([], [local], buildBackup([r], [theirs], []));
    expect(plan.writeFolders).toEqual([]);
    expect(plan.write[0]?.folderId).toBe('mine');
  });

  it('merges two same-name folders inside one file into the first', () => {
    const a = folder('a', 'Comics');
    const b = folder('b', 'COMICS');
    const plan = planImport([], [], buildBackup([rec({ id: 'r', folderId: 'b' })], [a, b], []));
    expect(plan.writeFolders.map((f) => f.id)).toEqual(['a']);
    expect(plan.write[0]?.folderId).toBe('a');
  });

  it('skips a newer rename that would collide with another folder name', () => {
    const local = [folder('f1', 'Novels', 100), folder('f2', 'Comics', 100)];
    const plan = planImport([], local, buildBackup([], [folder('f1', 'comics', 500)], []));
    expect(plan.writeFolders).toEqual([]);
  });

  it('drops a folderId that points at no known folder', () => {
    const plan = planImport([], [], buildBackup([rec({ id: 'r', folderId: 'ghost' })], [], []));
    expect(plan.write[0]).not.toHaveProperty('folderId');
  });

  it('keeps links to folders that exist only locally', () => {
    const plan = planImport([], [folder('f1', 'Novels')], buildBackup([rec({ id: 'r', folderId: 'f1' })], [], []));
    expect(plan.write[0]?.folderId).toBe('f1');
  });

  it('does not touch records whose stored copy is newer, even if the folder differs', () => {
    const stored = rec({ id: 'r', updatedAt: 500 });
    const plan = planImport([stored], [], buildBackup([{ ...stored, folderId: 'f1', updatedAt: 100 }], [folder('f1', 'X')], []));
    expect(plan.write).toEqual([]);
    expect(plan.skipped).toBe(1);
  });
});

/** manifest.json text with these fields replaced. */
const manifest = (patch: object = {}) => JSON.stringify({ ...buildManifest({ records: 0, images: 0 }, []), ...patch });

describe('folders in manifest.json', () => {
  it('round-trips folders', () => {
    const m = buildManifest({ records: 0, images: 0 }, [folder('f', 'Novels')]);
    expect(parseManifest(JSON.stringify(m)).folders).toEqual([folder('f', 'Novels')]);
  });

  it('cleans folder names and rejects invalid folders', () => {
    expect(parseManifest(manifest({ folders: [folder('f', '  A   b ')] })).folders[0]?.name).toBe('A b');
    expect(() => parseManifest(manifest({ folders: 'x' }))).toThrow(/folders list/);
    expect(() => parseManifest(manifest({ folders: [{ ...folder('f', 'A'), id: '' }] }))).toThrow(/"id"/);
    expect(() => parseManifest(manifest({ folders: [folder('f', '   ')] }))).toThrow(/"name"/);
    expect(() => parseManifest(manifest({ folders: [{ ...folder('f', 'A'), updatedAt: 'x' }] }))).toThrow(/"updatedAt"/);
  });

  it('carries folder emoji and colour, and Home colour; drops invalid ones', () => {
    const f = { ...folder('f', 'Novels'), emoji: '📚', color: 'teal' as const };
    const m = buildManifest({ records: 0, images: 0 }, [f], { color: 'pink', updatedAt: 5 });
    const back = parseManifest(JSON.stringify(m));
    expect(back.folders[0]).toEqual(f);
    expect(back.home).toEqual({ color: 'pink', updatedAt: 5 });
    const bad = parseManifest(
      manifest({
        folders: [{ ...folder('g', 'X'), emoji: 'abc', color: 'chartreuse' }],
        home: { color: 1, emoji: '🐱', updatedAt: 1 },
      }),
    );
    expect(bad.folders[0]).toEqual(folder('g', 'X'));
    expect(bad.home).toEqual({ updatedAt: 1 });
  });

  it('keeps a folder image size, drops the default, and ignores unknown values', () => {
    const parse = (imageSize: unknown) => parseManifest(manifest({ folders: [{ ...folder('f', 'A'), imageSize }] })).folders[0];
    expect(parse('xlarge')?.imageSize).toBe('xlarge');
    expect(parse('small')?.imageSize).toBe('small');
    expect(parse('medium')).not.toHaveProperty('imageSize');
    expect(parse('gigantic')).not.toHaveProperty('imageSize');
    expect(parse(undefined)).not.toHaveProperty('imageSize');
  });

  it('keeps link marking only when on', () => {
    const parse = (markLinks: unknown) => parseManifest(manifest({ folders: [{ ...folder('f', 'A'), markLinks }] })).folders[0];
    expect(parse(true)?.markLinks).toBe(true);
    expect(parse(false)).not.toHaveProperty('markLinks');
    expect(parse('yes')).not.toHaveProperty('markLinks');
    expect(parse(undefined)).not.toHaveProperty('markLinks');
  });

  it('merges a newer folder image size like any other folder change', () => {
    const local = folder('f1', 'Art', 100);
    const plan = planImport([], [local], buildBackup([], [{ ...folder('f1', 'Art', 200), imageSize: 'large' }], []));
    expect(plan.writeFolders).toEqual([{ ...folder('f1', 'Art', 200), imageSize: 'large' }]);
  });
});

describe('Home settings in backups', () => {
  const base = () => buildBackup([], [], []);

  it('round-trips the Home image size', () => {
    const m = buildManifest({ records: 0, images: 0 }, [], { imageSize: 'large', updatedAt: 5 });
    expect(parseManifest(JSON.stringify(m)).home).toEqual({ imageSize: 'large', updatedAt: 5 });
  });

  it('round-trips Home link marking', () => {
    const m = buildManifest({ records: 0, images: 0 }, [], { markLinks: true, updatedAt: 5 });
    expect(parseManifest(JSON.stringify(m)).home).toEqual({ markLinks: true, updatedAt: 5 });
  });

  it('treats missing or malformed Home settings as absent, and drops unknown sizes', () => {
    expect(parseManifest(manifest()).home).toBeUndefined();
    expect(parseManifest(manifest({ home: 'x' })).home).toBeUndefined();
    expect(parseManifest(manifest({ home: { imageSize: 'large' } })).home).toBeUndefined();
    expect(parseManifest(manifest({ home: { imageSize: 'huge', updatedAt: 1 } })).home).toEqual({ updatedAt: 1 });
  });

  it('imports Home settings only when newer than the stored ones', () => {
    const file = buildBackup([], [], [], { imageSize: 'xlarge', updatedAt: 200 });
    expect(planImport([], [], file).writeHome).toEqual({ imageSize: 'xlarge', updatedAt: 200 });
    expect(planImport([], [], file, { updatedAt: 100 }).writeHome).toEqual({ imageSize: 'xlarge', updatedAt: 200 });
    expect(planImport([], [], file, { imageSize: 'small', updatedAt: 300 }).writeHome).toBeUndefined();
    expect(planImport([], [], base(), { updatedAt: 1 }).writeHome).toBeUndefined();
  });
});

describe('read mode in backups', () => {
  it('keeps Revisit on folders, drops the default and unknown values, and ignores it for Home', () => {
    const parse = (readMode: unknown) => parseManifest(manifest({ folders: [{ ...folder('f', 'A'), readMode }] })).folders[0];
    expect(parse('revisit')?.readMode).toBe('revisit');
    expect(parse('status')).not.toHaveProperty('readMode');
    expect(parse('weird')).not.toHaveProperty('readMode');

    // Home is always Status: a read mode for Home in a file is ignored.
    const home = parseManifest(manifest({ home: { readMode: 'revisit', imageSize: 'large', updatedAt: 3 } })).home;
    expect(home).toEqual({ imageSize: 'large', updatedAt: 3 });
  });
});

describe('preferred domains in backups', () => {
  const withDomains = (f: Folder, domains: unknown) => ({ ...f, domains });

  it('keeps valid domains (normalized) and drops invalid ones', () => {
    const parsed = parseManifest(
      manifest({ folders: [withDomains(folder('f', 'A'), ['https://www.X.com/a', 'nonsense', 5, 'x.com'])] }),
    );
    expect(parsed.folders[0]?.domains).toEqual(['x.com']);
    const none = parseManifest(manifest({ folders: [withDomains(folder('g', 'B'), 'x.com')] }));
    expect(none.folders[0]).not.toHaveProperty('domains');
  });

  it('keeps a domain unique on import: a local folder keeps it, the incoming one drops it', () => {
    const local = { ...folder('a', 'Artists'), domains: ['x.com'] };
    const incoming = { ...folder('v', 'Video'), domains: ['x.com', 'youtube.com'] };
    const plan = planImport([], [local], buildBackup([], [incoming], []));
    expect(plan.writeFolders).toEqual([{ ...folder('v', 'Video'), domains: ['youtube.com'] }]);
  });

  it('between two incoming folders, the first keeps the domain', () => {
    const one = { ...folder('one', 'One'), domains: ['x.com'] };
    const two = { ...folder('two', 'Two'), domains: ['x.com'] };
    const plan = planImport([], [], buildBackup([], [one, two], []));
    expect(plan.writeFolders.map((f) => f.domains)).toEqual([['x.com'], undefined]);
  });

  it('a newer copy of a local folder may keep its own domains', () => {
    const local = { ...folder('a', 'Artists', 100), domains: ['x.com'] };
    const newer = { ...folder('a', 'Artists', 200), domains: ['x.com', 'pixiv.net'] };
    expect(planImport([], [local], buildBackup([], [newer], [])).writeFolders[0]?.domains).toEqual(['x.com', 'pixiv.net']);
  });
});
