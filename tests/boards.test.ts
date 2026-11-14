import { describe, expect, it } from 'vitest';
import { boardBackupEntries, boardBackupPath, buildManifest, parseManifest } from '@/lib/backup';
import {
  addRange,
  BITMAP_BYTES,
  BOARD_FILE_FORMAT,
  BOARD_MARK_MESSAGE,
  BOARD_ORIGINS,
  BOARD_PAGE_MESSAGE,
  BOARD_QUERY_MESSAGE,
  boardByKey,
  boardPostCount,
  boardPostOf,
  boardSitePostCount,
  BUCKET_SIZE,
  bucketsOf,
  boardOfIdsFile,
  decodeBoardIds,
  encodeBoardIds,
  groupByBucket,
  isBoardMark,
  isBoardPageRequest,
  isBoardQuery,
  isEmptyBoardReads,
  packRow,
  mergeBoardReads,
  parseBoardFile,
  parseBoardPrefs,
  pinkish,
  postIdOn,
  RANGE_START,
  rowsToIds,
  rowCount,
  rowHolds,
  rowOffsets,
  SPARSE_MAX,
} from '@/lib/boards';

const post = (href: string) => {
  const p = boardPostOf(href);
  return p ? `${p.board.key}:${p.id}` : null;
};

describe('board post ids', () => {
  it('reads Gelbooru post pages only', () => {
    expect(post('https://gelbooru.com/index.php?page=post&s=view&id=123')).toBe('gelbooru:123');
    expect(post('https://www.gelbooru.com/index.php?s=view&page=post&id=9&tags=x')).toBe('gelbooru:9');
    expect(post('https://gelbooru.com/index.php?page=post&s=list&tags=x')).toBeNull();
    expect(post('https://gelbooru.com/index.php?page=post&s=view&id=12a')).toBeNull();
    // Same engine, different id space: not a board here.
    expect(post('https://safebooru.org/index.php?page=post&s=view&id=123')).toBeNull();
  });

  it('treats konachan .com and .net as one board', () => {
    expect(post('https://konachan.com/post/show/42/some-tags')).toBe('konachan:42');
    expect(post('http://konachan.net/post/show/42')).toBe('konachan:42');
    expect(post('https://konachan.com/post?tags=x')).toBeNull();
  });

  it('reads pixiv artworks with or without a language prefix, and the old page', () => {
    expect(post('https://www.pixiv.net/artworks/100')).toBe('pixiv:100');
    expect(post('https://www.pixiv.net/en/artworks/100')).toBe('pixiv:100');
    expect(post('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=7')).toBe('pixiv:7');
    expect(post('https://www.pixiv.net/users/5')).toBeNull();
  });

  it('resolves relative links against the page, and ignores other hosts and schemes', () => {
    const pixiv = boardByKey('pixiv')!;
    expect(postIdOn(pixiv, '/en/artworks/55', 'https://www.pixiv.net/tags/x')).toBe(55);
    expect(postIdOn(pixiv, 'https://example.com/artworks/55')).toBeNull();
    expect(postIdOn(pixiv, 'javascript:void(0)', 'https://www.pixiv.net/')).toBeNull();
    expect(post('not a url')).toBeNull();
  });

  it('has match patterns for every board host', () => {
    expect(BOARD_ORIGINS).toEqual(['*://*.gelbooru.com/*', '*://*.konachan.com/*', '*://*.konachan.net/*', '*://*.pixiv.net/*']);
  });
});

describe('packed buckets', () => {
  it('groups ids by bucket and drops invalid ones', () => {
    const g = groupByBucket([1, BUCKET_SIZE + 2, 3, -1, 1.5, BUCKET_SIZE * 5]);
    expect([...g]).toEqual([
      [0, [1, 3]],
      [1, [BUCKET_SIZE + 2]],
      [5, [BUCKET_SIZE * 5]],
    ]);
  });

  it('keeps a sparse bucket as a sorted list', () => {
    const row = packRow('pixiv', 0, new Set([9, 3, 65535]))!;
    expect(row.kind).toBe('list');
    expect([...row.data]).toEqual([3, 9, 65535]);
    expect(rowCount(row)).toBe(3);
    expect(rowHolds(row, 9)).toBe(true);
    expect(rowHolds(row, 4)).toBe(false);
    expect([...rowOffsets(row)].sort((a, b) => a - b)).toEqual([3, 9, 65535]);
  });

  it('switches to a bitmap past a quarter full, with the same contents', () => {
    const offsets = new Set(Array.from({ length: SPARSE_MAX + 1 }, (_, i) => i * 3));
    const row = packRow('gelbooru', 2, offsets)!;
    expect(row.kind).toBe('map');
    expect(row.data.byteLength).toBe(BITMAP_BYTES);
    expect(rowCount(row)).toBe(offsets.size);
    expect(rowHolds(row, 3)).toBe(true);
    expect(rowHolds(row, 4)).toBe(false);
    expect(rowOffsets(row)).toEqual(offsets);
    // At the limit it stays a list.
    expect(packRow('gelbooru', 2, new Set([...offsets].slice(1)))!.kind).toBe('list');
  });

  it('packs nothing for an empty bucket', () => {
    expect(packRow('pixiv', 0, new Set())).toBeNull();
    expect(rowOffsets(undefined).size).toBe(0);
    expect(rowHolds(undefined, 1)).toBe(false);
  });
});

