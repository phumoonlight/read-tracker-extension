import { browser } from 'wxt/browser';
import { FOLDERS, IDX, IMAGES, META, RECORDS, req, withTx } from './db';
import type { NewImage, StoredImage } from './images';
import { cleanFolderName, folderNameError, newFolder, sortFolders } from './folders';
import { candidateKeys, chooseMatch } from './match';
import { migrateRecord } from './migrate';
import { MAX_IMAGES, SCHEMA_VERSION, type Folder, type ImageSize, type ReadingRecord, type ReadStatus } from './types';

/**
 * Records repository on IndexedDB (see db.ts for the layout).
 *
 * Folders live in the same database and share the change signal.
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
  const row: Row = { ...r, _title: r.title.toLocaleLowerCase(), _rank: RANK[r.status] };
  // Keep "no folder" as an absent property (not stored as undefined).
  if (row.folderId === undefined) delete row.folderId;
  return row;
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
  /** undefined = every record, null = only records without a folder, string = that folder. */
  folder?: string | null;
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
    (q.folder === undefined || (r.folderId ?? null) === q.folder) &&
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

/**
 * Inside a write transaction that includes FOLDERS: drop a folderId that points at a
 * folder which no longer exists (e.g. deleted from another window meanwhile).
 */
async function withValidFolder(tx: IDBTransaction, r: ReadingRecord): Promise<ReadingRecord> {
  if (r.folderId === undefined) return r;
  const exists = (await req(tx.objectStore(FOLDERS).getKey(r.folderId))) !== undefined;
  return exists ? r : { ...r, folderId: undefined };
}

export async function putRecords(records: ReadingRecord[]): Promise<void> {
  if (!records.length) return;
  await ensureReady();
  await withTx([RECORDS, FOLDERS], 'readwrite', async (tx) => {
    const store = tx.objectStore(RECORDS);
    for (const r of records) store.put(toRow(await withValidFolder(tx, r)));
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
  const result = await withTx([RECORDS, FOLDERS], 'readwrite', async (tx) => {
    const store = tx.objectStore(RECORDS);
    const row = (await req(store.get(id))) as Row | undefined;
    if (!row) return undefined;
    const current = fromRow(row);
    const patch = change(current);
    // An empty patch is a no-op: no write, no updatedAt bump, no change signal.
    if (!Object.keys(patch).length) return { record: current, changed: false };
    const updated = await withValidFolder(tx, { ...current, ...patch, updatedAt: Date.now() });
    store.put(toRow(updated));
    return { record: updated, changed: true };
  });
  if (result?.changed) await notifyChanged();
  return result?.record;
}

/** Delete a record and all its images together. */
export async function deleteRecord(id: string): Promise<void> {
  await ensureReady();
  await withTx([RECORDS, IMAGES], 'readwrite', async (tx) => {
    tx.objectStore(RECORDS).delete(id);
    const images = tx.objectStore(IMAGES);
    const keys = await req(images.index(IDX.recordId).getAllKeys(id));
    for (const k of keys) images.delete(k);
  });
  await notifyChanged();
}

/**
 * Read-modify-write a record's image list together with the images store, in one
 * transaction. `fn` returns the new id list (or throws a user-facing error).
 */
async function changeImages(
  recordId: string,
  fn: (current: string[], images: IDBObjectStore) => string[],
): Promise<ReadingRecord | undefined> {
  await ensureReady();
  const next = await withTx([RECORDS, IMAGES], 'readwrite', async (tx) => {
    const store = tx.objectStore(RECORDS);
    const row = (await req(store.get(recordId))) as Row | undefined;
    if (!row) return undefined;
    const record = fromRow(row);
    const updated: ReadingRecord = { ...record, images: fn(record.images, tx.objectStore(IMAGES)), updatedAt: Date.now() };
    store.put(toRow(updated));
    return updated;
  });
  if (next) await notifyChanged();
  return next;
}

/** Append images (prepared with prepareImage). Throws if the record would exceed MAX_IMAGES. */
export function addImages(recordId: string, added: NewImage[]): Promise<ReadingRecord | undefined> {
  return changeImages(recordId, (current, images) => {
    if (current.length + added.length > MAX_IMAGES) {
      const left = MAX_IMAGES - current.length;
      throw new Error(
        left > 0
          ? `A record can have at most ${MAX_IMAGES} images; there is room for ${left} more.`
          : `A record can have at most ${MAX_IMAGES} images. Remove one first.`,
      );
    }
    const now = Date.now();
    const ids = added.map((img) => {
      const stored: StoredImage = { ...img, id: crypto.randomUUID(), recordId, addedAt: now };
      images.put(stored);
      return stored.id;
    });
    return [...current, ...ids];
  });
}

export function removeImage(recordId: string, imageId: string): Promise<ReadingRecord | undefined> {
  return changeImages(recordId, (current, images) => {
    images.delete(imageId);
    return current.filter((id) => id !== imageId);
  });
}

/** Move an image to the front (the cover shown on cards). */
export function setCoverImage(recordId: string, imageId: string): Promise<ReadingRecord | undefined> {
  return changeImages(recordId, (current) =>
    current.includes(imageId) ? [imageId, ...current.filter((id) => id !== imageId)] : current,
  );
}

/**
 * Apply an import in one transaction: write folders, images and records, delete
 * replaced images. Image blobs and previews must be prepared beforehand (no async
 * work is allowed inside the transaction).
 */
export async function applyImport(
  folders: Folder[],
  records: ReadingRecord[],
  putImages: StoredImage[],
  deleteImageIds: string[],
): Promise<void> {
  await ensureReady();
  await withTx([FOLDERS, RECORDS, IMAGES], 'readwrite', async (tx) => {
    const folderStore = tx.objectStore(FOLDERS);
    for (const f of folders) folderStore.put(f);
    const images = tx.objectStore(IMAGES);
    for (const id of deleteImageIds) images.delete(id);
    for (const img of putImages) images.put(img);
    const store = tx.objectStore(RECORDS);
    for (const r of records) store.put(toRow(await withValidFolder(tx, r)));
  });
  if (records.length || folders.length) await notifyChanged();
}

// ---------------------------------------------------------------------------
// Folders

/** All folders, sorted by name. */
export async function listFolders(): Promise<Folder[]> {
  await ensureReady();
  return withTx(FOLDERS, 'readonly', async (tx) => sortFolders((await req(tx.objectStore(FOLDERS).getAll())) as Folder[]));
}

/** Number of records in each folder (from the folderId index; no record values loaded). */
export async function folderCounts(): Promise<Map<string, number>> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) => {
    const counts = new Map<string, number>();
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore(RECORDS).index(IDX.folderId).openKeyCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        const id = String(c.key);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
    return counts;
  });
}

