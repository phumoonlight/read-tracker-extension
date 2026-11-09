import { legacyImageId } from './types';

/**
 * The extension's IndexedDB database. The extension origin is shared, so the popup,
 * the list page and the background worker all open the same database.
 *
 * Stores (DB version 5):
 *   records     keyPath "id"; rows are ReadingRecord plus derived index fields (see storage.ts toRow)
 *               indexes: matchKey, updatedAt, createdAt, title (_title), status ([_rank, updatedAt]),
 *                        tags (multiEntry), folderId (v3; records without a folder are not in it),
 *               readOrder ([_readSort, createdAt], v5)
 *   folders     keyPath "id"; Folder (v3)
 *   images      keyPath "id"; StoredImage (original Blob + small preview Blob), index recordId (v4)
 *   thumbnails  removed in v4 (was: record id -> 300px WebP); its blobs became images "legacy-<recordId>"
 *   meta        out-of-line key, small values (e.g. "schemaVersion" = record schema version)
 *
 * DB_VERSION changes the store/index layout. The record *shape* has its own
 * SCHEMA_VERSION (types.ts) and is migrated lazily, see records-db.ts.
 */
export const DB_NAME = 'read-tracker';
export const DB_VERSION = 5;

export const RECORDS = 'records';
/** Removed in DB v4; only referenced by upgrade(). */
const THUMBNAILS = 'thumbnails';
export const IMAGES = 'images';
export const META = 'meta';
export const FOLDERS = 'folders';

export const IDX = {
  matchKey: 'matchKey',
  updatedAt: 'updatedAt',
  createdAt: 'createdAt',
  title: 'title',
  status: 'status',
  tags: 'tags',
  folderId: 'folderId',
  recordId: 'recordId',
  readOrder: 'readOrder',
} as const;

function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number) {
  // v1 (first release) had only the thumbnails store.
  if (oldVersion < 1) db.createObjectStore(THUMBNAILS);
  if (oldVersion < 2) {
    const records = db.createObjectStore(RECORDS, { keyPath: 'id' });
    records.createIndex(IDX.matchKey, 'matchKey');
    records.createIndex(IDX.updatedAt, 'updatedAt');
    records.createIndex(IDX.createdAt, 'createdAt');
    records.createIndex(IDX.title, '_title');
    records.createIndex(IDX.status, ['_rank', 'updatedAt']);
    records.createIndex(IDX.tags, 'tags', { multiEntry: true });
    db.createObjectStore(META);
  }
  if (oldVersion < 3) {
    db.createObjectStore(FOLDERS, { keyPath: 'id' });
    tx.objectStore(RECORDS).createIndex(IDX.folderId, 'folderId');
  }
  if (oldVersion < 4) {
    const images = db.createObjectStore(IMAGES, { keyPath: 'id' });
    images.createIndex(IDX.recordId, 'recordId');
    // Move each 300px thumbnail into the images store as both original and preview
    // (the full-size original was never kept). Record rows are rewritten to point at
    // these ids by the schema v2 -> v3 record migration (see migrate.ts).
    const cursorReq = tx.objectStore(THUMBNAILS).openCursor();
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (c) {
        const recordId = String(c.key);
        const blob = c.value as Blob;
        images.put({ id: legacyImageId(recordId), recordId, blob, preview: blob, addedAt: 0 });
        c.continue();
      } else {
        db.deleteObjectStore(THUMBNAILS);
      }
    };
  }
  if (oldVersion < 5) {
    // Revisit order: least recently read first, never read (0) first of all, ties by age.
    // Fill the derived _readSort field on existing rows so they appear in the index.
    const records = tx.objectStore(RECORDS);
    records.createIndex(IDX.readOrder, ['_readSort', 'createdAt']);
    const cur = records.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      const row = c.value as { readAt?: unknown; _readSort?: unknown };
      if (typeof row._readSort !== 'number') {
        c.update({ ...row, _readSort: typeof row.readAt === 'number' ? row.readAt : 0 });
      }
      c.continue();
    };
  }
}

let dbPromise: Promise<IDBDatabase> | undefined;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, req.transaction!, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      // Another context (e.g. a newer build after an update) wants to upgrade: let it.
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      db.onclose = () => (dbPromise = undefined);
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = undefined;
      reject(req.error);
    };
    req.onblocked = () => console.warn('[read-tracker] IndexedDB upgrade blocked by another open context');
  });
  return dbPromise;
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Resolves when the transaction commits; rejects if it errors or aborts. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

/**
 * Run `fn` inside one transaction and return its result once the transaction has
 * committed. `fn` must only issue IDB requests (awaiting them is fine), never other
 * async work such as fetch, or the transaction auto-commits early.
 */
export async function withTx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const done = txDone(tx);
  try {
    const result = await fn(tx);
    await done;
    return result;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      // already finished
    }
    done.catch(() => {});
    throw e;
  }
}
