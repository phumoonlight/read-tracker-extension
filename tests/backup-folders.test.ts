import { describe, expect, it } from 'vitest';
import { buildBackup, parseBackup, planImport } from '@/lib/backup';
import { BACKUP_FORMAT, type Folder } from '@/lib/types';
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

describe('parseBackup with folders', () => {
  it('reads v1 backups (no folders, no folderId) and upgrades them', () => {
    const v1 = { format: BACKUP_FORMAT, version: 1, exportedAt: 1, records: [rec({ id: 'a' })], thumbnails: {} };
    const parsed = parseBackup(JSON.stringify(v1));
    expect(parsed.folders).toEqual([]);
    expect(parsed.records[0]).not.toHaveProperty('folderId');
  });

  it('round-trips folders', () => {
    const b = buildBackup([rec({ id: 'r', folderId: 'f' })], [folder('f', 'Novels')], []);
    const parsed = parseBackup(JSON.stringify(b));
    expect(parsed.folders).toEqual([folder('f', 'Novels')]);
    expect(parsed.records[0]?.folderId).toBe('f');
  });

  it('cleans folder names and rejects invalid folders', () => {
    const base = buildBackup([], [], []);
    expect(parseBackup(JSON.stringify({ ...base, folders: [folder('f', '  A   b ')] })).folders[0]?.name).toBe('A b');
    expect(() => parseBackup(JSON.stringify({ ...base, folders: 'x' }))).toThrow(/folders list/);
    expect(() => parseBackup(JSON.stringify({ ...base, folders: [{ ...folder('f', 'A'), id: '' }] }))).toThrow(/"id"/);
    expect(() => parseBackup(JSON.stringify({ ...base, folders: [folder('f', '   ')] }))).toThrow(/"name"/);
    expect(() => parseBackup(JSON.stringify({ ...base, folders: [{ ...folder('f', 'A'), updatedAt: 'x' }] }))).toThrow(
      /"updatedAt"/,
    );
  });

  it('keeps a folder image size, drops the default, and ignores unknown values', () => {
    const base = buildBackup([], [], []);
    const parse = (imageSize: unknown) =>
      parseBackup(JSON.stringify({ ...base, folders: [{ ...folder('f', 'A'), imageSize }] })).folders[0];
    expect(parse('xlarge')?.imageSize).toBe('xlarge');
    expect(parse('small')?.imageSize).toBe('small');
    expect(parse('medium')).not.toHaveProperty('imageSize');
    expect(parse('gigantic')).not.toHaveProperty('imageSize');
    expect(parse(undefined)).not.toHaveProperty('imageSize');
  });

  it('merges a newer folder image size like any other folder change', () => {
    const local = folder('f1', 'Art', 100);
    const plan = planImport([], [local], buildBackup([], [{ ...folder('f1', 'Art', 200), imageSize: 'large' }], []));
    expect(plan.writeFolders).toEqual([{ ...folder('f1', 'Art', 200), imageSize: 'large' }]);
  });

  it('rejects a record with an invalid folderId', () => {
    const base = buildBackup([], [], []);
    for (const folderId of [5, '']) {
      expect(() => parseBackup(JSON.stringify({ ...base, records: [{ ...rec(), folderId }] }))).toThrow(/"folderId"/);
    }
  });
});

describe('Home settings in backups', () => {
  const base = () => buildBackup([], [], []);

  it('round-trips the Home image size', () => {
    const b = buildBackup([], [], [], { imageSize: 'large', updatedAt: 5 });
    expect(parseBackup(JSON.stringify(b)).home).toEqual({ imageSize: 'large', updatedAt: 5 });
  });

  it('treats missing or malformed Home settings as absent, and drops unknown sizes', () => {
    expect(parseBackup(JSON.stringify(base())).home).toBeUndefined();
    expect(parseBackup(JSON.stringify({ ...base(), home: 'x' })).home).toBeUndefined();
    expect(parseBackup(JSON.stringify({ ...base(), home: { imageSize: 'large' } })).home).toBeUndefined();
    expect(parseBackup(JSON.stringify({ ...base(), home: { imageSize: 'huge', updatedAt: 1 } })).home).toEqual({
      updatedAt: 1,
    });
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
  const base = () => buildBackup([], [], []);

  it('keeps Revisit on folders, drops the default and unknown values, and ignores it for Home', () => {
    const parse = (readMode: unknown) =>
      parseBackup(JSON.stringify({ ...base(), folders: [{ ...folder('f', 'A'), readMode }] })).folders[0];
    expect(parse('revisit')?.readMode).toBe('revisit');
    expect(parse('status')).not.toHaveProperty('readMode');
    expect(parse('weird')).not.toHaveProperty('readMode');

    // Home is always Status: a read mode for Home in a file is ignored.
    const home = parseBackup(JSON.stringify({ ...base(), home: { readMode: 'revisit', imageSize: 'large', updatedAt: 3 } })).home;
    expect(home).toEqual({ imageSize: 'large', updatedAt: 3 });
  });
});

describe('preferred domains in backups', () => {
  const base = () => buildBackup([], [], []);
  const withDomains = (f: Folder, domains: unknown) => ({ ...f, domains });

  it('keeps valid domains (normalized) and drops invalid ones', () => {
    const parsed = parseBackup(
      JSON.stringify({ ...base(), folders: [withDomains(folder('f', 'A'), ['https://www.X.com/a', 'nonsense', 5, 'x.com'])] }),
    );
    expect(parsed.folders[0]?.domains).toEqual(['x.com']);
    const none = parseBackup(JSON.stringify({ ...base(), folders: [withDomains(folder('g', 'B'), 'x.com')] }));
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
