import { browser } from 'wxt/browser';
import { BOARD_PREFS_KEY, parseBoardPrefs, type BoardPrefs } from './boards';

/**
 * Board marking preferences in chrome.storage.local (no IndexedDB, so the content script
 * can use this; storage.onChanged tells every board tab and the background at once).
 */

export async function getBoardPrefs(): Promise<BoardPrefs> {
  const got = await browser.storage.local.get(BOARD_PREFS_KEY);
  return parseBoardPrefs(got[BOARD_PREFS_KEY]);
}

/** Merge a patch; `false` / 'left' are stored as absent. */
export async function updateBoardPrefs(patch: { enabled?: boolean; paused?: boolean; side?: 'left' | 'right' }) {
  const cur = await getBoardPrefs();
  const next = parseBoardPrefs({
    enabled: patch.enabled ?? cur.enabled,
    paused: patch.paused ?? cur.paused,
    side: patch.side ?? cur.side,
  });
  await browser.storage.local.set({ [BOARD_PREFS_KEY]: next });
}

/** Calls `fn` with the new prefs whenever they change (in any context). Returns an unsubscribe function. */
export function onBoardPrefsChanged(fn: (prefs: BoardPrefs) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && BOARD_PREFS_KEY in changes) fn(parseBoardPrefs(changes[BOARD_PREFS_KEY].newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
