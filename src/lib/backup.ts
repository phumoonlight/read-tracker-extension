import { addDomainText } from './domains';
import { cleanFolderName } from './folders';
import { migrateRecord } from './migrate';
import { isHttpUrl } from './records';
import {
  BACKUP_FORMAT,
  FOLDER_NAME_MAX,
  IMAGE_SIZES,
  MAX_IMAGES,
  MAX_URLS,
  SCHEMA_VERSION,
  STATUSES,
  type BackupFile,
  type BackupImage,
  type Folder,
  type HomeSettings,
  type ImageSize,
  type ReadMode,
  type ReadingRecord,
} from './types';

export interface ImportPlan {
  /** Home settings to write (the file's copy is newer), or undefined to keep the stored ones. */
  writeHome?: HomeSettings;
  /** Folders to write (new ids, or incoming copies newer than the stored ones). */
  writeFolders: Folder[];
  /** Records to write (new ids, or incoming copies newer than the stored ones). */
  write: ReadingRecord[];
  /** Images from the file to store (only those of written records, not already stored). */
  putImages: BackupImage[];
  /** Stored image ids to delete: images of replaced records that the winning copy no longer lists. */
  deleteImages: string[];
  added: number;
  updated: number;
  /** Incoming records ignored because the stored copy is the same age or newer. */
  skipped: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function assertRecord(r: unknown, i: number): asserts r is ReadingRecord {
  const bad = (field: string) => new Error(`Record #${i + 1}: missing or invalid "${field}".`);
  if (!isObj(r)) throw new Error(`Record #${i + 1} is not an object.`);
  for (const f of ['id', 'title', 'url', 'matchKey'] as const) if (typeof r[f] !== 'string') throw bad(f);
  if (r.matchMode !== 'exact' && r.matchMode !== 'prefix') throw bad('matchMode');
  if (!STATUSES.includes(r.status as never)) throw bad('status');
  if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === 'string')) throw bad('tags');
  if (
    !Array.isArray(r.images) ||
    r.images.length > MAX_IMAGES ||
    !r.images.every((id) => typeof id === 'string' && id) ||
    new Set(r.images).size !== r.images.length
  ) {
    throw bad('images');
  }
  for (const f of ['createdAt', 'updatedAt'] as const) if (typeof r[f] !== 'number') throw bad(f);
  // Only http(s) links may come in from a file (no javascript:, data:, etc.).
  if (!isHttpUrl(r.url)) throw bad('url');
  if (r.lastReadUrl !== undefined && !isHttpUrl(r.lastReadUrl)) throw bad('lastReadUrl');
  if (r.notes !== undefined && typeof r.notes !== 'string') throw bad('notes');
  if (r.readAt !== undefined && typeof r.readAt !== 'number') throw bad('readAt');
  if (r.folderId !== undefined && (typeof r.folderId !== 'string' || !r.folderId)) throw bad('folderId');
  if (r.otherUrls !== undefined) {
    const ok =
      Array.isArray(r.otherUrls) &&
      r.otherUrls.length < MAX_URLS &&
      r.otherUrls.every(
        (e) =>
          isObj(e) &&
          isHttpUrl(e.url) &&
          (e.matchMode === 'exact' || e.matchMode === 'prefix') &&
          typeof e.matchKey === 'string' &&
          e.matchKey !== '',
      );
    if (!ok) throw bad('otherUrls');
  }
}

/** Unknown sizes (e.g. from a newer build) fall back to the default rather than failing the import. */
function parseImageSize(v: unknown): ImageSize | undefined {
  return IMAGE_SIZES.includes(v as ImageSize) ? (v as ImageSize) : undefined;
}

/** Home settings from a file; malformed values are dropped (defaults), never fatal. */
/** Unknown modes fall back to the default ('status'), stored as absent. */
function parseReadMode(v: unknown): { readMode?: ReadMode } {
  return v === 'revisit' ? { readMode: 'revisit' } : {};
}

function parseHome(v: unknown): HomeSettings | undefined {
  if (!isObj(v) || typeof v.updatedAt !== 'number') return undefined;
  const imageSize = parseImageSize(v.imageSize);
  return {
    ...(imageSize && imageSize !== 'medium' ? { imageSize } : {}),
    // Home is always Status: a read mode from an older file is ignored.
    updatedAt: v.updatedAt,
  };
}

