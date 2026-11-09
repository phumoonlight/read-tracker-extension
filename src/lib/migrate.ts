import { SCHEMA_VERSION, type ReadingRecord } from './types';

type RawRecord = Record<string, unknown>;

/**
 * MIGRATIONS[n] upgrades a record from schema version n to n + 1.
 * To change the record shape: bump SCHEMA_VERSION in types.ts and add a step here.
 * (Empty: the schema is at its first version.)
 */
const MIGRATIONS: Record<number, (r: RawRecord) => RawRecord> = {};

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
