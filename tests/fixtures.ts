import type { ReadingRecord } from '@/lib/types';

let n = 0;

export function rec(overrides: Partial<ReadingRecord> = {}): ReadingRecord {
  n++;
  return {
    id: `id-${n}`,
    title: `Record ${n}`,
    url: `https://example.com/${n}`,
    matchKey: `example.com/${n}`,
    matchMode: 'exact',
    status: 'unread',
    tags: [],
    hasThumbnail: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}