function parseFolder(f: unknown, i: number): Folder {
  const bad = (field: string) => new Error(`Folder #${i + 1}: missing or invalid "${field}".`);
  if (!isObj(f)) throw new Error(`Folder #${i + 1} is not an object.`);
  if (typeof f.id !== 'string' || !f.id) throw bad('id');
  if (typeof f.name !== 'string') throw bad('name');
  const name = cleanFolderName(f.name);
  if (!name || name.length > FOLDER_NAME_MAX) throw bad('name');
  for (const k of ['createdAt', 'updatedAt'] as const) if (typeof f[k] !== 'number') throw bad(k);
  const imageSize = parseImageSize(f.imageSize);
  // Preferred domains: keep valid ones (normalized, no duplicates); anything else is dropped.
  const domains = Array.isArray(f.domains)
    ? addDomainText([], f.domains.filter((d): d is string => typeof d === 'string').join(','))
    : [];
  return {
    id: f.id,
    name,
    ...(imageSize && imageSize !== 'medium' ? { imageSize } : {}),
    ...parseReadMode(f.readMode),
    ...(domains.length ? { domains } : {}),
    createdAt: f.createdAt as number,
    updatedAt: f.updatedAt as number,
  };
}

/** Path of an image inside a ZIP backup: under images/, no "..", no absolute path. */
export function isImagePath(v: unknown): v is string {
  return typeof v === 'string' && /^images\/[^/\\]+$/.test(v) && !v.includes('..');
}

/**
 * Parse and validate backup.json from a ZIP backup. Older schema versions are migrated;
 * newer ones are rejected.
 */
export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  if (!isObj(data) || data.format !== BACKUP_FORMAT) throw new Error('Not a Read Tracker backup file.');
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('Backup has no valid version number.');
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(`Backup is from a newer version (schema v${version}). Update the extension first.`);
  }
  if (!Array.isArray(data.records)) throw new Error('Backup has no records list.');
  if (data.folders !== undefined && !Array.isArray(data.folders)) throw new Error('Backup has an invalid folders list.');

  const records = data.records.map((raw, i) => {
    if (!isObj(raw)) throw new Error(`Record #${i + 1} is not an object.`);
    const r = migrateRecord(raw, version);
    assertRecord(r, i);
    return r;
  });
  const folders = ((data.folders as unknown[] | undefined) ?? []).map(parseFolder);
  const home = parseHome(data.home);
  // Entries that are malformed or have an unsafe path are dropped; records then simply lack that image.
  const images: BackupImage[] = [];
  for (const img of Array.isArray(data.images) ? data.images : []) {
    if (!isObj(img) || typeof img.id !== 'string' || !img.id || typeof img.recordId !== 'string') continue;
    if (isImagePath(img.file)) images.push({ id: img.id, recordId: img.recordId, file: img.file });
  }
  return {
    format: BACKUP_FORMAT,
    version: SCHEMA_VERSION,
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : 0,
    records,
    folders,
    images,
    ...(home ? { home } : {}),
  };
}

/** Keep the newest copy per id (a file may repeat an id). */
function newestById<T extends { id: string; updatedAt: number }>(items: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const it of items) {
    const prev = out.get(it.id);
    if (!prev || it.updatedAt > prev.updatedAt) out.set(it.id, it);
  }
  return out;
}

const nameKey = (name: string) => cleanFolderName(name).toLocaleLowerCase();

/**
 * Merge by id: an incoming record or folder replaces the stored one only if its
 * updatedAt is strictly newer.
 *
 * Folders: an incoming folder with a new id but the same name (case-insensitive) as an
 * existing folder is not created; its records go into the existing folder. A newer
 * incoming rename that would collide with another folder's name is skipped.
 *
 * Records: a written record keeps only the image ids that the file carries for it (or
 * that are already stored for it); images of the replaced copy that are no longer listed
 * are deleted. A folderId that names no known folder becomes Home (no folder).
 */
