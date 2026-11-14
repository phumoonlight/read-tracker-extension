import { browser } from 'wxt/browser';
import { BOARDS_REVISION_KEY } from './changes';
import { BOARD_READS, req, withTx } from './db';
import {
  addRange,
  BOARDS,
  bucketsOf,
  groupByBucket,
  offsetOf,
  packRow,
  RANGE_START,
  rowCount,
  rowHolds,
  rowOffsets,
  rowsToIds,
  type BoardKey,
  type BoardQueryAnswer,
  type BoardReads,
  type BucketRow,
} from './boards';

/**
 * Board read history (see boards.ts): post numbers per board, packed in 65536-wide buckets
 * (each a sorted list or a bitmap, whichever is smaller). Every write is one transaction and
 * bumps the boards change signal (separate from records, so link marking doesn't rescan on
 * every mark).
 */

export { onBoardsChanged } from './changes';

async function notifyBoardsChanged() {
  await browser.storage.local.set({ [BOARDS_REVISION_KEY]: `${Date.now()}-${Math.random()}` });
}

/** Every row of one board: [site] .. [site, []] (arrays sort after numbers). */
const siteRange = (site: string) => IDBKeyRange.bound([site], [site, []]);

/** Which of `ids` are read on `site`. */
export async function queryBoardReads(site: BoardKey, ids: readonly number[]): Promise<BoardQueryAnswer> {
  return withTx(BOARD_READS, 'readonly', async (tx) => {
    const read: number[] = [];
    const store = tx.objectStore(BOARD_READS);
    await Promise.all(
      [...groupByBucket(ids)].map(([bucket, held]) =>
        req(store.get([site, bucket])).then((row: BucketRow | undefined) => {
          for (const id of held) if (rowHolds(row, offsetOf(id))) read.push(id);
        }),
      ),
    );
    return { read };
  });
}

/** Rewrite each touched bucket in the open transaction; returns how many ids changed. */
async function markIn(tx: IDBTransaction, site: string, ids: Iterable<number>, read: boolean) {
  const store = tx.objectStore(BOARD_READS);
  let changed = 0;
  await Promise.all(
    [...groupByBucket(ids)].map(([bucket, held]) =>
      req(store.get([site, bucket])).then((row: BucketRow | undefined) => {
        const found = rowOffsets(row);
        const before = found.size;
        for (const id of held) {
          if (read) found.add(offsetOf(id));
          else found.delete(offsetOf(id));
        }
        if (found.size === before) return;
        changed += Math.abs(found.size - before);
        const next = packRow(site, bucket, found);
        if (next) store.put(next);
        else store.delete([site, bucket]);
      }),
    ),
  );
  return changed;
}

/** Mark ids from..to read (whole buckets become full bitmaps); returns how many were added. */
async function markRangeIn(tx: IDBTransaction, site: string, from: number, to: number) {
  const store = tx.objectStore(BOARD_READS);
  let added = 0;
  await Promise.all(
    bucketsOf(from, to).map((bucket) =>
      req(store.get([site, bucket])).then((row: BucketRow | undefined) => {
        const next = addRange(row, site, bucket, from, to);
        if (!next || next === row) return;
        const diff = rowCount(next) - (row ? rowCount(row) : 0);
        if (diff === 0) return; // already all read
        added += diff;
        store.put(next);
      }),
    ),
  );
  return added;
}

/** Mark or unmark posts, in one transaction. */
export async function markBoardReads(site: BoardKey, ids: readonly number[], read: boolean): Promise<number> {
  const changed = await withTx(BOARD_READS, 'readwrite', (tx) => markIn(tx, site, ids, read));
  if (changed) await notifyBoardsChanged();
  return changed;
}

export interface BoardStat {
  posts: number;
  bytes: number;
}

/** What is stored, per board (every known board, zeros included). */
export async function boardStats(): Promise<Record<BoardKey, BoardStat>> {
  return withTx(BOARD_READS, 'readonly', async (tx) => {
    const out = Object.fromEntries(BOARDS.map((b) => [b.key, { posts: 0, bytes: 0 }])) as Record<BoardKey, BoardStat>;
    const rows = (await req(tx.objectStore(BOARD_READS).getAll())) as BucketRow[];
    for (const row of rows) {
      const s = out[row.site as BoardKey];
      if (!s) continue;
      s.posts += rowCount(row);
      s.bytes += row.data.byteLength;
    }
    return out;
  });
}

/** Everything, for export (booru/<board>.json in the backup ZIP): every read id per board, listed. */
export async function getBoardReads(): Promise<BoardReads> {
  return withTx(BOARD_READS, 'readonly', async (tx) => {
    const reads: BoardReads = { sites: {} };
    for (const b of BOARDS) {
      const rows = (await req(tx.objectStore(BOARD_READS).getAll(siteRange(b.key)))) as BucketRow[];
      const ids = rowsToIds(rows);
      if (ids.length) reads.sites[b.key] = ids;
    }
    return reads;
  });
}

/** Forget a board. */
export async function clearBoard(site: BoardKey): Promise<void> {
  await withTx(BOARD_READS, 'readwrite', async (tx) => {
    tx.objectStore(BOARD_READS).delete(siteRange(site));
  });
  await notifyBoardsChanged();
}

/**
 * Merge read history (a Booru explorer export, or the booru/ files of a backup), in one
 * transaction. Read history only grows: ids are unioned, and a "read up to N" marks posts
 * 1..N. Returns how many posts were added.
 */
export async function importBoardReads(reads: BoardReads): Promise<number> {
  const added = await withTx(BOARD_READS, 'readwrite', async (tx) => {
    let added = 0;
    for (const b of BOARDS) {
      const upTo = reads.upTo?.[b.key];
      // The range first: whole buckets are written as full bitmaps without listing ids.
      if (upTo && upTo >= RANGE_START) added += await markRangeIn(tx, b.key, RANGE_START, upTo);
      const ids = reads.sites[b.key];
      if (ids?.length) added += await markIn(tx, b.key, ids, true);
    }
    return added;
  });
  await notifyBoardsChanged();
  return added;
}
