import { migrateRecord } from './migrate';
import { isHttpUrl } from './records';
import { BACKUP_FORMAT, SCHEMA_VERSION, STATUSES, type BackupFile, type ReadingRecord } from './types';

export interface ImportPlan {
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
  const thumbnails = isObj(data.thumbnails) ? data.thumbnails : {};

  const records = data.records.map((raw, i) => {
    if (!isObj(raw)) throw new Error(`Record #${i + 1} is not an object.`);
    const r = migrateRecord(raw, version);
    assertRecord(r, i);
    return r;
  });
  const cleanThumbs: Record<string, string> = {};
  for (const [id, url] of Object.entries(thumbnails)) {
    if (typeof url === 'string' && url.startsWith('data:image/')) cleanThumbs[id] = url;
  }
  return {
    format: BACKUP_FORMAT,
    version: SCHEMA_VERSION,
    exportedAt: typeof data.exportedAt === 'number' ? data.exportedAt : 0,
    records,
    thumbnails: cleanThumbs,
  };
}

/**
 * Merge by id: an incoming record replaces the stored one only if its updatedAt is
 * strictly newer. hasThumbnail on written records is set from whether the backup
 * actually carries a thumbnail for that id.
 */
export function planImport(existing: ReadingRecord[], backup: BackupFile): ImportPlan {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const plan: ImportPlan = { write: [], putThumbnails: {}, deleteThumbnails: [], added: 0, updated: 0, skipped: 0 };

  // If the same id appears twice in the file, the newest copy counts.
  const incoming = new Map<string, ReadingRecord>();
  for (const r of backup.records) {
    const prev = incoming.get(r.id);
    if (!prev || r.updatedAt > prev.updatedAt) incoming.set(r.id, r);
  }

  for (const r of incoming.values()) {
    const current = byId.get(r.id);
    if (current && r.updatedAt <= current.updatedAt) {
      plan.skipped++;
      continue;
    }
    const thumb = backup.thumbnails[r.id];
    plan.write.push({ ...r, hasThumbnail: !!thumb });
    if (thumb) plan.putThumbnails[r.id] = thumb;
    else if (current?.hasThumbnail) plan.deleteThumbnails.push(r.id);
    if (current) plan.updated++;
    else plan.added++;
  }
  return plan;
}

export function buildBackup(records: ReadingRecord[], thumbnails: Record<string, string>): BackupFile {
  return { format: BACKUP_FORMAT, version: SCHEMA_VERSION, exportedAt: Date.now(), records, thumbnails };
}