describe('messages', () => {
  it('accepts well-formed requests only', () => {
    expect(isBoardQuery({ type: BOARD_QUERY_MESSAGE, site: 'pixiv', ids: [1, 2] })).toBe(true);
    expect(isBoardQuery({ type: BOARD_QUERY_MESSAGE, site: 'danbooru', ids: [1] })).toBe(false);
    expect(isBoardQuery({ type: BOARD_QUERY_MESSAGE, site: 'pixiv', ids: [-1] })).toBe(false);
    expect(isBoardQuery({ type: BOARD_QUERY_MESSAGE, site: 'pixiv', ids: ['1'] })).toBe(false);
    expect(isBoardMark({ type: BOARD_MARK_MESSAGE, site: 'konachan', ids: [5], read: false })).toBe(true);
    expect(isBoardMark({ type: BOARD_MARK_MESSAGE, site: 'konachan', ids: [5] })).toBe(false);
    expect(isBoardMark(null)).toBe(false);
  });

  it('accepts popup page requests', () => {
    expect(isBoardPageRequest({ type: BOARD_PAGE_MESSAGE, action: 'info' })).toBe(true);
    expect(isBoardPageRequest({ type: BOARD_PAGE_MESSAGE, action: 'mark-page' })).toBe(true);
    expect(isBoardPageRequest({ type: BOARD_PAGE_MESSAGE, action: 'marking', on: true })).toBe(true);
    expect(isBoardPageRequest({ type: BOARD_PAGE_MESSAGE, action: 'marking' })).toBe(false);
    expect(isBoardPageRequest({ type: BOARD_PAGE_MESSAGE, action: 'delete' })).toBe(false);
    expect(isBoardPageRequest({ type: BOARD_QUERY_MESSAGE, action: 'info' })).toBe(false);
  });
});

describe('ranges ("read up to" turned into marked posts)', () => {
  it('lists the buckets a range touches', () => {
    expect(bucketsOf(1, 2254)).toEqual([0]);
    expect(bucketsOf(1, BUCKET_SIZE)).toEqual([0, 1]);
    expect(bucketsOf(BUCKET_SIZE * 2, BUCKET_SIZE * 3 - 1)).toEqual([2]);
  });

  it('adds a partial range to a list, merged with what is there', () => {
    const row = addRange(packRow('konachan', 0, new Set([5000]))!, 'konachan', 0, RANGE_START, 2254)!;
    expect(row.kind).toBe('list');
    expect(rowCount(row)).toBe(2255); // 1..2254 plus 5000
    expect(rowHolds(row, 0)).toBe(false);
    expect(rowHolds(row, 1)).toBe(true);
    expect(rowHolds(row, 2254)).toBe(true);
    expect(rowHolds(row, 2255)).toBe(false);
    expect(rowHolds(row, 5000)).toBe(true);
  });

  it('writes a fully covered bucket as a full bitmap', () => {
    const row = addRange(undefined, 'pixiv', 3, RANGE_START, BUCKET_SIZE * 10)!;
    expect(row.kind).toBe('map');
    expect(rowCount(row)).toBe(BUCKET_SIZE);
  });

  it('switches to a bitmap when a partial range makes the bucket dense', () => {
    const row = addRange(undefined, 'gelbooru', 1, BUCKET_SIZE, BUCKET_SIZE + 9999)!;
    expect(row.kind).toBe('map');
    expect(rowCount(row)).toBe(10000);
    expect(rowHolds(row, 9999)).toBe(true);
    expect(rowHolds(row, 10000)).toBe(false);
  });

  it('leaves a bucket the range misses unchanged', () => {
    const row = packRow('pixiv', 5, new Set([1]))!;
    expect(addRange(row, 'pixiv', 5, 1, 100)).toBe(row);
    expect(addRange(undefined, 'pixiv', 5, 1, 100)).toBeUndefined();
  });
});

