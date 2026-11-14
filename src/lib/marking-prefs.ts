import { browser } from 'wxt/browser';
import { MARKING_PREFS_KEY, OLD_BOARD_PREFS_KEY, parseMarkingPrefs, type MarkingPrefs } from './link-marks';

/**
 * The global marking switch (popup header) in chrome.storage.local: no IndexedDB, so the
 * content scripts can use it, and storage.onChanged tells every tab and the background at once.
 * Paused = no link marks on websites and no board marks (nothing faded or recorded on boards).
 */

export async function getMarkingPrefs(): Promise<MarkingPrefs> {
  const got = await browser.storage.local.get([MARKING_PREFS_KEY, OLD_BOARD_PREFS_KEY]);
  // Builds up to 0.1.22 kept a board-only pause under the old key.
  return parseMarkingPrefs(got[MARKING_PREFS_KEY] ?? got[OLD_BOARD_PREFS_KEY]);
}

/** Merge a patch; `false` is stored as absent. Drops the old board-only key. */
export async function updateMarkingPrefs(patch: { paused?: boolean }) {
  const cur = await getMarkingPrefs();
  const next = parseMarkingPrefs({ paused: patch.paused ?? cur.paused });
  await browser.storage.local.set({ [MARKING_PREFS_KEY]: next });
  await browser.storage.local.remove(OLD_BOARD_PREFS_KEY);
}

/** Calls `fn` with the new prefs whenever they change (in any context). Returns an unsubscribe function. */
export function onMarkingPrefsChanged(fn: (prefs: MarkingPrefs) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && MARKING_PREFS_KEY in changes) fn(parseMarkingPrefs(changes[MARKING_PREFS_KEY].newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
