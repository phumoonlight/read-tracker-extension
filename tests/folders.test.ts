import { describe, expect, it } from 'vitest';
import {
  cleanFolderName,
  decodeFolderFilter,
  encodeFolderFilter,
  folderNameError,
  newFolder,
  sortFolders,
} from '@/lib/folders';
import { FOLDER_NAME_MAX, type Folder } from '@/lib/types';

const folder = (id: string, name: string): Folder => ({ id, name, createdAt: 1, updatedAt: 1 });

describe('folder names', () => {
  it('collapses whitespace and trims', () => {
    expect(cleanFolderName('  Light   novels \n')).toBe('Light novels');
  });

  it('rejects empty and over-long names', () => {
    expect(folderNameError('   ', [])).toMatch(/required/);
    expect(folderNameError('x'.repeat(FOLDER_NAME_MAX + 1), [])).toMatch(/at most/);
    expect(folderNameError('x'.repeat(FOLDER_NAME_MAX), [])).toBeNull();
  });

  it('rejects duplicates case-insensitively, ignoring extra spaces', () => {
    const existing = [folder('a', 'Novels')];
    expect(folderNameError('novels', existing)).toMatch(/already exists/);
    expect(folderNameError('  NOVELS ', existing)).toMatch(/already exists/);
    expect(folderNameError('Novels 2', existing)).toBeNull();
  });

  it('lets a folder keep (or recase) its own name when renaming', () => {
    const existing = [folder('a', 'Novels'), folder('b', 'Comics')];
    expect(folderNameError('NOVELS', existing, 'a')).toBeNull();
    expect(folderNameError('comics', existing, 'a')).toMatch(/already exists/);
  });

  it('creates folders with a cleaned name and timestamps', () => {
    const f = newFolder('  Later  ');
    expect(f).toMatchObject({ name: 'Later' });
    expect(typeof f.id).toBe('string');
    expect(f.createdAt).toBe(f.updatedAt);
  });

  it('sorts by name, case-insensitively', () => {
    expect(sortFolders([folder('1', 'beta'), folder('2', 'Alpha'), folder('3', 'gamma')]).map((f) => f.name)).toEqual([
      'Alpha',
      'beta',
      'gamma',
    ]);
  });
});

describe('folder filter encoding', () => {
  it('round-trips all, no folder and folder ids', () => {
    for (const f of [undefined, null, 'abc', 'all', 'none', 'f:x']) {
      expect(decodeFolderFilter(encodeFolderFilter(f))).toBe(f);
    }
  });
  it('treats missing or unknown values as all', () => {
    expect(decodeFolderFilter(null)).toBeUndefined();
    expect(decodeFolderFilter('garbage')).toBeUndefined();
    expect(decodeFolderFilter('f:')).toBeUndefined();
  });
});