/** Create a folder. Throws with a user-facing message if the name is empty, too long or taken. */
export async function createFolder(name: string): Promise<Folder> {
  await ensureReady();
  const folder = await withTx(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const error = folderNameError(name, (await req(store.getAll())) as Folder[]);
    if (error) throw new Error(error);
    const f = newFolder(name);
    store.put(f);
    return f;
  });
  await notifyChanged();
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  await ensureReady();
  await withTx(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const all = (await req(store.getAll())) as Folder[];
    const current = all.find((f) => f.id === id);
    if (!current) throw new Error('This folder no longer exists.');
    const error = folderNameError(name, all, id);
    if (error) throw new Error(error);
    store.put({ ...current, name: cleanFolderName(name), updatedAt: Date.now() });
  });
  await notifyChanged();
}

/** Set how big images display while a folder is open ('medium' is stored as absent). */
export async function setFolderImageSize(id: string, size: ImageSize): Promise<void> {
  await ensureReady();
  await withTx(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const current = (await req(store.get(id))) as Folder | undefined;
    if (!current) throw new Error('This folder no longer exists.');
    const { imageSize: _old, ...rest } = current;
    void _old;
    store.put({ ...rest, ...(size === 'medium' ? {} : { imageSize: size }), updatedAt: Date.now() });
  });
  await notifyChanged();
}

/**
 * Delete a folder. Its records are kept and moved to "no folder" (with updatedAt bumped,
 * so a later import of an older backup does not put them back). One transaction.
 */
export async function deleteFolder(id: string): Promise<number> {
  await ensureReady();
  const moved = await withTx([FOLDERS, RECORDS], 'readwrite', async (tx) => {
    tx.objectStore(FOLDERS).delete(id);
    const store = tx.objectStore(RECORDS);
    const rows = (await req(store.index(IDX.folderId).getAll(id))) as Row[];
    const now = Date.now();
    for (const row of rows) store.put(toRow({ ...fromRow(row), folderId: undefined, updatedAt: now }));
    return rows.length;
  });
  await notifyChanged();
  return moved;
}

/** Field changes for a status transition: keeps readAt in step with status. */
export function statusChange(r: ReadingRecord, status: ReadStatus): Partial<ReadingRecord> {
  if (status === r.status) return {};
  return { status, readAt: status === 'read' ? Date.now() : undefined };
}
