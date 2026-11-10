import { browser } from 'wxt/browser';

/**
 * The change signal. Every write in storage.ts bumps this key in chrome.storage.local:
 * IndexedDB has no change events, but storage.onChanged reaches every extension context
 * (content scripts too) and wakes the background worker.
 *
 * Kept apart from storage.ts so the content script can listen without bundling the
 * IndexedDB layer.
 */
export const REVISION_KEY = 'recordsRevision';

/** Calls `fn` whenever any record is added, changed or removed (in any context). Returns an unsubscribe function. */
export function onRecordsChanged(fn: () => void): () => void {
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && REVISION_KEY in changes) fn();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
