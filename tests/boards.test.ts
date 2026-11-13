import { describe, expect, it } from 'vitest';
import { buildManifest, parseManifest } from '@/lib/backup';
import {
  BITMAP_BYTES,
  BOARD_FILE_FORMAT,
  BOARD_MARK_MESSAGE,
  BOARD_ORIGINS,
  BOARD_PAGE_MESSAGE,
  BOARD_QUERY_MESSAGE,
  boardByKey,
  boardPostCount,
  boardPostOf,
  BUCKET_SIZE,
  buildBoardFile,
  groupByBucket,
  isBoardMark,
  isBoardPageRequest,
  isBoardQuery,
  isEmptyBoardReads,
  packRow,
  parseBoardFile,
  parseBoardPrefs,
  pinkish,
  postIdOn,
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

describe('Booru explorer files', () => {
  const file = (o: object) => JSON.stringify({ format: BOARD_FILE_FORMAT, version: 1, exported: '2026-01-02T00:00:00.000Z', ...o });

  it('reads an export: ids deduplicated and sorted, floors kept', () => {
    const issues: string[] = [];
    const f = parseBoardFile(file({ sites: { pixiv: [5, 1, 5], gelbooru: [] }, floors: { konachan: 100 } }), issues);
    expect(f.sites).toEqual({ pixiv: [1, 5] });
    expect(f.floors).toEqual({ konachan: 100 });
    expect(f.exported).toBe('2026-01-02T00:00:00.000Z');
    expect(issues).toEqual([]);
    expect(boardPostCount(f)).toBe(2);
  });

  it('reports unknown boards and invalid ids', () => {
    const issues: string[] = [];
    const f = parseBoardFile(
      file({ sites: { yandere: [1], konachan: [1, -2, 'x', 3] }, floors: { yandere: 5, pixiv: 0 } }),
      issues,
    );
    expect(f.sites).toEqual({ konachan: [1, 3] });
    expect(f.floors).toEqual({});
    expect(issues).toHaveLength(3);
  });

  it('rejects other files', () => {
    expect(() => parseBoardFile('{')).toThrow(/JSON/);
    expect(() => parseBoardFile(JSON.stringify({ format: 'read-tracker-backup' }))).toThrow(/Booru explorer/);
    expect(() => parseBoardFile(file({ version: 2, sites: {} }))).toThrow(/newer/);
  });

  it('round-trips what it writes', () => {
    const reads = { sites: { pixiv: [1, 2] }, floors: { gelbooru: 9 } };
    const written = buildBoardFile(reads, new Date(0));
    expect(parseBoardFile(JSON.stringify(written))).toEqual(written);
    expect(isEmptyBoardReads(reads)).toBe(false);
    expect(isEmptyBoardReads({ sites: {}, floors: {} })).toBe(true);
  });

  it('carries the board post count in the backup manifest', () => {
    const m = buildManifest({ records: 1, images: 0, boardPosts: 7 }, [], undefined, 1);
    expect(parseManifest(JSON.stringify(m)).counts).toEqual({ records: 1, folders: 0, images: 0, boardPosts: 7 });
    const old = { ...buildManifest({ records: 1, images: 0 }, [], undefined, 1), layout: 1 };
    expect(parseManifest(JSON.stringify(old)).counts.boardPosts).toBeUndefined();
  });
});

describe('prefs and bookmark colour', () => {
  it('stores only what differs from the defaults', () => {
    expect(parseBoardPrefs(undefined)).toEqual({});
    expect(parseBoardPrefs({ enabled: true, paused: false })).toEqual({ enabled: true });
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
