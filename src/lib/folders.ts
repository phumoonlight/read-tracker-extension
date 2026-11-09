import { FOLDER_NAME_MAX, type Folder } from './types';

/** Collapse whitespace and trim. Names are compared case-insensitively. */
export const cleanFolderName = (name: string) => name.replace(/\s+/g, ' ').trim();

/**
 * Error message for an invalid folder name, or null if it is fine.
 * `exceptId` skips the folder being renamed in the duplicate check.
 */
export function folderNameError(name: string, folders: readonly Folder[], exceptId?: string): string | null {
  const clean = cleanFolderName(name);
  if (!clean) return 'Folder name is required.';
  if (clean.length > FOLDER_NAME_MAX) return `Folder name must be at most ${FOLDER_NAME_MAX} characters.`;
  const lower = clean.toLocaleLowerCase();
  if (folders.some((f) => f.id !== exceptId && f.name.toLocaleLowerCase() === lower)) {
    return `A folder named “${clean}” already exists.`;
  }
  return null;
}

export function newFolder(name: string): Folder {
  const now = Date.now();
  return { id: crypto.randomUUID(), name: cleanFolderName(name), createdAt: now, updatedAt: now };
}

export const sortFolders = (folders: readonly Folder[]) =>
  [...folders].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

/**
 * Which place the list shows: null = Home (records without a folder, the default),
 * string = that folder's id. Stored as text with a prefix on ids so a folder id can
 * never be read as Home. Older stored values ("all", "none") and anything unknown mean Home.
 */
export const encodeFolderFilter = (f: string | null) => (f === null ? 'home' : `f:${f}`);

export function decodeFolderFilter(s: string | null): string | null {
  if (s?.startsWith('f:') && s.length > 2) return s.slice(2);
  return null;
}
