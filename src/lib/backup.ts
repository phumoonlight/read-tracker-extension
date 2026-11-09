import { normalizeDomain } from './domains';
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
  /** Things that were dropped or changed while merging, for the user (see describeIssues). */
  issues: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `where` names the record in errors, e.g. "Record #3" or "records.jsonl line 3". */
function assertRecord(r: unknown, where: string): asserts r is ReadingRecord {
  const bad = (field: string) => new Error(`${where}: missing or invalid "${field}".`);
  if (!isObj(r)) throw new Error(`${where} is not an object.`);
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

function parseFolder(f: unknown, i: number, issues?: string[]): Folder {
  const bad = (field: string) => new Error(`Folder #${i + 1}: missing or invalid "${field}".`);
  if (!isObj(f)) throw new Error(`Folder #${i + 1} is not an object.`);
  if (typeof f.id !== 'string' || !f.id) throw bad('id');
  if (typeof f.name !== 'string') throw bad('name');
  const name = cleanFolderName(f.name);
  if (!name || name.length > FOLDER_NAME_MAX) throw bad('name');
  for (const k of ['createdAt', 'updatedAt'] as const) if (typeof f[k] !== 'number') throw bad(k);
  const imageSize = parseImageSize(f.imageSize);
  // Preferred domains: keep valid ones (normalized, no duplicates); anything else is dropped.
  const domains: string[] = [];
  for (const d of Array.isArray(f.domains) ? f.domains : []) {
    const n = typeof d === 'string' ? normalizeDomain(d) : null;
    if (!n) issues?.push(`Folder “${name}”: ignored invalid preferred domain ${JSON.stringify(d)}.`);
    else if (!domains.includes(n)) domains.push(n);
  }
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

/** Check a backup's schema version: older ones are migrated, newer ones are rejected. */
function checkVersion(version: unknown): number {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('Backup has no valid version number.');
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(`Backup is from a newer version (schema v${version}). Update the extension first.`);
  }
  return version;
}

function parseRecordValue(raw: unknown, where: string, version: number): ReadingRecord {
  if (!isObj(raw)) throw new Error(`${where} is not an object.`);
  const r = migrateRecord(raw, version);
  assertRecord(r, where);
  return r;
}

// ---------------------------------------------------------------------------
// ZIP backup: manifest.json + records.jsonl + images/<id>.<ext>

/** Version of the ZIP's file layout (separate from the record SCHEMA_VERSION). */
export const BACKUP_LAYOUT = 1;
export const BACKUP_MANIFEST = 'manifest.json';
export const BACKUP_RECORDS = 'records.jsonl';

export interface BackupCounts {
  records: number;
  folders: number;
  images: number;
}

/** manifest.json: read first, so an import can be checked and previewed without reading the records. */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  layout: number;
  /** Record schema version of records.jsonl. */
  version: number;
  exportedAt: number;
  counts: BackupCounts;
  folders: Folder[];
  home?: HomeSettings;
}

export function buildManifest(
  counts: Omit<BackupCounts, 'folders'>,
  folders: Folder[],
  home?: HomeSettings,
  exportedAt = Date.now(),
): BackupManifest {
  return {
    format: BACKUP_FORMAT,
    layout: BACKUP_LAYOUT,
    version: SCHEMA_VERSION,
    exportedAt,
    counts: { ...counts, folders: folders.length },
    folders,
    ...(home ? { home } : {}),
  };
}