describe('rowsToIds (export lists every read post, no floor)', () => {
  const rowsFor = (ids: number[]) =>
    [...groupByBucket(ids)].map(([b, held]) => packRow('pixiv', b, new Set(held.map((id) => id % BUCKET_SIZE)))!);

  it('lists every id ascending, whatever the row order', () => {
    expect(rowsToIds(rowsFor([BUCKET_SIZE * 3 + 1, 9, 0, 5]).reverse())).toEqual([0, 5, 9, BUCKET_SIZE * 3 + 1]);
    expect(rowsToIds([])).toEqual([]);
  });

  it('lists a range imported from "read up to" one by one', () => {
    const rows = bucketsOf(RANGE_START, 2268).map((b) => addRange(undefined, 'konachan', b, RANGE_START, 2268)!);
    expect(rowsToIds(rows)).toEqual(Array.from({ length: 2268 }, (_, i) => i + 1));
  });

  it('round-trips random read sets exactly (bitmaps and lists)', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      const ids = new Set<number>();
      if (rand(3)) for (let i = rand(2); i <= rand(BUCKET_SIZE * 2); i++) ids.add(i);
      for (let i = rand(300); i > 0; i--) ids.add(rand(BUCKET_SIZE * 4));
      expect(rowsToIds(rowsFor([...ids]))).toEqual([...ids].sort((x, y) => x - y));
    }
  });
});

describe('Booru explorer files', () => {
  const file = (o: object) => JSON.stringify({ format: BOARD_FILE_FORMAT, version: 1, exported: '2026-01-02T00:00:00.000Z', ...o });

  it('reads an export: ids deduplicated and sorted, "read up to" (floors) as a range to mark', () => {
    const issues: string[] = [];
    const f = parseBoardFile(file({ sites: { pixiv: [5, 1, 5], gelbooru: [] }, floors: { konachan: 100 } }), issues);
    expect(f.sites).toEqual({ pixiv: [1, 5] });
    expect(f.upTo).toEqual({ konachan: 100 });
    expect(f.exported).toBe('2026-01-02T00:00:00.000Z');
    expect(issues).toEqual([]);
    expect(boardPostCount(f)).toBe(102); // 2 listed + posts 1..100
  });

  it('reports unknown boards and invalid ids', () => {
    const issues: string[] = [];
    const f = parseBoardFile(
      file({ sites: { yandere: [1], konachan: [1, -2, 'x', 3] }, floors: { yandere: 5, pixiv: 0 } }),
      issues,
    );
    expect(f.sites).toEqual({ konachan: [1, 3] });
    expect(f.upTo).toEqual({});
    expect(issues).toHaveLength(3);
  });

  it('rejects other files', () => {
    expect(() => parseBoardFile('{')).toThrow(/JSON/);
    expect(() => parseBoardFile(JSON.stringify({ format: 'read-tracker-backup' }))).toThrow(/Booru explorer/);
    expect(() => parseBoardFile(file({ version: 2, sites: {} }))).toThrow(/newer/);
  });

  it('counts floors as posts 1..N', () => {
    const imported = parseBoardFile(file({ sites: { pixiv: [9000] }, floors: { pixiv: 2254 } }));
    expect(boardSitePostCount(imported, 'pixiv')).toBe(2255);
    expect(boardPostCount(imported)).toBe(2255);
    expect(isEmptyBoardReads({ sites: { pixiv: [1] } })).toBe(false);
    expect(isEmptyBoardReads({ sites: {}, upTo: { gelbooru: 9 } })).toBe(false);
    expect(isEmptyBoardReads({ sites: {} })).toBe(true);
  });

  it('merges several files into one import', () => {
    const merged = mergeBoardReads([
      { sites: { pixiv: [3, 1] } },
      { sites: { konachan: [7] } },
      { sites: { pixiv: [2, 3] }, upTo: { konachan: 5 } },
      { sites: {}, upTo: { konachan: 9 } },
    ]);
    expect(merged.sites).toEqual({ pixiv: [1, 2, 3], konachan: [7] });
    expect(merged.upTo).toEqual({ konachan: 9 });
  });

  it('finds board files in a backup: booru/<board>.bin and layout 2 boards.json, not booru/*.json', () => {
    expect(boardBackupPath('pixiv')).toBe('booru/pixiv.bin');
    expect(
      boardBackupEntries([
        'manifest.json',
        'boards.json',
        'booru/pixiv.bin',
        'booru/konachan.json',
        'booru/x/y.bin',
        'booru/a.txt',
        'images/booru.bin',
      ]),
    ).toEqual([
      { name: 'boards.json', binary: false },
      { name: 'booru/pixiv.bin', binary: true },
    ]);
  });

  it('carries the board post count in the backup manifest', () => {
    const m = buildManifest({ records: 1, images: 0, booruPosts: 7 }, [], undefined, 1);
    expect(parseManifest(JSON.stringify(m)).counts).toEqual({ records: 1, folders: 0, images: 0, booruPosts: 7 });
    const old = { ...buildManifest({ records: 1, images: 0 }, [], undefined, 1), layout: 1 };
    expect(parseManifest(JSON.stringify(old)).counts.booruPosts).toBeUndefined();
    // Backups from 0.1.16 and earlier call it boardPosts.
    const { booruPosts, ...rest } = m.counts;
    const before = { ...m, counts: { ...rest, boardPosts: booruPosts } };
    expect(parseManifest(JSON.stringify(before)).counts.booruPosts).toBe(7);
  });
});

