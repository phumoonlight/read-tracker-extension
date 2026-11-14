/**
 * Board marking (merged from the "Booru explorer" extension): on image boards, posts you
 * have been through are remembered by post number and faded out of the next listing.
 *
 * Only post numbers are stored, per board, never titles or URLs: a board post is not a
 * ReadingRecord and never appears in the list. Pure code; the stores are in board-store.ts
 * and the page side in entrypoints/board-marks.content.ts.
 */

export type BoardKey = 'gelbooru' | 'konachan' | 'pixiv';

export interface Board {
  key: BoardKey;
  label: string;
  /** Host names of the board (subdomains included). */
  host: RegExp;
  /** Match patterns for the content script and its optional host permission. */
  origins: string[];
  /** The post a URL on this board is, or null. */
  postId(url: URL): number | null;
  /** The board marks posts as kept (pixiv's bookmark heart); "Mark this page read" skips them. */
  bookmarks?: true;
}

const digits = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);

/**
 * Boards whose posts can be marked. One id space each: the Gelbooru *engine* runs several
 * sites with unrelated numbers, so only gelbooru.com itself is here. Konachan's .com and
 * .net are one board (same posts, same numbers). pixiv's language prefix (/en/) is part of
 * the path, not another board.
 */
export const BOARDS: readonly Board[] = [
  {
    key: 'gelbooru',
    label: 'Gelbooru',
    host: /(^|\.)gelbooru\.com$/i,
    origins: ['*://*.gelbooru.com/*'],
    postId(url) {
      const q = url.searchParams;
      if (q.get('page') !== 'post' || q.get('s') !== 'view') return null;
      return digits(q.get('id'));
    },
  },
  {
    key: 'konachan',
    label: 'Konachan',
    host: /(^|\.)konachan\.(com|net)$/i,
    origins: ['*://*.konachan.com/*', '*://*.konachan.net/*'],
    postId(url) {
      const m = url.pathname.match(/^\/post\/show\/(\d+)/);
      return m ? Number(m[1]) : null;
    },
  },
  {
    key: 'pixiv',
    label: 'pixiv',
    host: /(^|\.)pixiv\.net$/i,
    origins: ['*://*.pixiv.net/*'],
    postId(url) {
      const m = url.pathname.match(/^(?:\/[a-z]{2})?\/artworks\/(\d+)/i);
      if (m) return Number(m[1]);
      // The old page, still what external links and old bookmarks use.
      if (/\/member_illust\.php$/i.test(url.pathname)) return digits(url.searchParams.get('illust_id'));
      return null;
    },
    bookmarks: true,
  },
];

/** Pages the board content script runs on, and the optional host permission it needs. */
export const BOARD_ORIGINS = BOARDS.flatMap((b) => b.origins);

export const boardByKey = (key: string): Board | undefined => BOARDS.find((b) => b.key === key);
export const isBoardKey = (key: unknown): key is BoardKey => typeof key === 'string' && !!boardByKey(key);

export function boardForHost(hostname: string): Board | undefined {
  return BOARDS.find((b) => b.host.test(hostname));
}

/** The post `href` links to on `board`, or null (another site, or not a post page). */
export function postIdOn(board: Board, href: string, base?: string): number | null {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol) || !board.host.test(url.hostname)) return null;
    return board.postId(url);
  } catch {
    return null;
  }
}

/** The board post a URL is (for the toolbar badge), or null. */
export function boardPostOf(href: string): { board: Board; id: number } | null {
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return null;
  }
  const board = boardForHost(host);
  const id = board ? postIdOn(board, href) : null;
  return board && id !== null ? { board, id } : null;
}

export const isPostId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;


// ---------------------------------------------------------------------------
// Packed storage. Post ids are grouped 65536 to a record (key [board, bucket]); a record
// holds whichever shape is smaller: a sorted Uint16Array of offsets (2 bytes a post), or
// an 8 KB bitmap (1 bit per id in the bucket) once it is more than a quarter full.