/** Parse and validate manifest.json. Throws a user-facing error; folder domain problems go to `issues`. */
export function parseManifest(text: string, issues: string[] = []): BackupManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${BACKUP_MANIFEST} is not valid JSON.`);
  }
  if (!isObj(data) || data.format !== BACKUP_FORMAT) throw new Error('Not a Read Tracker backup file.');
  const layout = data.layout;
  if (typeof layout !== 'number' || !Number.isInteger(layout) || layout < 1) {
    throw new Error('Backup has no valid layout version.');
  }
  if (layout > BACKUP_LAYOUT) throw new Error('Backup is from a newer version. Update the extension first.');
  const version = checkVersion(data.version);
  if (!Array.isArray(data.folders)) throw new Error('Backup has an invalid folders list.');
  const c = isObj(data.counts) ? data.counts : {};
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  const folders = data.folders.map((f, i) => parseFolder(f, i, issues));
  const home = parseHome(data.home);
  return {
    format: BACKUP_FORMAT,
    layout,
    version,
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : 0,
    counts: { records: count(c.records), folders: folders.length, images: count(c.images) },
    folders,
    ...(home ? { home } : {}),
  };
}

/** One records.jsonl line (1-based `lineNo` for errors). Any problem is fatal: nothing is imported. */
export function parseRecordLine(line: string, lineNo: number, version: number): ReadingRecord {
  const where = `${BACKUP_RECORDS} line ${lineNo}`;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`${where}: not valid JSON.`);
  }
  return parseRecordValue(raw, where, version);
}

/** One JSON value per line, newline-terminated (records.jsonl). */
export const toJsonLine = (v: unknown) => `${JSON.stringify(v)}\n`;

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
    issues: [],
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
      if (f.updatedAt > current.updatedAt) {
        if (collides) {
          plan.issues.push(`Folder “${current.name}”: not renamed to “${f.name}”, another folder already has that name.`);
        } else {
          plan.writeFolders.push(f);
          idByName.delete(nameKey(current.name));
          idByName.set(nameKey(f.name), f.id);
          folderById.set(f.id, f);
        }
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
      if (owner !== undefined && owner !== f.id) {
        const ownerName = folderById.get(owner)?.name ?? 'another folder';
        plan.issues.push(`Folder “${f.name}”: preferred domain ${d} already belongs to “${ownerName}”, not added.`);
        return false;
      }
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
    const images = r.images.filter((id) => {
      if (stored.has(id)) return true;
      const file = fileImages.get(id);
      if (file?.recordId === r.id && !owner.has(id)) return true;
      plan.issues.push(
        file === undefined
          ? `Record “${r.title}”: image ${id} is not in the backup, skipped.`
          : `Record “${r.title}”: image ${id} belongs to another record, skipped.`,
      );
      return false;
    });
    for (const id of images) {
      const img = fileImages.get(id);
      if (img && !stored.has(id)) plan.putImages.push(img);
    }
    for (const id of stored) if (!images.includes(id)) plan.deleteImages.push(id);

    const { folderId, ...rest } = r;
    const resolved = resolveFolder(folderId);
    if (folderId !== undefined && !resolved) plan.issues.push(`Record “${r.title}”: its folder isn't in the backup, added to Home.`);
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

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/** File name stem for an image id (ids are UUIDs, already safe; anything else is made filename-safe). */
export const imageStem = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_') || 'image';

/** Path for an image's original file inside a ZIP backup: images/<id>.<ext>. */
export function imagePath(id: string, type: string): string {
  return `images/${imageStem(id)}.${EXTENSIONS[type] ?? 'bin'}`;
}

/**
 * Index of the image files in a ZIP: name stem -> path, for entries directly under images/
 * ("images/<stem>" or "images/<stem>.<ext>"). The first file for a stem wins.
 */
export function imageIndex(paths: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    const m = /^images\/([^/\\]+)$/.exec(path);
    if (!m) continue;
    const name = m[1]!;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    if (!index.has(stem)) index.set(stem, path);
  }
  return index;
}

/**
 * The backup's images: each id a record lists whose file is in the ZIP. An id listed by two
 * records goes to the first (planImport reports the other). Ids without a file are left out;
 * planImport reports them on their record.
 */
export function imagesFromZip(records: readonly ReadingRecord[], index: ReadonlyMap<string, string>): BackupImage[] {
  const out: BackupImage[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const id of r.images) {
      const file = index.get(imageStem(id));
      if (file && !seen.has(id)) {
        seen.add(id);
        out.push({ id, recordId: r.id, file });
      }
    }
  }
  return out;
}

/** MIME type for an image path's extension (files from a ZIP have none of their own). */
export function typeForImagePath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpeg') return 'image/jpeg';
  return Object.entries(EXTENSIONS).find(([, e]) => e === ext)?.[0] ?? '';
}

/** At most `max` issues for display, plus how many more there were. */
export function describeIssues(issues: readonly string[], max = 100): { shown: string[]; more: number } {
  return { shown: issues.slice(0, max), more: Math.max(0, issues.length - max) };
}
