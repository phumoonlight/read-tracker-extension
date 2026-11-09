import { normalizeUrl } from './url';
import type { MatchMode, ReadingRecord, ReadStatus, UrlEntry } from './types';

export interface NewRecordInput {
  title: string;
  url: string;
  matchMode: MatchMode;
  /** Prefix records: the series root as entered (any URL form); normalized here. Ignored for exact. */
  prefix?: string;
  status?: ReadStatus;
  tags?: string[];
  notes?: string;
  /** Omit for Home (no folder, the default). */
  folderId?: string;
  /** Extra URLs (already validated, with match keys). */
  otherUrls?: UrlEntry[];
}

/** True for absolute http(s) URLs: the only kind a record may link to. */
export const isHttpUrl = (url: unknown): url is string => typeof url === 'string' && normalizeUrl(url) !== null;

/**
 * Normalized match key for a record's URL / prefix, or an error message.
 * The URL itself must always be an absolute http(s) URL (it is used as a link);
 * the prefix field may omit the scheme ("site.com/novel/abc").
 */
export function computeMatchKey(url: string, matchMode: MatchMode, prefix?: string): string | { error: string } {
  const urlKey = normalizeUrl(url);
  if (!urlKey) return { error: 'URL must start with http:// or https://.' };
  if (matchMode === 'exact') return urlKey;

  const source = prefix?.trim() || url;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
  const key = normalizeUrl(source) ?? (hasScheme ? null : normalizeUrl(`https://${source}`));
  return key ?? { error: 'Series prefix is not a valid http(s) URL.' };
}

export function createRecord(input: NewRecordInput): ReadingRecord | { error: string } {
  const matchKey = computeMatchKey(input.url, input.matchMode, input.prefix);
  if (typeof matchKey !== 'string') return matchKey;
  const now = Date.now();
  const status = input.status ?? 'unread';
  return {
    id: crypto.randomUUID(),
    title: input.title.trim() || input.url,
    url: input.url.trim(),
    matchKey,
    matchMode: input.matchMode,
    status,
    tags: normalizeTags(input.tags ?? []),
    notes: input.notes?.trim() || undefined,
    ...(input.folderId ? { folderId: input.folderId } : {}),
    ...(input.otherUrls?.length ? { otherUrls: input.otherUrls } : {}),
    images: [],
    createdAt: now,
    updatedAt: now,
    readAt: status === 'read' ? now : undefined,
  };
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

export const parseTags = (text: string) => normalizeTags(text.split(','));

/** Every URL of a record, main one first. */
export function urlEntries(r: Pick<ReadingRecord, 'url' | 'matchMode' | 'matchKey' | 'otherUrls'>): UrlEntry[] {
  return [{ url: r.url, matchMode: r.matchMode, matchKey: r.matchKey }, ...(r.otherUrls ?? [])];
}

/** True if any of the record's URLs is a series prefix. */
export const hasSeries = (r: ReadingRecord) => urlEntries(r).some((e) => e.matchMode === 'prefix');

/** The URL to open for a record: the last chapter for an in-progress series, else the main URL. */
export const openUrl = (r: ReadingRecord) => (hasSeries(r) && r.lastReadUrl) || r.url;

/** "Nov 9, 2026, 2:03 PM" in the user's locale: for last-read times. */
export const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * How long ago a time was, in whole units: "just now", "10 min ago", "1 hour ago",
 * "3 days ago", "2 months ago", "1 year ago". Future times (clock changes) count as "just now".
 */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.floor((now - ms) / 1000);
  if (s < 60) return 'just now';
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return `${Math.floor(s / 60)} min ago`;
}
