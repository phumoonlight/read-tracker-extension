/**
 * The extension's IndexedDB database. The extension origin is shared, so the popup,
 * the list page and the background worker all open the same database.
 *
 * Stores (DB version 3):
 *   records     keyPath "id"; rows are ReadingRecord plus derived index fields (see records-db.ts)
 *               indexes: matchKey, updatedAt, createdAt, title (_title), status ([_rank, updatedAt]),
 *                        tags (multiEntry), folderId (v3; records without a folder are not in it)
 *   folders     keyPath "id"; Folder (v3)
 *   thumbnails  out-of-line key = record id, value = WebP Blob
 *   meta        out-of-line key, small values (e.g. "schemaVersion" = record schema version)
 *
 * DB_VERSION changes the store/index layout. The record *shape* has its own
 * SCHEMA_VERSION (types.ts) and is migrated lazily, see records-db.ts.
 */
export const DB_NAME = 'read-tracker';
export const DB_VERSION = 3;

export const RECORDS = 'records';
export const THUMBNAILS = 'thumbnails';
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
