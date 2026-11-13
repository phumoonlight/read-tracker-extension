/** Image id the DB v4 step gave a record's old single thumbnail. */
const legacyImageId = (recordId: string) => `legacy-${recordId}`;

/**
 * The extension's IndexedDB database. The extension origin is shared, so the popup,
 * the list page and the background worker all open the same database.
 *
 * Stores (DB version 7):
 *   records     keyPath "id"; rows are ReadingRecord plus derived index fields (see storage.ts toRow)
 *               indexes: matchKeys (v6, multiEntry over all URLs; replaced matchKey), updatedAt, createdAt, title (_title), status ([_rank, updatedAt]),
 *                        tags (multiEntry), folderId (v3; records without a folder are not in it),
 *               readOrder ([_readSort, createdAt], v5)
 *   folders     keyPath "id"; Folder (v3)
 *   images      keyPath "id"; StoredImage (original Blob + small preview Blob), index recordId (v4)
 *   thumbnails  removed in v4 (was: record id -> 300px WebP); its blobs became images "legacy-<recordId>"
 *   meta        out-of-line key, small values ("recordVersion" = record SCHEMA_VERSION, "home" = Home settings)
 *   boardReads  keyPath ["site", "bucket"]; read board posts, packed (BucketRow in boards.ts) (v7)
 *   boardFloors keyPath "site"; { site, floor }: every post at or below floor is read (v7)
 *
 * DB_VERSION changes the store/index layout. The record *shape* has its own
 * SCHEMA_VERSION (types.ts) and is migrated lazily, see storage.ts.
 */
export const DB_NAME = 'read-tracker';
export const DB_VERSION = 7;

export const RECORDS = 'records';
/** Removed in DB v4; only referenced by upgrade(). */
const THUMBNAILS = 'thumbnails';
export const IMAGES = 'images';
export const META = 'meta';
export const FOLDERS = 'folders';
export const BOARD_READS = 'boardReads';
export const BOARD_FLOORS = 'boardFloors';

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
  matchKeys: 'matchKeys',
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
    // (the full-size original was never kept). Only pre-release databases had this store.
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
    // Revisit order: least recently read first, never read (_readSort 0) first, ties by age.
    tx.objectStore(RECORDS).createIndex(IDX.readOrder, ['_readSort', 'createdAt']);
  }
  if (oldVersion < 6) {
    // Records can have several URLs: one multiEntry index over "mode|key" tags of all of
    // them (see matchTag in match.ts) replaces the single matchKey index.
    const records = tx.objectStore(RECORDS);
    records.deleteIndex(IDX.matchKey);
    records.createIndex(IDX.matchKeys, '_matchKeys', { multiEntry: true });
  }
  if (oldVersion < 7) {
    // Board marking (merged from Booru explorer). The key is the pair, so a board's rows
    // sort together and [site] .. [site, []] spans all of them (arrays sort after numbers).
    db.createObjectStore(BOARD_READS, { keyPath: ['site', 'bucket'] });
    db.createObjectStore(BOARD_FLOORS, { keyPath: 'site' });
  }
  if (oldVersion >= 2 && oldVersion < 6) backfillDerivedFields(tx);
}

/**
 * Fill derived index fields that older rows lack, in ONE pass (two cursors updating the
 * same rows in one upgrade would overwrite each other's changes). Must match toRow() in
 * storage.ts; the next ordinary write recomputes them anyway.
 */
function backfillDerivedFields(tx: IDBTransaction) {
  const cur = tx.objectStore(RECORDS).openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    const row = c.value as Record<string, unknown>;
    c.update({
      ...row,
      _readSort: typeof row.readAt === 'number' ? row.readAt : 0,
      // Pre-v6 rows have only the main URL.
      _matchKeys: [`${row.matchMode === 'exact' ? 'e' : 'p'}|${String(row.matchKey)}`],
    });
    c.continue();
  };
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
