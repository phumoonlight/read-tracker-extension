import { SCHEMA_VERSION, legacyImageId, type ReadingRecord } from './types';

type RawRecord = Record<string, unknown>;

/**
 * MIGRATIONS[n] upgrades a record from schema version n to n + 1.
 * To change the record shape: bump SCHEMA_VERSION in types.ts and append a step here.
 */
const MIGRATIONS: Record<number, (r: RawRecord) => RawRecord> = {
  // v2 adds optional `folderId`. Absent means Home (no folder), so v1 records are already valid.
  1: (r) => r,
  // v3 replaces `hasThumbnail: boolean` with `images: string[]`. The old thumbnail
  // becomes image `legacy-<id>` (the DB upgrade and parseBackup use the same id).
  2: (r) => {
    const { hasThumbnail, ...rest } = r;
    const images = Array.isArray(r.images) ? r.images : hasThumbnail === true ? [legacyImageId(String(r.id))] : [];
    return { ...rest, images };
  },
};

/** Bring a stored or imported record up to SCHEMA_VERSION. Throws if `fromVersion` is newer than this build. */
export function migrateRecord(raw: RawRecord, fromVersion: number): ReadingRecord {
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(`Data is from schema v${fromVersion}; this extension supports up to v${SCHEMA_VERSION}.`);
  }
  let r = raw;
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`No migration from schema v${v} to v${v + 1}.`);
    r = step(r);
  }
  return r as unknown as ReadingRecord;
}
