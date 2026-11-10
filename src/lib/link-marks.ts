import type { Folder, HomeSettings, ReadingRecord } from './types';

/**
 * Link marking: on websites, links to records in a place (Home or a folder) with
 * `markLinks` on are dimmed and glow (unread more dimmed than read). In a Revisit place every record
 * counts as read.
 */
export type LinkMark = 'unread' | 'read';

/** Attribute the content script sets on marked links (its value is the LinkMark). */
export const LINK_MARK_ATTR = 'data-read-tracker';

/** Pages the content script runs on, and the optional host permission it needs. */
export const LINK_MARK_ORIGINS = ['http://*/*', 'https://*/*'];

/** Message type: content script asks the background for the marks of some link URLs. */
export const LINK_MARKS_MESSAGE = 'read-tracker:link-marks';

/** Most URLs per message (the content script sends larger pages in chunks). */
export const LINK_MARKS_BATCH = 500;

export interface LinkMarksRequest {
  type: typeof LINK_MARKS_MESSAGE;
  urls: string[];
}

export function isLinkMarksRequest(m: unknown): m is LinkMarksRequest {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return o.type === LINK_MARKS_MESSAGE && Array.isArray(o.urls) && o.urls.every((u) => typeof u === 'string');
}

/**
 * How a link to `record` is marked, given its place: its Folder, or Home's settings
 * (undefined = none stored). Home has no read mode (always Status).
 */
export function linkMark(record: ReadingRecord, place: Folder | HomeSettings | undefined): LinkMark | null {
  if (!place?.markLinks) return null;
  if ('readMode' in place && place.readMode === 'revisit') return 'read';
  return record.status;
}

/** True when any place has link marking on (the content script is only registered then). */
export function marksLinks(folders: readonly Folder[], home: HomeSettings | undefined): boolean {
  return !!home?.markLinks || folders.some((f) => f.markLinks);
}
