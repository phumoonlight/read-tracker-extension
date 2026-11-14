import type { Folder, HomeSettings, ReadingRecord } from './types';

/**
 * Link marking: on websites, links to records in a place (Home or a folder) with
 * `markLinks` on are dimmed and blurred (read more than unread). In a Revisit place every record
 * counts as read.
 */
export type LinkMark = 'unread' | 'read';

/**
 * How a mark looks on a web page: dimmed and blurred, read the most. Shared by link marking
 * and board marking (a board post marked read looks like a read record). Hover / focus
 * shows it sharp again (MARK_SHOWN_CSS).
 */
export const MARK_LOOK: Record<LinkMark, { opacity: number; blur: number }> = {
  unread: { opacity: 0.5, blur: 1 },
  read: { opacity: 0.25, blur: 2 },
};
export const markCss = (mark: LinkMark) =>
  `opacity:${MARK_LOOK[mark].opacity}!important;filter:blur(${MARK_LOOK[mark].blur}px)!important`;
export const MARK_SHOWN_CSS = 'opacity:1!important;filter:none!important';
export const MARK_TRANSITION_CSS = 'transition:opacity .15s,filter .15s!important';

/**
 * The global marking switch (popup header): paused = no link marks on websites and no board
 * marks. Stored in chrome.storage.local (marking-prefs.ts) so content scripts can read it.
 */
export const MARKING_PREFS_KEY = 'markingPrefs';
/** Builds up to 0.1.22: a board-only pause. Read when MARKING_PREFS_KEY is absent, then removed. */
export const OLD_BOARD_PREFS_KEY = 'boardPrefs';

export interface MarkingPrefs {
  /** Marking switched off in the popup. Absent = on. */
  paused?: true;
}

/** Only `paused: true` is kept (older keys such as `enabled` / `side` are dropped). */
export function parseMarkingPrefs(v: unknown): MarkingPrefs {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return o.paused === true ? { paused: true } : {};
}

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
