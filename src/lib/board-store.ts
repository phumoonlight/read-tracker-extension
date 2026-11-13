import { browser } from 'wxt/browser';
import { BOARDS_REVISION_KEY } from './changes';
import { BOARD_FLOORS, BOARD_READS, req, withTx } from './db';
import {
  BOARDS,
  BUCKET_SIZE,
  bucketOf,
  floorOf,
  groupByBucket,
  offsetOf,
  packRow,
  rowCount,
  rowHolds,
  rowOffsets,
  type BoardKey,
  type BoardQueryAnswer,
  type BoardReads,
  type BucketRow,
} from './boards';

/**
 * Board read history (see boards.ts): post numbers per board, packed in 65536-wide buckets,
 * plus one "read up to" floor per board. Every write is one transaction and bumps the
 * boards change signal (separate from records, so link marking doesn't rescan on every mark).
 */

export { onBoardsChanged } from './changes';

async function notifyBoardsChanged() {
  await browser.storage.local.set({ [BOARDS_REVISION_KEY]: `${Date.now()}-${Math.random()}` });
}

/** Every row of one board: [site] .. [site, []] (arrays sort after numbers). */
const siteRange = (site: string) => IDBKeyRange.bound([site], [site, []]);

async function floorIn(tx: IDBTransaction, site: string): Promise<number> {
  const row = (await req(tx.objectStore(BOARD_FLOORS).get(site))) as { floor?: unknown } | undefined;
  return floorOf(row?.floor);
}

/** Which of `ids` are read on `site`, and its floor. Ids under the floor are answered without a lookup. */
export async function queryBoardReads(site: BoardKey, ids: readonly number[]): Promise<BoardQueryAnswer> {
  return withTx([BOARD_READS, BOARD_FLOORS], 'readonly', async (tx) => {
    const floor = await floorIn(tx, site);
    const read: number[] = [];
    const store = tx.objectStore(BOARD_READS);
    const lookups: Promise<void>[] = [];
    for (const [bucket, held] of groupByBucket(ids)) {
      const above: number[] = [];
      for (const id of held) (id <= floor ? read : above).push(id);
      if (!above.length) continue;
      lookups.push(
        req(store.get([site, bucket])).then((row: BucketRow | undefined) => {
          for (const id of above) if (rowHolds(row, offsetOf(id))) read.push(id);
        }),
      );
    }
    await Promise.all(lookups);
    return { read, floor };
  });
}

/** Rewrite each touched bucket in the open transaction; returns how many ids changed. Ids at or below `floor` are left alone. */
async function markIn(tx: IDBTransaction, site: string, ids: Iterable<number>, read: boolean, floor: number) {
  const store = tx.objectStore(BOARD_READS);
  let changed = 0;
  const writes: Promise<void>[] = [];
  for (const [bucket, held] of groupByBucket(ids)) {
    const above = held.filter((id) => id > floor);
    if (!above.length) continue;
    writes.push(
      req(store.get([site, bucket])).then((row: BucketRow | undefined) => {
        const found = rowOffsets(row);
        const before = found.size;
        for (const id of above) {
          if (read) found.add(offsetOf(id));
          else found.delete(offsetOf(id));
        }
        if (found.size === before) return;
        changed += Math.abs(found.size - before);
        const next = packRow(site, bucket, found);
        if (next) store.put(next);
        else store.delete([site, bucket]);
      }),
    );
  }
  await Promise.all(writes);
  return changed;
}

/**
 * Mark or unmark posts, in one transaction. The floor wins both ways: marking under it
 * writes nothing (it already says so) and unmarking under it does nothing (nothing to remove).
 */
export async function markBoardReads(site: BoardKey, ids: readonly number[], read: boolean): Promise<number> {
  const changed = await withTx([BOARD_READS, BOARD_FLOORS], 'readwrite', async (tx) =>
    markIn(tx, site, ids, read, await floorIn(tx, site)),
  );
  if (changed) await notifyBoardsChanged();
  return changed;
}

/** Delete every stored id at or below `floor` (whole buckets below its bucket, then the edge bucket). */
async function pruneIn(tx: IDBTransaction, site: string, floor: number): Promise<number> {
  const store = tx.objectStore(BOARD_READS);
  const edge = bucketOf(floor);
  let removed = 0;
  if (edge > 0) {
    const below = (await req(store.getAll(IDBKeyRange.bound([site, 0], [site, edge], false, true)))) as BucketRow[];
    for (const row of below) removed += rowCount(row);
    store.delete(IDBKeyRange.bound([site, 0], [site, edge], false, true));
  }
  const row = (await req(store.get([site, edge]))) as BucketRow | undefined;
  if (row) {
    const found = rowOffsets(row);
    const before = found.size;
    const top = offsetOf(floor);
    for (const o of found) if (o <= top) found.delete(o);
    if (found.size !== before) {
      removed += before - found.size;
      const next = packRow(site, edge, found);
      if (next) store.put(next);
      else store.delete([site, edge]);
    }
  }
  return removed;
}

