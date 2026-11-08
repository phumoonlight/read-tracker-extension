import { browser } from 'wxt/browser';
import { migrateRecord } from './migrate';
import { SCHEMA_VERSION, type ReadingRecord, type ReadStatus } from './types';

/**
 * chrome.storage.local layout:
 *   "schemaVersion"  -> number
 *   "record:<id>"    -> ReadingRecord
 *
 * One key per record, so two contexts editing different records (for example the
 * background updating lastReadUrl while the popup changes another record's status)
 * never overwrite each other.
 */
const VERSION_KEY = 'schemaVersion';
const RECORD_PREFIX = 'record:';

export const recordKey = (id: string) => `${RECORD_PREFIX}${id}`;
export const isRecordKey = (key: string) => key.startsWith(RECORD_PREFIX);

let migration: Promise<void> | undefined;

/** Upgrades stored records once per context if the stored schema is older than this build. */
function ensureMigrated(): Promise<void> {
  migration ??= (async () => {
    const all = await browser.storage.local.get(null);
    const stored = typeof all[VERSION_KEY] === 'number' ? (all[VERSION_KEY] as number) : SCHEMA_VERSION;
    if (stored === SCHEMA_VERSION) {
      if (all[VERSION_KEY] === undefined) await browser.storage.local.set({ [VERSION_KEY]: SCHEMA_VERSION });
      return;
    }
    const updates: Record<string, unknown> = { [VERSION_KEY]: SCHEMA_VERSION };
    for (const [key, value] of Object.entries(all)) {
      if (isRecordKey(key)) updates[key] = migrateRecord(value as Record<string, unknown>, stored);
    }
    await browser.storage.local.set(updates);
  })();
  migration.catch(() => (migration = undefined));
  return migration;
}

export async function getAllRecords(): Promise<ReadingRecord[]> {
  await ensureMigrated();
  const all = await browser.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => isRecordKey(key))
    .map(([, value]) => value as ReadingRecord);
}

export async function getRecord(id: string): Promise<ReadingRecord | undefined> {
  await ensureMigrated();
  const key = recordKey(id);
  const got = await browser.storage.local.get(key);
  return got[key] as ReadingRecord | undefined;
}

export async function putRecords(records: ReadingRecord[]): Promise<void> {
  if (!records.length) return;
  await ensureMigrated();
  await browser.storage.local.set(Object.fromEntries(records.map((r) => [recordKey(r.id), r])));
}

export const putRecord = (record: ReadingRecord) => putRecords([record]);

/** Read-modify-write one record. Sets updatedAt. Returns the new record, or undefined if it no longer exists. */
export async function updateRecord(
  id: string,
  change: (r: ReadingRecord) => Partial<ReadingRecord>,
): Promise<ReadingRecord | undefined> {
  const current = await getRecord(id);
  if (!current) return undefined;
  const next: ReadingRecord = { ...current, ...change(current), updatedAt: Date.now() };
  await putRecord(next);
  return next;
}

export async function deleteRecord(id: string): Promise<void> {
  await browser.storage.local.remove(recordKey(id));
}

/** Field changes for a status transition: keeps readAt in step with status. */
export function statusChange(r: ReadingRecord, status: ReadStatus): Partial<ReadingRecord> {
  if (status === r.status) return {};
  return { status, readAt: status === 'read' ? Date.now() : undefined };
}

/** Calls `fn` whenever any record is added, changed or removed. Returns an unsubscribe function. */
export function onRecordsChanged(fn: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && Object.keys(changes).some(isRecordKey)) fn();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
