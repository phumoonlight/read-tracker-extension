/** Bump when the stored record shape changes, and add a step in migrate.ts. */
export const SCHEMA_VERSION = 2;

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
  hasThumbnail: boolean;
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
  /** Record id -> data URL. */
  thumbnails: Record<string, string>;
}

export const BACKUP_FORMAT = 'read-tracker-backup';
