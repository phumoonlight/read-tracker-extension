/** Bump when the stored record shape changes, and add a step in migrate.ts. */
export const SCHEMA_VERSION = 1;

export type MatchMode = 'exact' | 'prefix';
/** Two states. */
export type ReadStatus = 'unread' | 'read';

export const STATUSES: readonly ReadStatus[] = ['unread', 'read'];

export const STATUS_LABEL: Record<ReadStatus, string> = {
  unread: 'Unread',
  read: 'Read',
};

export interface ReadingRecord {
  id: string;
  title: string;
  /** URL as the user entered it. Used for "open" links. */
  url: string;
  /** normalizeUrl() output used for matching (the full page for exact, the series root for prefix). */
  matchKey: string;
  matchMode: MatchMode;
  status: ReadStatus;
  /** Series (prefix) URLs only: the raw URL of the last matching page visited while not yet read. */
  lastReadUrl?: string;
  tags: string[];
  /**
   * More URLs for the same thing (e.g. a mirror, or the series on another site). Each matches
   * on its own like the main url / matchKey / matchMode above.
   */
  otherUrls?: UrlEntry[];
  /** Folder the record is grouped in; undefined = Home (no folder, the default). */
  folderId?: string;
  notes?: string;
  /**
   * Ids of the record's images (store "images"), in display order; the first is the
   * cover. At most MAX_IMAGES.
   */
  images: string[];
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  readAt?: number;
  /** Starred by the user (the list can show only these). Absent = not a favorite; never stored as false. */
  favorite?: true;
}

/** A flat group of records. A record is in at most one folder. */
export interface Folder {
  id: string;
  name: string;
  /** How big images display while this folder is open; absent = 'medium'. */
  imageSize?: ImageSize;
  /** How records here are read; absent = 'status'. */
  readMode?: ReadMode;
  /**
   * Preferred domains (normalized, e.g. "x.com"): adding a page on one of them preselects
   * this folder. Each domain belongs to at most one folder. Absent = none.
   */
  domains?: string[];
  /** Dim links to this folder's records on websites (see lib/link-marks.ts). Absent = off. */
  markLinks?: boolean;
  /** Colour of the folder's name (a palette key or "#rrggbb", see FolderColor). Absent = the normal text colour. */
  color?: FolderColor;
  /** One emoji shown before the name (see cleanEmoji in folders.ts). Absent = none. */
  emoji?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Name colours for places (Home and folders): a palette key (base.css tokens, a light and a
 * dark shade each) or a custom "#rrggbb" from the colour picker (used as is in both themes).
 */
export type PaletteColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink';
export type FolderColor = PaletteColor | `#${string}`;
export const FOLDER_COLORS: readonly PaletteColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
/** Home's emoji: always shown, can't be changed. */
export const HOME_EMOJI = '🏠';

export type ImageSize = 'small' | 'medium' | 'large' | 'xlarge';
export const IMAGE_SIZES: readonly ImageSize[] = ['small', 'medium', 'large', 'xlarge'];
export const IMAGE_SIZE_LABEL: Record<ImageSize, string> = { small: 'S', medium: 'M', large: 'L', xlarge: 'XL' };
/** Sizes big enough that card images use the original file instead of the ≤480px preview. */
export const usesOriginalImages = (size: ImageSize) => size === 'large' || size === 'xlarge';

export const FOLDER_NAME_MAX = 60;

/** A backup read from a ZIP (manifest.json + records.jsonl + images found by id), ready to merge. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  records: ReadingRecord[];
  folders: Folder[];
  /** Original image files, by path inside the ZIP. */
  images: BackupImage[];
  /** Home's display settings; absent = defaults. */
  home?: HomeSettings;
}

/** Settings for Home, the place for records without a folder (it has no Folder record). Home always uses the Status read mode (it has no read mode setting). */
export interface HomeSettings {
  /** Absent = 'medium'. */
  imageSize?: ImageSize;
  /** Dim links to Home's records on websites. Absent = off. */
  markLinks?: boolean;
  /** Colour of Home's name. Absent = the normal text colour. (Home's emoji is always HOME_EMOJI.) */
  color?: FolderColor;
  updatedAt: number;
}

/**
 * How a place (Home or a folder) tracks reading:
 * - 'status': unread / read (the default).
 * - 'revisit': things you come back to repeatedly. Holding "Update read" stamps readAt,
 *   and the list is always least recently read first (never read at the top).
 */
export type ReadMode = 'status' | 'revisit';
export const READ_MODES: readonly ReadMode[] = ['status', 'revisit'];
export const READ_MODE_LABEL: Record<ReadMode, string> = { status: 'Status', revisit: 'Revisit' };

/** One image in a backup: `file` is the original file's path inside the ZIP, e.g. "images/<id>.jpg". */
export interface BackupImage {
  id: string;
  recordId: string;
  file: string;
}

export const MAX_IMAGES = 3;

export const BACKUP_FORMAT = 'read-tracker-backup';

/** One URL of a record and how it matches (the main URL is url / matchKey / matchMode on the record). */
export interface UrlEntry {
  url: string;
  matchMode: MatchMode;
  matchKey: string;
}

/** Most URLs a record can have, main URL included. */
export const MAX_URLS = 10;