describe('binary id files (gaps as varints)', () => {
  const bytes = (ids: number[]) => [...encodeBoardIds(ids)];

  it('writes the header, the count, the first id and the gaps', () => {
    // "RTBI", version 1, count 4, 410600 (3 bytes), gaps 5, 15, 8.
    expect(bytes([410628, 410600, 410620, 410605])).toEqual([
      0x52, 0x54, 0x42, 0x49, 1, 4, 0xe8, 0x87, 0x19, 5, 15, 8,
    ]);
    expect(bytes([])).toEqual([0x52, 0x54, 0x42, 0x49, 1, 0]);
    // 1..2268 read: one byte a post.
    const run = Array.from({ length: 2268 }, (_, i) => i + 1);
    expect(encodeBoardIds(run).length).toBe(5 + 2 + 2268);
  });

  it('round-trips random sets, post 0 and very large ids', () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 40; round++) {
      const ids = new Set<number>();
      for (let i = rand(500); i > 0; i--) ids.add(rand(round % 2 ? 300 : 2 ** 30));
      const sorted = [...ids].sort((a, b) => a - b);
      expect(decodeBoardIds(encodeBoardIds([...ids, ...ids]))).toEqual(sorted);
    }
    const edge = [0, 1, 127, 128, 16383, 16384, 2 ** 31, Number.MAX_SAFE_INTEGER];
    expect(decodeBoardIds(encodeBoardIds(edge))).toEqual(edge);
  });

  it('rejects malformed files', () => {
    const good = encodeBoardIds([5, 9, 300]);
    expect(() => decodeBoardIds(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/Not a board id file/);
    expect(() => decodeBoardIds(Uint8Array.from([...good.slice(0, 4), 2, 0]))).toThrow(/newer/);
    expect(() => decodeBoardIds(good.slice(0, -1))).toThrow(/cut short/);
    expect(() => decodeBoardIds(Uint8Array.from([...good, 0]))).toThrow(/extra data/);
    expect(() => decodeBoardIds(Uint8Array.from([0x52, 0x54, 0x42, 0x49, 1, 2, 5, 0]))).toThrow(/repeats/);
    expect(() => decodeBoardIds(Uint8Array.from([0x52, 0x54, 0x42, 0x49, 1, 100, 1]))).toThrow(/cut short/);
    expect(() => decodeBoardIds(encodeBoardIds([]).slice(0, 3))).toThrow(/Not a board id file/);
    expect(() => encodeBoardIds([-1])).toThrow();
  });

  it('takes the board from the file name', () => {
    expect(boardOfIdsFile('booru/konachan.bin')).toBe('konachan');
    expect(boardOfIdsFile('pixiv.BIN')).toBe('pixiv');
    expect(boardOfIdsFile('booru/yandere.bin')).toBeUndefined();
    expect(boardOfIdsFile('konachan.json')).toBeUndefined();
  });
});

describe('prefs and bookmark colour', () => {
  it('stores only what differs from the defaults', () => {
    expect(parseBoardPrefs(undefined)).toEqual({});
    // `enabled` was the old on/off switch (board marking is always on now); old stored values are dropped.
    expect(parseBoardPrefs({ enabled: true, paused: false })).toEqual({});
    // `side` was the dock's position (the dock is gone); old stored values are dropped.
    expect(parseBoardPrefs({ paused: true, side: 'right', junk: 1 })).toEqual({ paused: true });
  });

  it("recognises pixiv's heart pink, not white, grey or black", () => {
    expect(pinkish('#ff4060')).toBe(true);
    expect(pinkish('rgb(255, 64, 96)')).toBe(true);
    expect(pinkish('rgba(255, 64, 96, 0)')).toBe(false);
    expect(pinkish('#fff')).toBe(false);
    expect(pinkish('rgb(133, 133, 133)')).toBe(false);
    expect(pinkish('#000000')).toBe(false);
    expect(pinkish(null)).toBe(false);
  });
});