export const BUCKET_SIZE = 1 << 16;
export const BITMAP_BYTES = BUCKET_SIZE >> 3;
/** Past this many ids in a bucket the bitmap is smaller than the list. */
export const SPARSE_MAX = BITMAP_BYTES >> 1;

export interface BucketRow {
  site: string;
  bucket: number;
  kind: 'list' | 'map';
  data: Uint16Array | Uint8Array;
}

export const bucketOf = (id: number) => Math.floor(id / BUCKET_SIZE);
export const offsetOf = (id: number) => id % BUCKET_SIZE;

/** Every offset a row holds (the editable form). */
export function rowOffsets(row: BucketRow | undefined): Set<number> {
  const found = new Set<number>();
  if (!row) return found;
  if (row.kind === 'list') {
    for (const o of row.data) found.add(o);
    return found;
  }
  for (let byte = 0; byte < row.data.length; byte++) {
    const bits = row.data[byte]!;
    if (!bits) continue;
    for (let bit = 0; bit < 8; bit++) if (bits & (1 << bit)) found.add(byte * 8 + bit);
  }
  return found;
}

/** Whether a row holds one offset, without unpacking it. */
export function rowHolds(row: BucketRow | undefined, offset: number): boolean {
  if (!row) return false;
  if (row.kind === 'map') return (row.data[offset >> 3]! & (1 << (offset & 7))) !== 0;
  let lo = 0;
  let hi = row.data.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = row.data[mid]!;
    if (at === offset) return true;
    if (at < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** The smaller shape for these offsets, or null when there are none (delete the row). */
export function packRow(site: string, bucket: number, offsets: Set<number>): BucketRow | null {
  if (offsets.size === 0) return null;
  if (offsets.size <= SPARSE_MAX) {
    const data = Uint16Array.from(offsets);
    data.sort();
    return { site, bucket, kind: 'list', data };
  }
  const data = new Uint8Array(BITMAP_BYTES);
  for (const o of offsets) data[o >> 3]! |= 1 << (o & 7);
  return { site, bucket, kind: 'map', data };
}

/** Set bits per byte value (a full bitmap is 8192 lookups, not 65536 bit tests). */
const BITS = Uint8Array.from({ length: 256 }, (_, v) => {
  let n = 0;
  for (let b = v; b; b >>= 1) n += b & 1;
  return n;
});

export function rowCount(row: BucketRow): number {
  if (row.kind === 'list') return row.data.length;
  let total = 0;
  for (const byte of row.data) total += BITS[byte]!;
  return total;
}

/** Valid ids grouped by bucket. */
export function groupByBucket(ids: Iterable<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const id of ids) {
    if (!isPostId(id)) continue;
    const b = bucketOf(id);
    const list = out.get(b);
    if (list) list.push(id);
    else out.set(b, [id]);
  }
  return out;
}

/** First post id a "read up to N" range marks (post numbers start at 1). */
export const RANGE_START = 1;

/**
 * A row with every id from `from` to `to` (inclusive) added to it, for `bucket`. A range
 * covering the whole bucket becomes a full bitmap directly (no set of 65536 numbers).
 * Returns the row unchanged (same object) when the range doesn't touch this bucket.
 */
export function addRange(
  row: BucketRow | undefined,
  site: string,
  bucket: number,
  from: number,
  to: number,
): BucketRow | undefined {
  const base = bucket * BUCKET_SIZE;
  const lo = Math.max(from, base) - base;
  const hi = Math.min(to, base + BUCKET_SIZE - 1) - base;
  if (lo > hi) return row;
  if (lo === 0 && hi === BUCKET_SIZE - 1) {
    return { site, bucket, kind: 'map', data: new Uint8Array(BITMAP_BYTES).fill(0xff) };
  }
  const offsets = rowOffsets(row);
  for (let o = lo; o <= hi; o++) offsets.add(o);
  return packRow(site, bucket, offsets) ?? row;
}

/** Every read post id in one board's rows, ascending (for export: listed one by one, no floor). */
export function rowsToIds(rows: readonly BucketRow[]): number[] {
  const ids: number[] = [];
  for (const row of [...rows].sort((x, y) => x.bucket - y.bucket)) {
    const base = row.bucket * BUCKET_SIZE;
    for (const off of [...rowOffsets(row)].sort((x, y) => x - y)) ids.push(base + off);
  }
  return ids;
}

/** The buckets a range of ids touches. */
export function bucketsOf(from: number, to: number): number[] {
  const out: number[] = [];
  for (let b = bucketOf(from); b <= bucketOf(to); b++) out.push(b);
  return out;
}

// ---------------------------------------------------------------------------
// Messages between the board content script and the background.

export const BOARD_QUERY_MESSAGE = 'read-tracker:board-query';
export const BOARD_MARK_MESSAGE = 'read-tracker:board-mark';
/** Most ids per message (the content script sends larger pages in chunks). */
export const BOARD_BATCH = 1000;

export interface BoardQueryRequest {
  type: typeof BOARD_QUERY_MESSAGE;
  site: BoardKey;
  ids: number[];
}
/** The subset of the asked ids that are read. */
export interface BoardQueryAnswer {
  read: number[];
}
export interface BoardMarkRequest {
  type: typeof BOARD_MARK_MESSAGE;
  site: BoardKey;
  ids: number[];
  read: boolean;
}

function isIdsMessage(m: unknown, type: string): m is { site: BoardKey; ids: number[] } {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o.type === type && isBoardKey(o.site) && Array.isArray(o.ids) && o.ids.every(isPostId);
}
export const isBoardQuery = (m: unknown): m is BoardQueryRequest => isIdsMessage(m, BOARD_QUERY_MESSAGE);
export const isBoardMark = (m: unknown): m is BoardMarkRequest =>
  isIdsMessage(m, BOARD_MARK_MESSAGE) && typeof (m as { read?: unknown }).read === 'boolean';

/**
 * Popup -> content script of the active tab (tabs.sendMessage): what is on the page, mark
 * the whole page, or start / stop marking mode. Every request is answered with BoardPageInfo.
 */
export const BOARD_PAGE_MESSAGE = 'read-tracker:board-page';

export type BoardPageRequest =
  | { type: typeof BOARD_PAGE_MESSAGE; action: 'info' }
  | { type: typeof BOARD_PAGE_MESSAGE; action: 'mark-page' }
  | { type: typeof BOARD_PAGE_MESSAGE; action: 'marking'; on: boolean };

export interface BoardPageInfo {
  /** Post thumbnails on the page (distinct posts). */
  posts: number;
  /** How many of them are read. */
  read: number;
  /** How many are bookmarked on the board (pixiv), which "Mark this page read" skips. */
  kept: number;
  /** Marking mode is on (clicking thumbnails marks them). */
  marking: boolean;
}

export function isBoardPageRequest(m: unknown): m is BoardPageRequest {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  if (o.type !== BOARD_PAGE_MESSAGE) return false;
  return o.action === 'info' || o.action === 'mark-page' || (o.action === 'marking' && typeof o.on === 'boolean');
}

// ---------------------------------------------------------------------------
// JSON files, import only: Booru explorer's export, and the board files of older backups
// (boards.json in layout 2). Nothing writes this format now.
//   { format: "booru-explorer-reads", version: 1, exported: ISO date,
//     sites: { <board>: [sorted post ids] }, floors?: { <board>: N } }
// There is no floor in Read Tracker, only marked posts: `floors: { b: N }` ("read up to N")
// marks posts 1..N read.

export const BOARD_FILE_FORMAT = 'booru-explorer-reads';
export const BOARD_FILE_VERSION = 1;

/** Read history to import (or, `sites` only, to export). */
export interface BoardReads {
  /** Read post ids per board. */
  sites: Partial<Record<BoardKey, number[]>>;
  /** Import only: also mark posts 1..N read (from Booru explorer's "read up to"). */
  upTo?: Partial<Record<BoardKey, number>>;
}

/** A parsed file, ready to import. */
export interface ParsedBoardFile extends BoardReads {
  exported: string;
  upTo: Partial<Record<BoardKey, number>>;
}

/** Several parsed files as one import: ids unioned and sorted, the highest "read up to" kept. */
export function mergeBoardReads(files: readonly BoardReads[]): BoardReads & { upTo: Partial<Record<BoardKey, number>> } {
  const sites: BoardReads['sites'] = {};
  const upTo: Partial<Record<BoardKey, number>> = {};
  for (const b of BOARDS) {
    const ids = new Set<number>();
    for (const f of files) {
      for (const id of f.sites[b.key] ?? []) ids.add(id);
      const n = f.upTo?.[b.key];
      if (n !== undefined && n > (upTo[b.key] ?? 0)) upTo[b.key] = n;
    }
    if (ids.size) sites[b.key] = [...ids].sort((x, y) => x - y);
  }
  return { sites, upTo };
}

/** Posts listed for one board, plus its run 1..N. */
export const boardSitePostCount = (reads: BoardReads, key: BoardKey) =>
  (reads.sites[key]?.length ?? 0) + Math.max((reads.upTo?.[key] ?? 0) - RANGE_START + 1, 0);

/** Read posts in total (listed ids plus 1..N runs). */
export const boardPostCount = (reads: BoardReads) =>
  BOARDS.reduce((n, b) => n + boardSitePostCount(reads, b.key), 0);

export const isEmptyBoardReads = (reads: BoardReads) =>
  boardPostCount(reads) === 0 && Object.keys(reads.upTo ?? {}).length === 0;

// ---------------------------------------------------------------------------
// Binary id files (backup booru/<board>.bin): the board is the file name.
//   "RTBI" (4 bytes), version (1 byte), count (varint), first id (varint), then count - 1 gaps
//   (varint, each > 0: id minus the previous id). A varint is 7 bits per byte, low bits first;
//   the top bit says another byte follows. Mostly 1 byte a post (gaps under 128).

const IDS_MAGIC = [0x52, 0x54, 0x42, 0x49]; // "RTBI"
export const BOARD_IDS_VERSION = 1;
export const BOARD_IDS_EXT = '.bin';

function pushVarint(out: number[], v: number) {
  // Arithmetic, not bit operators: ids may be above 2^31.
  while (v >= 128) {
    out.push((v % 128) + 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** Encode post ids (any order, duplicates dropped). */
export function encodeBoardIds(ids: readonly number[]): Uint8Array<ArrayBuffer> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const out: number[] = [...IDS_MAGIC, BOARD_IDS_VERSION];
  pushVarint(out, sorted.length);
  let prev = 0;
  sorted.forEach((id, i) => {
    if (!isPostId(id)) throw new Error(`Invalid post number: ${id}`);
    pushVarint(out, i === 0 ? id : id - prev);
    prev = id;
  });
  return Uint8Array.from(out);
}

/** Decode a file from encodeBoardIds. Throws a user-facing error on anything malformed. */
export function decodeBoardIds(bytes: Uint8Array): number[] {
  if (bytes.length < 5 || IDS_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Not a board id file.');
  if (bytes[4]! > BOARD_IDS_VERSION) throw new Error('The file is from a newer version. Update the extension first.');
  let at = 5;
  const varint = () => {
    let v = 0;
    let scale = 1;
    for (;;) {
      if (at >= bytes.length) throw new Error('The file is cut short.');
      const byte = bytes[at++]!;
      v += (byte % 128) * scale;
      if (!Number.isSafeInteger(v)) throw new Error('The file has a number that is too large.');
      if (byte < 128) return v;
      scale *= 128;
    }
  };
  const count = varint();
  // Each id takes at least one byte: a count larger than what's left is corrupt.
  if (count > bytes.length - at) throw new Error('The file is cut short.');
  const ids = new Array<number>(count);
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const v = varint();
    if (i > 0 && v === 0) throw new Error('The file repeats a post.');
    prev = i === 0 ? v : prev + v;
    if (!Number.isSafeInteger(prev)) throw new Error('The file has a number that is too large.');
    ids[i] = prev;
  }
  if (at !== bytes.length) throw new Error('The file has extra data at the end.');
  return ids;
}

/** A board id file's board, from its name ("konachan.bin" -> konachan). */
export function boardOfIdsFile(name: string): BoardKey | undefined {
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (!base.toLowerCase().endsWith(BOARD_IDS_EXT)) return undefined;
  const key = base.slice(0, -BOARD_IDS_EXT.length);
  return isBoardKey(key) ? key : undefined;
}

/**
 * Parse a Booru explorer export (or boards.json from a layout 2 backup). Throws a user-facing error
 * if it isn't one; boards this build doesn't know and invalid ids go to `issues`.
 */
export function parseBoardFile(text: string, issues: string[] = []): ParsedBoardFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const o = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  if (!o || o.format !== BOARD_FILE_FORMAT || typeof o.sites !== 'object' || o.sites === null) {
    throw new Error('Not a Booru explorer export.');
  }
  if (typeof o.version === 'number' && o.version > BOARD_FILE_VERSION) {
    throw new Error('The file is from a newer version of Booru explorer.');
  }
  const sites: BoardReads['sites'] = {};
  for (const [key, ids] of Object.entries(o.sites as Record<string, unknown>)) {
    if (!isBoardKey(key)) {
      issues.push(`Board "${key}" isn't supported; its read posts were skipped.`);
      continue;
    }
    if (!Array.isArray(ids)) {
      issues.push(`${boardByKey(key)!.label}: the post list is invalid; skipped.`);
      continue;
    }
    const valid = [...new Set(ids.filter(isPostId))].sort((a, b) => a - b);
    const bad = ids.length - ids.filter(isPostId).length;
    if (bad) issues.push(`${boardByKey(key)!.label}: ${bad} invalid post number${bad === 1 ? '' : 's'} skipped.`);
    if (valid.length) sites[key] = valid;
  }
  const upTo: ParsedBoardFile['upTo'] = {};
  if (typeof o.floors === 'object' && o.floors !== null) {
    for (const [key, v] of Object.entries(o.floors as Record<string, unknown>)) {
      if (!isBoardKey(key)) {
        issues.push(`Board "${key}" isn't supported; its "read up to" was skipped.`);
        continue;
      }
      if (isPostId(v) && v >= RANGE_START) upTo[key] = v;
    }
  }
  return { exported: typeof o.exported === 'string' ? o.exported : '', sites, upTo };
}

// ---------------------------------------------------------------------------
// pixiv's bookmark heart is recognised by its colour (the label is the interface
// language; the pink is the same in all of them).

/** [r, g, b] of a CSS colour ("#rgb", "#rrggbb", "rgb()/rgba()"), or null (fully transparent too). */
export function readRgb(value: string | null | undefined): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const digits = hex[1]!;
    const pairs = digits.length === 3 ? [...digits].map((d) => d + d) : digits.match(/../g)!;
    const [r = 0, g = 0, b = 0] = pairs.map((p) => parseInt(p, 16));
    return [r, g, b];
  }
  const call = value.match(/^rgba?\(([^)]+)\)/i);
  if (!call) return null;
  const parts = call[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  if (parts.length > 3 && parts[3] === 0) return null;
  const [r = 0, g = 0, b = 0] = parts;
  return [r, g, b];
}

/**
 * The pink of a filled heart: a range, not one hex (svg fill or glyph colour, lock overlay
 * for private bookmarks). Must not take white, grey or black, which the empty heart is.
 */
export function pinkish(value: string | null | undefined): boolean {
  const rgb = readRgb(value);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return r > 190 && g < 150 && b < 190 && r - g > 80 && r - b > 40;
}
