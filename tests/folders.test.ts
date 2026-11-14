import { describe, expect, it } from 'vitest';
import {
  cleanEmoji,
  cleanFolderColor,
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
  it('round-trips Home and folder ids', () => {
    for (const f of [null, 'abc', 'all', 'none', 'home', 'f:x']) {
      expect(decodeFolderFilter(encodeFolderFilter(f))).toBe(f);
    }
  });
  it('reads older values ("all", "none"), missing and unknown values as Home', () => {
    for (const s of [null, 'all', 'none', 'home', 'garbage', 'f:']) {
      expect(decodeFolderFilter(s)).toBeNull();
    }
  });
});

describe('folder emoji and colour', () => {
  it('keeps the first character only when it is an emoji', () => {
    expect(cleanEmoji('📚')).toBe('📚');
    expect(cleanEmoji(' 📚 books')).toBe('📚');
    expect(cleanEmoji('👩‍💻x')).toBe('👩‍💻'); // ZWJ sequence: one character
    expect(cleanEmoji('👍🏽')).toBe('👍🏽'); // skin tone
    expect(cleanEmoji('🇯🇵')).toBe('🇯🇵'); // flag
    expect(cleanEmoji('1️⃣')).toBe('1️⃣'); // keycap
    expect(cleanEmoji('❤️')).toBe('❤️');
    expect(cleanEmoji('a📚')).toBeUndefined();
    expect(cleanEmoji('1')).toBeUndefined();
    expect(cleanEmoji('')).toBeUndefined();
    expect(cleanEmoji('   ')).toBeUndefined();
    expect(cleanEmoji(5)).toBeUndefined();
  });

  it('knows the palette colours only', () => {
    expect(cleanFolderColor('teal')).toBe('teal');
    expect(cleanFolderColor('#ff0000')).toBeUndefined();
    expect(cleanFolderColor(undefined)).toBeUndefined();
  });
});
