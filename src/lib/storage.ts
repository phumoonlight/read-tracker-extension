import { browser } from 'wxt/browser';
import { FOLDERS, IDX, IMAGES, META, RECORDS, req, withTx } from './db';
import { isPermutation, type NewImage, type StoredImage } from './images';
import { domainConflictError } from './domains';
import { cleanFolderName, folderNameError, newFolder, sortFolders } from './folders';
import { chooseMatch, lookupTags, recordMatchTags } from './match';
import { urlEntries } from './records';
import { migrateRecord } from './migrate';
import {
  MAX_IMAGES,
  SCHEMA_VERSION,
  type Folder,
  type HomeSettings,
  type ImageSize,
  type ReadMode,
  type ReadingRecord,
  type ReadStatus,
} from './types';
import { newId } from './ids';

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
  /** Status sort rank; the status index is walked backwards, so unread (1) comes first. */
  _rank: number;
  /** readAt, or 0 if never read: the Revisit order (least recently read first). */
  _readSort: number;
  /** "mode|key" tag of every URL (see matchTag): the multiEntry matchKeys index. */
  _matchKeys: string[];
}

const RANK: Record<ReadStatus, number> = { unread: 1, read: 0 };

function toRow(r: ReadingRecord): Row {
  const row: Row = {
    ...r,
    _title: r.title.toLocaleLowerCase(),
    _rank: RANK[r.status],
    _readSort: r.readAt ?? 0,
    _matchKeys: recordMatchTags(r),
  };
  if (!row.otherUrls?.length) delete row.otherUrls;
  // Keep Home (no folder) as an absent property (not stored as undefined).
  if (row.folderId === undefined) delete row.folderId;
  return row;
}

function fromRow(row: Row): ReadingRecord {
  const { _title, _rank, _readSort, _matchKeys, ...r } = row;
  void _title;
  void _rank;
  void _readSort;
  void _matchKeys;
  return r;
}

// ---------------------------------------------------------------------------
// Startup: record schema migration.

/** META key of the stored records' SCHEMA_VERSION. */
const VERSION_KEY = 'recordVersion';
/**
 * Pre-release builds kept the version under this key, numbered up to 5. That shape is
 * today's v1, so the old key is just dropped.
 */
const PRE_RELEASE_VERSION_KEY = 'schemaVersion';

let ready: Promise<void> | undefined;

/** Runs once per context before the first read or write. */
function ensureReady(): Promise<void> {
  ready ??= migrateStoredRecords();
  ready.catch(() => (ready = undefined));
  return ready;
}

/** Upgrade rows whose shape is older than SCHEMA_VERSION (see migrate.ts). */
async function migrateStoredRecords() {
  await withTx([RECORDS, META], 'readwrite', async (tx) => {
    const meta = tx.objectStore(META);
    const stored = (await req(meta.get(VERSION_KEY))) as number | undefined;
    if (stored === SCHEMA_VERSION) return;
    meta.delete(PRE_RELEASE_VERSION_KEY);
    if (stored !== undefined) {
      const store = tx.objectStore(RECORDS);
      const rows = (await req(store.getAll())) as Record<string, unknown>[];
      for (const raw of rows) store.put(toRow(migrateRecord(raw, stored)));
    }
    meta.put(SCHEMA_VERSION, VERSION_KEY);
  });
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
    const index = tx.objectStore(RECORDS).index(IDX.matchKeys);
    const tags = lookupTags(normalizedUrl);
    const hits = await Promise.all(tags.map((t) => req(index.getAll(t)) as Promise<Row[]>));
    const match = chooseMatch(normalizedUrl, new Map(tags.map((t, i) => [t, hits[i] ?? []])));
    return match && fromRow(match as Row);
  });
}

export async function countRecords(): Promise<number> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', (tx) => req(tx.objectStore(RECORDS).count()));
}

