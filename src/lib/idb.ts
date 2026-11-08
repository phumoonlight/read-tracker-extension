/**
 * Minimal promise wrapper over one IndexedDB object store (out-of-line string keys).
 * Replaces idb-keyval; only the operations this extension needs.
 */
export interface KeyValueStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

export function createKeyValueStore<V>(dbName: string, storeName: string): KeyValueStore<V> {
  let dbPromise: Promise<IDBDatabase> | undefined;

  const openDb = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another context upgrades or deletes the DB, drop our handle and reopen next time.
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
    });
    return dbPromise;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await openDb();
    const tx = db.transaction(storeName, mode);
    const request = promisify(run(tx.objectStore(storeName)));
    if (mode === 'readonly') return request;
    // For writes, resolve only after the transaction commits.
    const [result] = await Promise.all([request, done(tx)]);
    return result;
  };

  return {
    get: (key) => withStore('readonly', (s) => s.get(key) as IDBRequest<V | undefined>),
    set: async (key, value) => {
      await withStore('readwrite', (s) => s.put(value, key));
    },
    del: async (key) => {
      await withStore('readwrite', (s) => s.delete(key));
    },
    keys: async () => (await withStore('readonly', (s) => s.getAllKeys())).map(String),
  };
}
