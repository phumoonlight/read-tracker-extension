import { normalizeUrl } from './url';
import type { MatchMode, ReadingRecord, ReadStatus } from './types';

export interface NewRecordInput {
  title: string;
  url: string;
  matchMode: MatchMode;
  /** Prefix records: the series root as entered (any URL form); normalized here. Ignored for exact. */
  prefix?: string;
  status?: ReadStatus;
  tags?: string[];
  notes?: string;
  /** Omit for "no folder" (the default). */
  folderId?: string;
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
    hasThumbnail: false,
    createdAt: now,
    updatedAt: now,
    readAt: status === 'read' ? now : undefined,
  };
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

export const parseTags = (text: string) => normalizeTags(text.split(','));

/** The URL to open for a record: the last chapter for an in-progress series, else the entered URL. */
export const openUrl = (r: ReadingRecord) => (r.matchMode === 'prefix' && r.lastReadUrl) || r.url;