/** Every tag in use, with how many records have it (from the tags index keys; no record values loaded). */
export async function allTagCounts(): Promise<[string, number][]> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) => {
    const counts = new Map<string, number>();
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore(RECORDS).index(IDX.tags).openKeyCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        const t = String(c.key);
        counts.set(t, (counts.get(t) ?? 0) + 1);
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
    return [...counts];
  });
}

export interface PlaceStats {
  /** [tag, count], sorted by tag. */
  tags: [string, number][];
  /** Records per status. */
  status: Record<ReadStatus, number>;
}

/**
 * Tag and status counts for one place (null = Home, or a folder id), in one pass over that
 * place's records (small: no image data).
 */
export async function placeStats(place: string | null): Promise<PlaceStats> {
  await ensureReady();
  return withTx(RECORDS, 'readonly', async (tx) => {
    const store = tx.objectStore(RECORDS);
    const rows =
      place === null
        ? ((await req(store.getAll())) as Row[]).filter((r) => r.folderId === undefined)
        : ((await req(store.index(IDX.folderId).getAll(place))) as Row[]);
    const tags = new Map<string, number>();
    const status: Record<ReadStatus, number> = { unread: 0, read: 0 };
    for (const r of rows) {
      status[r.status] = (status[r.status] ?? 0) + 1;
      for (const t of r.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    }
    return { tags: [...tags].sort(([a], [b]) => a.localeCompare(b)), status };
  });
}

/** 'revisit' = least recently read first (used by places in Revisit mode). */
export type SortKey = 'updated' | 'created' | 'title' | 'status' | 'revisit';

export interface RecordQuery {
  search?: string;
  status?: ReadStatus;
  /** Records must have every one of these tags. */
  tags?: string[];
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
  revisit: { index: IDX.readOrder, direction: 'next' },
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
    (!q.tags?.length || q.tags.every((t) => r.tags.includes(t))) &&
    (q.folder === undefined || (r.folderId ?? null) === q.folder) &&
    (!search ||
      [r._title, ...urlEntries(r).map((e) => e.url.toLowerCase()), (r.notes ?? '').toLowerCase(), ...r.tags].some((s) =>
        s.includes(search),
      ));

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
      const stored: StoredImage = { ...img, id: newId(), recordId, addedAt: now };
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

/**
 * Put a record's images in a new order (the first is the cover). `order` must be a
 * reordering of the current list; if the list changed meanwhile (an image added or
 * removed elsewhere), nothing is changed.
 */
export function reorderImages(recordId: string, order: string[]): Promise<ReadingRecord | undefined> {
  return changeImages(recordId, (current) => (isPermutation(current, order) ? order : current));
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
  home?: HomeSettings,
): Promise<void> {
  await ensureReady();
  await withTx([FOLDERS, RECORDS, IMAGES, META], 'readwrite', async (tx) => {
    if (home) tx.objectStore(META).put(home, HOME_KEY);
    const folderStore = tx.objectStore(FOLDERS);
    for (const f of folders) folderStore.put(f);
    const images = tx.objectStore(IMAGES);
    for (const id of deleteImageIds) images.delete(id);
    for (const img of putImages) images.put(img);
    const store = tx.objectStore(RECORDS);
    for (const r of records) store.put(toRow(await withValidFolder(tx, r)));
  });
  if (records.length || folders.length || home) await notifyChanged();
}

// ---------------------------------------------------------------------------
// Home (records without a folder). It has no Folder record; its settings live in META.

const HOME_KEY = 'home';

export async function getHomeSettings(): Promise<HomeSettings | undefined> {
  await ensureReady();
  const stored = await withTx(
    META,
    'readonly',
    (tx) => req(tx.objectStore(META).get(HOME_KEY)) as Promise<HomeSettings | undefined>,
  );
  return stored && withoutReadMode(stored);
}

/** Home is always Status: drop a read mode saved by an earlier build. */
function withoutReadMode<T extends object>(s: T): Omit<T, 'readMode'> {
  const { readMode: _ignored, ...rest } = s as T & { readMode?: unknown };
  void _ignored;
  return rest;
}

/** Display settings shared by Home and folders. Defaults are stored as absent. */
type PlaceSettings = { imageSize?: ImageSize; readMode?: ReadMode };

/** Apply a settings change, dropping fields that are back at their default. */
function withSettings<T extends PlaceSettings>(current: T, patch: PlaceSettings): T {
  const next = { ...current, ...patch };
  if (next.imageSize === 'medium') delete next.imageSize;
  if (next.readMode === 'status') delete next.readMode;
  return next;
}

/** Change Home's settings (merged with the stored ones). Home has no read mode setting. */
export async function updateHomeSettings(patch: { imageSize?: ImageSize }): Promise<void> {
  await ensureReady();
  await withTx(META, 'readwrite', async (tx) => {
    const store = tx.objectStore(META);
    const current = ((await req(store.get(HOME_KEY))) as HomeSettings | undefined) ?? { updatedAt: 0 };
    store.put({ ...withoutReadMode(withSettings(current, patch)), updatedAt: Date.now() }, HOME_KEY);
  });
  await notifyChanged();
}

export const setHomeImageSize = (size: ImageSize) => updateHomeSettings({ imageSize: size });

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
export async function createFolder(name: string, domains: string[] = []): Promise<Folder> {
  await ensureReady();
  const folder = await withTx(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const all = (await req(store.getAll())) as Folder[];
    const error = folderNameError(name, all) ?? domainConflictError(domains, all);
    if (error) throw new Error(error);
    const f: Folder = { ...newFolder(name), ...(domains.length ? { domains: [...domains] } : {}) };
    store.put(f);
    return f;
  });
  await notifyChanged();
  return folder;
}

/**
 * Set a folder's preferred domains (already normalized). Throws a user-facing error if
 * another folder already prefers one of them; checked in the same transaction.
 */
export async function setFolderDomains(id: string, domains: string[]): Promise<void> {
  await ensureReady();
  await withTx(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const all = (await req(store.getAll())) as Folder[];
    const current = all.find((f) => f.id === id);
    if (!current) throw new Error('This folder no longer exists.');
    const error = domainConflictError(domains, all, id);
    if (error) throw new Error(error);
    const { domains: _old, ...rest } = current;
    void _old;
    store.put({ ...rest, ...(domains.length ? { domains: [...domains] } : {}), updatedAt: Date.now() });
  });
  await notifyChanged();
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

/** Change a folder's display settings (image size, read mode). Defaults are stored as absent. */
export async function updateFolderSettings(id: string, patch: PlaceSettings): Promise<void> {
  await ensureReady();
  await withTx(FOLDERS, 'readwrite', async (tx) => {
    const store = tx.objectStore(FOLDERS);
    const current = (await req(store.get(id))) as Folder | undefined;
    if (!current) throw new Error('This folder no longer exists.');
    store.put({ ...withSettings(current, patch), updatedAt: Date.now() });
  });
  await notifyChanged();
}

export const setFolderImageSize = (id: string, size: ImageSize) => updateFolderSettings(id, { imageSize: size });

/**
 * Revisit mode's "Update read": stamp readAt with the current time (and mark it read).
 * The record then sorts to the end of its Revisit list.
 */
export const markReadNow = (id: string) =>
  updateRecord(id, () => ({ status: 'read' as const, readAt: Date.now() }));

/**
 * Delete a folder. Its records are kept and moved to Home (with updatedAt bumped,
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

// ---------------------------------------------------------------------------
// Reset

/**
 * Delete everything: records, images, folders and Home settings, in one transaction.
 * The record schema version is kept so the empty database isn't migrated again.
 */
export async function wipeAllData(): Promise<void> {
  await ensureReady();
  await withTx([RECORDS, IMAGES, FOLDERS, META], 'readwrite', async (tx) => {
    tx.objectStore(RECORDS).clear();
    tx.objectStore(IMAGES).clear();
    tx.objectStore(FOLDERS).clear();
    const meta = tx.objectStore(META);
    meta.clear();
    meta.put(SCHEMA_VERSION, VERSION_KEY);
  });
  await notifyChanged();
}