/**
 * Set a board's floor (0 clears it) and delete the stored ids it covers, in one transaction.
 * Clearing or lowering a floor does not bring pruned ids back. Returns how many were deleted.
 */
export async function setBoardFloor(site: BoardKey, floor: number): Promise<number> {
  const level = floorOf(floor);
  const removed = await withTx([BOARD_READS, BOARD_FLOORS], 'readwrite', async (tx) => {
    const floors = tx.objectStore(BOARD_FLOORS);
    if (level) floors.put({ site, floor: level });
    else floors.delete(site);
    return level ? pruneIn(tx, site, level) : 0;
  });
  await notifyBoardsChanged();
  return removed;
}

/** All stored ids of one board, sorted. */
async function idsIn(tx: IDBTransaction, site: string): Promise<number[]> {
  const rows = (await req(tx.objectStore(BOARD_READS).getAll(siteRange(site)))) as BucketRow[];
  const ids: number[] = [];
  for (const row of rows) {
    const base = row.bucket * BUCKET_SIZE;
    for (const o of rowOffsets(row)) ids.push(base + o);
  }
  return ids.sort((a, b) => a - b);
}

/** How many stored ids a floor of `floor` would delete (asked before raising one). */
export async function countUnderFloor(site: BoardKey, floor: number): Promise<number> {
  const ids = await withTx(BOARD_READS, 'readonly', (tx) => idsIn(tx, site));
  return ids.filter((id) => id <= floor).length;
}

export interface BoardStat {
  posts: number;
  bytes: number;
  floor: number;
}

/** What is stored, per board (every known board, zeros included). */
export async function boardStats(): Promise<Record<BoardKey, BoardStat>> {
  return withTx([BOARD_READS, BOARD_FLOORS], 'readonly', async (tx) => {
    const out = Object.fromEntries(BOARDS.map((b) => [b.key, { posts: 0, bytes: 0, floor: 0 }])) as Record<
      BoardKey,
      BoardStat
    >;
    const [rows, floors] = await Promise.all([
      req(tx.objectStore(BOARD_READS).getAll()) as Promise<BucketRow[]>,
      req(tx.objectStore(BOARD_FLOORS).getAll()) as Promise<{ site: string; floor: unknown }[]>,
    ]);
    for (const row of rows) {
      const s = out[row.site as BoardKey];
      if (!s) continue;
      s.posts += rowCount(row);
      s.bytes += row.data.byteLength;
    }
    for (const f of floors) if (out[f.site as BoardKey]) out[f.site as BoardKey].floor = floorOf(f.floor);
    return out;
  });
}

/** Everything, unpacked: for export (boards.json in the backup ZIP). */
export async function getBoardReads(): Promise<BoardReads> {
  return withTx([BOARD_READS, BOARD_FLOORS], 'readonly', async (tx) => {
    const reads: BoardReads = { sites: {}, floors: {} };
    for (const b of BOARDS) {
      const ids = await idsIn(tx, b.key);
      if (ids.length) reads.sites[b.key] = ids;
      const floor = await floorIn(tx, b.key);
      if (floor) reads.floors[b.key] = floor;
    }
    return reads;
  });
}

/** Forget a board, floor included. */
export async function clearBoard(site: BoardKey): Promise<void> {
  await withTx([BOARD_READS, BOARD_FLOORS], 'readwrite', async (tx) => {
    tx.objectStore(BOARD_READS).delete(siteRange(site));
    tx.objectStore(BOARD_FLOORS).delete(site);
  });
  await notifyBoardsChanged();
}

/**
 * Merge read history (a Booru explorer export, or boards.json from a backup), in one
 * transaction. Read history only grows: ids are unioned and the higher floor wins. The
 * floor goes in first, so ids under it are never written. Returns how many posts were added.
 */
export async function importBoardReads(reads: BoardReads): Promise<number> {
  const added = await withTx([BOARD_READS, BOARD_FLOORS], 'readwrite', async (tx) => {
    let added = 0;
    for (const b of BOARDS) {
      const mine = await floorIn(tx, b.key);
      const theirs = floorOf(reads.floors[b.key]);
      let floor = mine;
      if (theirs > mine) {
        floor = theirs;
        tx.objectStore(BOARD_FLOORS).put({ site: b.key, floor });
        await pruneIn(tx, b.key, floor);
      }
      const ids = reads.sites[b.key];
      if (ids?.length) added += await markIn(tx, b.key, ids, true, floor);
    }
    return added;
  });
  await notifyBoardsChanged();
  return added;
}
