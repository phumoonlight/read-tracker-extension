import { browser } from 'wxt/browser';
import { IDX, META, RECORDS, THUMBNAILS, req, withTx } from './db';
import { candidateKeys, chooseMatch } from './match';
import { migrateRecord } from './migrate';
import { SCHEMA_VERSION, type ReadingRecord, type ReadStatus } from './types';

/**
 * Records repository on IndexedDB (see db.ts for the layout).
 *
 * Every write also bumps "recordsRevision" in chrome.storage.local. IndexedDB has no
 * change events, but storage.onChanged reaches every extension context and wakes
 * the background worker, so that key is the change signal.
 */
const REVISION_KEY = 'recordsRevision';

// ---------------------------------------------------------------------------
// Row mapping: rows carry derived fields used only by indexes.

interface Row extends ReadingRecord {
  /** Lowercased title for case-insensitive title sort. */
  _title: string;
  /** Status sort rank; the status index is walked backwards, so unread (2) comes first. */
  _rank: number;
}

const RANK: Record<ReadStatus, number> = { unread: 2, reading: 1, read: 0 };

function toRow(r: ReadingRecord): Row {
  return { ...r, _title: r.title.toLocaleLowerCase(), _rank: RANK[r.status] };
}

function fromRow(row: Row): ReadingRecord {
  const { _title, _rank, ...r } = row;
  void _title;
  void _rank;
  return r;
}

// ---------------------------------------------------------------------------
// Startup: schema migration and the one-time move out of chrome.storage.local.

const LEGACY_RECORD_PREFIX = 'record:';
const LEGACY_VERSION_KEY = 'schemaVersion';

let ready: Promise<void> | undefined;

/** Runs once per context before the first read or write. */
function ensureReady(): Promise<void> {
  ready ??= (async () => {
    await migrateStoredRecords();
    await moveLegacyStorage();
  })();
  ready.catch(() => (ready = undefined));
  return ready;
}

/** Upgrade rows whose shape is older than SCHEMA_VERSION (see migrate.ts). */
async function migrateStoredRecords() {
  await withTx([RECORDS, META], 'readwrite', async (tx) => {
    const meta = tx.objectStore(META);
    const stored = (await req(meta.get('schemaVersion'))) as number | undefined;
    if (stored === SCHEMA_VERSION) return;
    if (stored !== undefined) {
      const store = tx.objectStore(RECORDS);
      const rows = (await req(store.getAll())) as Record<string, unknown>[];
      for (const raw of rows) store.put(toRow(migrateRecord(raw, stored)));
    }
    meta.put(SCHEMA_VERSION, 'schemaVersion');
  });
}

/**
 * Builds before the IndexedDB move kept records in chrome.storage.local as
 * "record:<id>". Copy them in (keeping whichever copy is newer) and remove them.
 */
async function moveLegacyStorage() {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(LEGACY_RECORD_PREFIX));
  if (!keys.length && all[LEGACY_VERSION_KEY] === undefined) return;

  const version = typeof all[LEGACY_VERSION_KEY] === 'number' ? (all[LEGACY_VERSION_KEY] as number) : 1;
  const legacy = keys.map((k) => migrateRecord(all[k] as Record<string, unknown>, version));
  if (legacy.length) {
    await withTx(RECORDS, 'readwrite', async (tx) => {
      const store = tx.objectStore(RECORDS);
      for (const r of legacy) {
        const existing = (await req(store.get(r.id))) as Row | undefined;
        if (!existing || existing.updatedAt < r.updatedAt) store.put(toRow(r));
      }
    });
  }
  await browser.storage.local.remove([...keys, LEGACY_VERSION_KEY]);
  if (legacy.length) await notifyChanged();
}

// ---------------------------------------------------------------------------
// Change signal

async function notifyChanged() {
  await browser.storage.local.set({ [REVISION_KEY]: `${Date.now()}-${Math.random()}` });
}

/** Calls `fn` whenever any record is added, changed or removed (in any context). Returns an unsubscribe function. */
export function onRecordsChanged(fn: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && REVISION_KEY in changes) fn();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Reads

export async function getRecord(id: string): Promise<ReadingRecord | undefined> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) => {
    const row = (await req(tx.objectStore(RECORDS).get(id))) as Row | undefined;
    return row && fromRow(row);
  });
}

/** Every record. Only for export/import; lists should use queryRecords. */
export async function getAllRecords(): Promise<ReadingRecord[]> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) =>
    ((await req(tx.objectStore(RECORDS).getAll())) as Row[]).map(fromRow),
  );
}

/**
 * The record for a normalized URL, via a few matchKey index lookups
 * (see candidateKeys / chooseMatch) instead of loading every record.
 */
export async function findRecordForUrl(normalizedUrl: string): Promise<ReadingRecord | undefined> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) => {
    const index = tx.objectStore(RECORDS).index(IDX.matchKey);
    const keys = candidateKeys(normalizedUrl);
    const hits = await Promise.all(keys.map((k) => req(index.getAll(k)) as Promise<Row[]>));
    const match = chooseMatch(normalizedUrl, new Map(keys.map((k, i) => [k, hits[i] ?? []])));
    return match && fromRow(match as Row);
  });
}

export async function countRecords(): Promise<number> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', (tx) => req(tx.objectStore(RECORDS).count()));
}

/** All distinct tags, sorted, read from the tags index keys (no record values loaded). */
export async function listTags(): Promise<string[]> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) => {
    const tags: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore(RECORDS).index(IDX.tags).openKeyCursor(null, 'nextunique');
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        tags.push(String(c.key));
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
    return tags;
  });
}

export type SortKey = 'updated' | 'created' | 'title' | 'status';

