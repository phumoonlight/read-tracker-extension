import { FOLDER_COLORS, FOLDER_NAME_MAX, type Folder, type FolderColor, type PaletteColor } from './types';
import { newId } from './ids';

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

/**
 * A folder's emoji from what was typed or pasted: its first character if that is an emoji
 * (including flags, keycaps, skin tones and ZWJ sequences such as 👩‍💻), else undefined.
 */
export function cleanEmoji(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next()
    .value?.segment;
  if (!first) return undefined;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(first) ? first : undefined;
}

/**
 * A colour from a file or an input: a palette key, or "#rrggbb" (lowercased; "#rgb" is
 * expanded). Anything else is undefined (no colour).
 */
export function cleanFolderColor(v: unknown): FolderColor | undefined {
  if (FOLDER_COLORS.includes(v as PaletteColor)) return v as PaletteColor;
  if (typeof v !== 'string') return undefined;
  const hex = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex as FolderColor;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map((c) => c + c).join('')}`;
  return undefined;
}

/** Whether a colour is a custom "#rrggbb" (not a palette key). */
export const isCustomColor = (c: FolderColor | undefined): c is `#${string}` => !!c && c.startsWith('#');

export function newFolder(name: string): Folder {
  const now = Date.now();
  return { id: newId(), name: cleanFolderName(name), createdAt: now, updatedAt: now };
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
