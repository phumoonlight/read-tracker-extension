/** Bump when the stored record shape changes, and add a step in migrate.ts. */
export const SCHEMA_VERSION = 3;

export type MatchMode = 'exact' | 'prefix';
export type ReadStatus = 'unread' | 'reading' | 'read';

export const STATUSES: readonly ReadStatus[] = ['unread', 'reading', 'read'];

export const STATUS_LABEL: Record<ReadStatus, string> = {
  unread: 'Unread',
  reading: 'Reading',
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
  /** Prefix records only: the raw URL of the last matching page visited while status was "reading". */
  lastReadUrl?: string;
  tags: string[];
  /** Folder the record is grouped in; undefined = no folder (the default). Added in schema v2. */
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
  createdAt: number;
  updatedAt: number;
}

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
}

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