export interface RecordQuery {
  search?: string;
  status?: ReadStatus;
  tag?: string;
  sort: SortKey;
  /** Stop after this many matches. */
  limit: number;
}

const SORT_INDEX: Record<SortKey, { index: string; direction: IDBCursorDirection }> = {
  updated: { index: IDX.updatedAt, direction: 'prev' },
  created: { index: IDX.createdAt, direction: 'prev' },
  title: { index: IDX.title, direction: 'next' },
  status: { index: IDX.status, direction: 'prev' },
};

/**
 * One page of the list: walks the sort index in order, applies the filters to each
 * row, and stops once `limit` matches are found. Only the rows it walks past are read.
 */
export async function queryRecords(q: RecordQuery): Promise<{ records: ReadingRecord[]; hasMore: boolean }> {
  await ensureReady();
  const search = q.search?.trim().toLowerCase();
  const matches = (r: Row) =>
    (!q.status || r.status === q.status) &&
    (!q.tag || r.tags.includes(q.tag)) &&
    (!search || [r._title, r.url.toLowerCase(), (r.notes ?? '').toLowerCase(), ...r.tags].some((s) => s.includes(search)));

  return withTx(RECORDS, 'readonly', async (tx) => {
    const { index, direction } = SORT_INDEX[q.sort];
    // With a status filter and the status sort, only walk that status's slice of the index.
    const range =
      q.status && q.sort === 'status'
        ? IDBKeyRange.bound([RANK[q.status], -Infinity], [RANK[q.status], Infinity])
        : null;
    const found: ReadingRecord[] = [];
    let hasMore = false;
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore(RECORDS).index(index).openCursor(range, direction);
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        const row = c.value as Row;
        if (matches(row)) {
          if (found.length === q.limit) {
            hasMore = true;
            return resolve();
          }
          found.push(fromRow(row));
        }
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
    return { records: found, hasMore };
  });
}

// ---------------------------------------------------------------------------
// Writes (each one transaction, then a change signal)

export async function putRecords(records: ReadingRecord[]): Promise<void> {
  if (!records.length) return;
  await ensureReady();
  await withTx(RECORDS, 'readwrite', async (tx) => {
    const store = tx.objectStore(RECORDS);
    for (const r of records) store.put(toRow(r));
  });
  await notifyChanged();
}

export const putRecord = (record: ReadingRecord) => putRecords([record]);

/**
 * Atomic read-modify-write of one record (the read and write share a transaction,
 * so concurrent updates from other contexts are not lost). Sets updatedAt.
 * `change` must be synchronous. Returns the new record, or undefined if it no longer exists.
 */
export async function updateRecord(
  id: string,
  change: (r: ReadingRecord) => Partial<ReadingRecord>,
): Promise<ReadingRecord | undefined> {
  await ensureReady();
  const result = await withTx(RECORDS, 'readwrite', async (tx) => {
    const store = tx.objectStore(RECORDS);
    const row = (await req(store.get(id))) as Row | undefined;
    if (!row) return undefined;
    const current = fromRow(row);
    const patch = change(current);
    // An empty patch is a no-op: no write, no updatedAt bump, no change signal.
    if (!Object.keys(patch).length) return { record: current, changed: false };
    const updated: ReadingRecord = { ...current, ...patch, updatedAt: Date.now() };
    store.put(toRow(updated));
    return { record: updated, changed: true };
  });
  if (result?.changed) await notifyChanged();
  return result?.record;
}

/** Delete a record and its thumbnail together. */
export async function deleteRecord(id: string): Promise<void> {
  await ensureReady();
  await withTx([RECORDS, THUMBNAILS], 'readwrite', async (tx) => {
    tx.objectStore(RECORDS).delete(id);
    tx.objectStore(THUMBNAILS).delete(id);
  });
  await notifyChanged();
}

/** Store (or, with null, remove) a record's thumbnail and update hasThumbnail in the same transaction. */
export async function setThumbnail(id: string, blob: Blob | null): Promise<ReadingRecord | undefined> {
  await ensureReady();
  const next = await withTx([RECORDS, THUMBNAILS], 'readwrite', async (tx) => {
    const store = tx.objectStore(RECORDS);
    const row = (await req(store.get(id))) as Row | undefined;
    if (!row) return undefined;
    if (blob) tx.objectStore(THUMBNAILS).put(blob, id);
    else tx.objectStore(THUMBNAILS).delete(id);
    const updated: ReadingRecord = { ...fromRow(row), hasThumbnail: !!blob, updatedAt: Date.now() };
    store.put(toRow(updated));
    return updated;
  });
  if (next) await notifyChanged();
  return next;
}

/**
 * Apply an import in one transaction: write records, put or delete thumbnails.
 * Blobs must be prepared beforehand (no async work is allowed inside the transaction).
 */
export async function applyImport(
  records: ReadingRecord[],
  putThumbs: Map<string, Blob>,
  deleteThumbs: string[],
): Promise<void> {
  await ensureReady();
  await withTx([RECORDS, THUMBNAILS], 'readwrite', async (tx) => {
    const thumbs = tx.objectStore(THUMBNAILS);
    for (const [id, blob] of putThumbs) thumbs.put(blob, id);
    for (const id of deleteThumbs) thumbs.delete(id);
    const store = tx.objectStore(RECORDS);
    for (const r of records) store.put(toRow(r));
  });
  if (records.length) await notifyChanged();
}

/** Field changes for a status transition: keeps readAt in step with status. */
export function statusChange(r: ReadingRecord, status: ReadStatus): Partial<ReadingRecord> {
  if (status === r.status) return {};
  return { status, readAt: status === 'read' ? Date.now() : undefined };
}
