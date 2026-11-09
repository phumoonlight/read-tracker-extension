import { cleanFolderName } from './folders';
import { migrateRecord } from './migrate';
import { isHttpUrl } from './records';
import {
  BACKUP_FORMAT,
  FOLDER_NAME_MAX,
  SCHEMA_VERSION,
  STATUSES,
  type BackupFile,
  type Folder,
  type ReadingRecord,
} from './types';

export interface ImportPlan {
  /** Folders to write (new ids, or incoming copies newer than the stored ones). */
  writeFolders: Folder[];
  /** Records to write (new ids, or incoming copies newer than the stored ones). */
  write: ReadingRecord[];
  /** Thumbnails to store, by record id (data URLs). */
  putThumbnails: Record<string, string>;
  /** Record ids whose stored thumbnail must be removed (the winning copy has none). */
  deleteThumbnails: string[];
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
  if (typeof r.hasThumbnail !== 'boolean') throw bad('hasThumbnail');
  for (const f of ['createdAt', 'updatedAt'] as const) if (typeof r[f] !== 'number') throw bad(f);
  // Only http(s) links may come in from a file (no javascript:, data:, etc.).
  if (!isHttpUrl(r.url)) throw bad('url');
  if (r.lastReadUrl !== undefined && !isHttpUrl(r.lastReadUrl)) throw bad('lastReadUrl');
  if (r.notes !== undefined && typeof r.notes !== 'string') throw bad('notes');
  if (r.readAt !== undefined && typeof r.readAt !== 'number') throw bad('readAt');
  if (r.folderId !== undefined && (typeof r.folderId !== 'string' || !r.folderId)) throw bad('folderId');
}

function parseFolder(f: unknown, i: number): Folder {
  const bad = (field: string) => new Error(`Folder #${i + 1}: missing or invalid "${field}".`);
  if (!isObj(f)) throw new Error(`Folder #${i + 1} is not an object.`);
  if (typeof f.id !== 'string' || !f.id) throw bad('id');
  if (typeof f.name !== 'string') throw bad('name');
  const name = cleanFolderName(f.name);
  if (!name || name.length > FOLDER_NAME_MAX) throw bad('name');
  for (const k of ['createdAt', 'updatedAt'] as const) if (typeof f[k] !== 'number') throw bad(k);
  return { id: f.id, name, createdAt: f.createdAt as number, updatedAt: f.updatedAt as number };
}

/** Parse and validate a backup file's JSON text. Older schema versions are migrated; newer ones are rejected. */
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
  const thumbnails = isObj(data.thumbnails) ? data.thumbnails : {};

  const records = data.records.map((raw, i) => {
    if (!isObj(raw)) throw new Error(`Record #${i + 1} is not an object.`);
    const r = migrateRecord(raw, version);
    assertRecord(r, i);
    return r;
  });
  const folders = ((data.folders as unknown[] | undefined) ?? []).map(parseFolder);
  const cleanThumbs: Record<string, string> = {};
  for (const [id, url] of Object.entries(thumbnails)) {
    if (typeof url === 'string' && url.startsWith('data:image/')) cleanThumbs[id] = url;
  }
  return {
    format: BACKUP_FORMAT,
    version: SCHEMA_VERSION,
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : 0,
    records,
    folders,
    thumbnails: cleanThumbs,
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
 * Records: hasThumbnail is set from whether the backup carries a thumbnail; a folderId
 * that names no known folder becomes "no folder".
 */
export function planImport(
  existing: ReadingRecord[],
  existingFolders: Folder[],
  backup: BackupFile,
): ImportPlan {
  const plan: ImportPlan = {
    writeFolders: [],
    write: [],
    putThumbnails: {},
    deleteThumbnails: [],
    added: 0,
    updated: 0,
    skipped: 0,
  };

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
  const resolveFolder = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const mapped = folderIdMap.get(id) ?? id;
    return folderById.has(mapped) ? mapped : undefined;
  };

  // --- records
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of newestById(backup.records).values()) {
    const current = byId.get(r.id);
    if (current && r.updatedAt <= current.updatedAt) {
      plan.skipped++;
      continue;
    }
    const thumb = backup.thumbnails[r.id];
    const { folderId, ...rest } = r;
    const resolved = resolveFolder(folderId);
    plan.write.push({ ...rest, ...(resolved ? { folderId: resolved } : {}), hasThumbnail: !!thumb });
    if (thumb) plan.putThumbnails[r.id] = thumb;
    else if (current?.hasThumbnail) plan.deleteThumbnails.push(r.id);
    if (current) plan.updated++;
    else plan.added++;
  }
  return plan;
}

export function buildBackup(
  records: ReadingRecord[],
  folders: Folder[],
  thumbnails: Record<string, string>,
): BackupFile {
  return { format: BACKUP_FORMAT, version: SCHEMA_VERSION, exportedAt: Date.now(), records, folders, thumbnails };
}
