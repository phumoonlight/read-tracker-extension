/** Bump when the stored record shape changes, and add a step in migrate.ts. */
export const SCHEMA_VERSION = 5;

export type MatchMode = 'exact' | 'prefix';
/** Two states. (Schema v5 removed 'reading'; such records became 'unread'.) */
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
   * on its own like the main url / matchKey / matchMode above. Added in schema v4.
   */
  otherUrls?: UrlEntry[];
  /** Folder the record is grouped in; undefined = Home (no folder, the default). Added in schema v2. */
  folderId?: string;
  notes?: string;
  /**
   * Ids of the record's images (store "images"), in display order; the first is the
   * cover. At most MAX_IMAGES. Replaced `hasThumbnail` in schema v3.
   */
  images: string[];
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  readAt?: number;
}

/** A flat group of records. A record is in at most one folder. */
export interface Folder {
  id: string;
  name: string;
  /** How big images display while this folder is open; absent = 'medium'. */
  imageSize?: ImageSize;
  /** How records here are read; absent = 'status'. */
  readMode?: ReadMode;
  createdAt: number;
  updatedAt: number;
}

export type ImageSize = 'small' | 'medium' | 'large' | 'xlarge';
export const IMAGE_SIZES: readonly ImageSize[] = ['small', 'medium', 'large', 'xlarge'];
export const IMAGE_SIZE_LABEL: Record<ImageSize, string> = { small: 'S', medium: 'M', large: 'L', xlarge: 'XL' };
/** Sizes big enough that card images use the original file instead of the ≤480px preview. */
export const usesOriginalImages = (size: ImageSize) => size === 'large' || size === 'xlarge';

export const FOLDER_NAME_MAX = 60;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  records: ReadingRecord[];
  /** Added in schema v2; absent in v1 files. */
  folders: Folder[];
  /** Original image files (schema v3+). v1/v2 files had `thumbnails` (record id -> data URL) instead. */
  images: BackupImage[];
  /** Home's display settings; absent in older files (= defaults). */
  home?: HomeSettings;
}

/** Settings for Home, the place for records without a folder (it has no Folder record). */
/** Home's settings. Home always uses the Status read mode (it has no read mode setting). */
export interface HomeSettings {
  /** Absent = 'medium'. */
  imageSize?: ImageSize;
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

export interface BackupImage {
  id: string;
  recordId: string;
  /** The original file as a data URL (data:image/...). */
  dataUrl: string;
}

export const MAX_IMAGES = 3;

/** Id given to a record's single pre-v3 thumbnail when it became an image. */
export const legacyImageId = (recordId: string) => `legacy-${recordId}`;

export const BACKUP_FORMAT = 'read-tracker-backup';

/** One URL of a record and how it matches (the main URL is url / matchKey / matchMode on the record). */
export interface UrlEntry {
  url: string;
  matchMode: MatchMode;
  matchKey: string;
}

/** Most URLs a record can have, main URL included. */
export const MAX_URLS = 10;