export function planImport(
  existing: ReadingRecord[],
  existingFolders: Folder[],
  backup: BackupFile,
  existingHome?: HomeSettings,
): ImportPlan {
  const plan: ImportPlan = {
    writeFolders: [],
    write: [],
    putImages: [],
    deleteImages: [],
    added: 0,
    updated: 0,
    skipped: 0,
  };

  // --- Home settings: newer wins, like folders.
  if (backup.home && backup.home.updatedAt > (existingHome?.updatedAt ?? -Infinity)) plan.writeHome = backup.home;

  // --- folders
  const folderById = new Map(existingFolders.map((f) => [f.id, f]));
  const idByName = new Map(existingFolders.map((f) => [nameKey(f.name), f.id]));
  /** Incoming folder id -> folder id to use locally. */
  const folderIdMap = new Map<string, string>();

  for (const f of newestById(backup.folders).values()) {
    const current = folderById.get(f.id);
    const sameNameId = idByName.get(nameKey(f.name));
    if (current) {
      folderIdMap.set(f.id, f.id);
      const collides = sameNameId !== undefined && sameNameId !== f.id;
      if (f.updatedAt > current.updatedAt && !collides) {
        plan.writeFolders.push(f);
        idByName.delete(nameKey(current.name));
        idByName.set(nameKey(f.name), f.id);
        folderById.set(f.id, f);
      }
    } else if (sameNameId !== undefined) {
      folderIdMap.set(f.id, sameNameId);
    } else {
      plan.writeFolders.push(f);
      folderIdMap.set(f.id, f.id);
      idByName.set(nameKey(f.name), f.id);
      folderById.set(f.id, f);
    }
  }
  // A preferred domain belongs to one folder: local folders that aren't being replaced keep
  // theirs; an incoming folder drops any domain already claimed (first one wins).
  const writing = new Set(plan.writeFolders.map((f) => f.id));
  const claimed = new Map<string, string>();
  for (const f of folderById.values()) {
    if (!writing.has(f.id)) for (const d of f.domains ?? []) claimed.set(d, f.id);
  }
  plan.writeFolders = plan.writeFolders.map((f) => {
    const kept = (f.domains ?? []).filter((d) => {
      const owner = claimed.get(d);
      if (owner !== undefined && owner !== f.id) return false;
      claimed.set(d, f.id);
      return true;
    });
    const { domains: _d, ...rest } = f;
    void _d;
    return kept.length ? { ...rest, domains: kept } : rest;
  });

  const resolveFolder = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const mapped = folderIdMap.get(id) ?? id;
    return folderById.has(mapped) ? mapped : undefined;
  };

  // --- records
  const byId = new Map(existing.map((r) => [r.id, r]));
  const fileImages = new Map(backup.images.map((img) => [img.id, img]));
  /** Stored image id -> owning record id (an id is never re-pointed at another record). */
  const owner = new Map(existing.flatMap((r) => r.images.map((id) => [id, r.id] as const)));
  for (const r of newestById(backup.records).values()) {
    const current = byId.get(r.id);
    if (current && r.updatedAt <= current.updatedAt) {
      plan.skipped++;
      continue;
    }
    const stored = new Set(current?.images ?? []);
    const images = r.images.filter(
      (id) => stored.has(id) || (fileImages.get(id)?.recordId === r.id && !owner.has(id)),
    );
    for (const id of images) {
      const img = fileImages.get(id);
      if (img && !stored.has(id)) plan.putImages.push(img);
    }
    for (const id of stored) if (!images.includes(id)) plan.deleteImages.push(id);

    const { folderId, ...rest } = r;
    const resolved = resolveFolder(folderId);
    plan.write.push({ ...rest, ...(resolved ? { folderId: resolved } : {}), images });
    if (current) plan.updated++;
    else plan.added++;
  }
  return plan;
}

export function buildBackup(
  records: ReadingRecord[],
  folders: Folder[],
  images: BackupImage[],
  home?: HomeSettings,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: SCHEMA_VERSION,
    exportedAt: Date.now(),
    records,
    folders,
    images,
    ...(home ? { home } : {}),
  };
}

/** Name of the JSON part inside a ZIP backup. */
export const BACKUP_JSON = 'backup.json';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/** Path for an image's original file inside a ZIP backup: images/<id>.<ext> (id made filename-safe). */
export function imagePath(id: string, type: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_') || 'image';
  return `images/${safe}.${EXTENSIONS[type] ?? 'bin'}`;
}

/** MIME type for an image path's extension (files from a ZIP have none of their own). */
export function typeForImagePath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpeg') return 'image/jpeg';
  return Object.entries(EXTENSIONS).find(([, e]) => e === ext)?.[0] ?? '';
}
