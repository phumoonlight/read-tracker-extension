import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { getBoardPrefs, onBoardPrefsChanged } from '@/lib/board-prefs';
import { markBoardReads, onBoardsChanged, queryBoardReads } from '@/lib/board-store';
import { BOARD_ORIGINS, boardPostOf, isBoardMark, isBoardQuery } from '@/lib/boards';
import { isLinkMarksRequest, LINK_MARK_ORIGINS, marksLinks } from '@/lib/link-marks';
import { matchedEntry } from '@/lib/match';
import {
  findRecordForUrl,
  getHomeSettings,
  linkMarks,
  listFolders,
  onRecordsChanged,
  updateRecord,
} from '@/lib/storage';
import { normalizeUrl } from '@/lib/url';
import type { ReadingRecord } from '@/lib/types';

/** Id of the runtime-registered link marking script, and its built file (entrypoints/link-marks.content.ts). */
const LINK_SCRIPT_ID = 'link-marks';
const LINK_SCRIPT_FILE = '/content-scripts/link-marks.js';
/** Id of the runtime-registered board marking script, and its built file (entrypoints/board-marks.content.ts). */
const BOARD_SCRIPT_ID = 'board-marks';
const BOARD_SCRIPT_FILE = '/content-scripts/board-marks.js';

const BADGE: Record<ReadingRecord['status'], { text: string; color: string }> = {
  read: { text: '✓', color: '#1a7f37' },
  unread: { text: '•', color: '#0969da' },
};

export default defineBackground(() => {
  // No in-memory copy of the list: each tab event does a few matchKey index
  // lookups in IndexedDB (see findRecordForUrl), which stays cheap at any list size.
  async function refreshTab(tabId: number, url: string | undefined, visited = false) {
    const key = url ? normalizeUrl(url) : null;
    const match = key ? await findRecordForUrl(key) : undefined;
    // No record: a board post page shows its board read state (while board marking is on).
    const post = !match && url ? await boardPostState(url) : undefined;

    const status = match?.status ?? post?.status;
    const badge = status ? BADGE[status] : { text: '', color: '#000000' };
    await Promise.all([
      browser.action.setBadgeText({ tabId, text: badge.text }),
      browser.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
      browser.action.setTitle({
        tabId,
        title: match
          ? `Read Tracker: ${match.status} - ${match.title}`
          : post
            ? `Read Tracker: ${post.label} post ${post.id} - ${post.status}`
            : 'Read Tracker',
      }),
    ]).catch(() => {
      // Tab closed between the event and the update.
    });

    // Series progress: remember the latest chapter visited while the record isn't read yet.
    // (The record may have several URLs: what counts is that this page matched one of its series prefixes.)
    if (
      visited &&
      url &&
      key &&
      match &&
      matchedEntry(match, key)?.matchMode === 'prefix' &&
      match.status !== 'read' &&
      match.lastReadUrl !== url
    ) {
      await updateRecord(match.id, (r) =>
        r.status !== 'read' && r.lastReadUrl !== url ? { lastReadUrl: url } : {},
      );
    }
  }

  async function boardPostState(url: string) {
    const post = boardPostOf(url);
    if (!post || !(await getBoardPrefs()).enabled) return undefined;
    const { read } = await queryBoardReads(post.board.key, [post.id]).catch(() => ({ read: [] as number[] }));
    const status: ReadingRecord['status'] = read.length ? 'read' : 'unread';
    return { label: post.board.label, id: post.id, status };
  }

  async function refreshAllTabs() {
    const tabs = await browser.tabs.query({});
    await Promise.all(tabs.map((t) => t.id !== undefined && refreshTab(t.id, t.url)));
  }

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Fire on URL changes (including SPA navigations) and on load completion.
    if (changeInfo.url || changeInfo.status === 'complete') {
      void refreshTab(tabId, tab.url, changeInfo.status === 'complete');
    }
  });

  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    if (tab) void refreshTab(tabId, tab.url);
  });

  // ---------------------------------------------------------------------------
  // Link marking: the content script is registered only while some place marks links
  // and the host permission is granted, so no page gets a script otherwise.

  async function syncLinkScript() {
    const [folders, home, granted] = await Promise.all([
      listFolders(),
      getHomeSettings(),
      browser.permissions.contains({ origins: LINK_MARK_ORIGINS }),
    ]);
    const wanted = granted && marksLinks(folders, home);
    const registered = (await browser.scripting.getRegisteredContentScripts({ ids: [LINK_SCRIPT_ID] })).length > 0;
    if (wanted && !registered) {
      await browser.scripting.registerContentScripts([
        { id: LINK_SCRIPT_ID, js: [LINK_SCRIPT_FILE.slice(1)], matches: LINK_MARK_ORIGINS, runAt: 'document_idle' },
      ]);
      // Pages already open get it now too (the script runs once per page).
      const tabs = await browser.tabs.query({ url: LINK_MARK_ORIGINS });
      await Promise.all(
        tabs.map((t) =>
          t.id === undefined
            ? undefined
            : browser.scripting.executeScript({ target: { tabId: t.id }, files: [LINK_SCRIPT_FILE] }).catch(() => {
                // Pages scripts can't run in (e.g. the Web Store) or that closed meanwhile.
              }),
        ),
      );
    } else if (!wanted && registered) {
      // Copies already running in open pages stay, but get no marks back (see linkMarks).
      await browser.scripting.unregisterContentScripts({ ids: [LINK_SCRIPT_ID] });
    }
  }

  // One sync at a time (register twice with one id would fail).
  let linkSync = Promise.resolve();
  const queueLinkSync = () => {
    linkSync = linkSync.then(syncLinkScript).catch((e) => console.error('Link marking:', e));
  };

  // ---------------------------------------------------------------------------
  // Board marking: the board script is registered only while it is turned on (Boards page)
  // and the board host permission is granted.

  async function syncBoardScript() {
    const [prefs, granted] = await Promise.all([
      getBoardPrefs(),
      browser.permissions.contains({ origins: BOARD_ORIGINS }),
    ]);
    const wanted = !!prefs.enabled && granted;
    const registered = (await browser.scripting.getRegisteredContentScripts({ ids: [BOARD_SCRIPT_ID] })).length > 0;
    if (wanted && !registered) {
      await browser.scripting.registerContentScripts([
        { id: BOARD_SCRIPT_ID, js: [BOARD_SCRIPT_FILE.slice(1)], matches: BOARD_ORIGINS, runAt: 'document_start' },
      ]);
      const tabs = await browser.tabs.query({ url: BOARD_ORIGINS });
      await Promise.all(
        tabs.map((t) =>
          t.id === undefined
            ? undefined
            : browser.scripting.executeScript({ target: { tabId: t.id }, files: [BOARD_SCRIPT_FILE] }).catch(() => {}),
        ),
      );
    } else if (!wanted && registered) {
      // Copies already running in open pages stop (unfade, drop attributes) when prefs say off.
      await browser.scripting.unregisterContentScripts({ ids: [BOARD_SCRIPT_ID] });
    }
  }

  let boardSync = Promise.resolve();
  const queueBoardSync = () => {
    boardSync = boardSync.then(syncBoardScript).catch((e) => console.error('Board marking:', e));
  };

  const syncAll = () => {
    queueLinkSync();
    queueBoardSync();
  };

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return;
    if (isLinkMarksRequest(msg)) {
      linkMarks(msg.urls).then(sendResponse, () => sendResponse(null));
      return true; // answered asynchronously
    }
    if (isBoardQuery(msg)) {
      queryBoardReads(msg.site, msg.ids).then(sendResponse, () => sendResponse({ read: [] }));
      return true;
    }
    if (isBoardMark(msg)) {
      markBoardReads(msg.site, msg.ids, msg.read).then(
        (changed) => sendResponse({ changed }),
        () => sendResponse({ changed: 0 }),
      );
      return true;
    }
  });

  browser.permissions.onAdded.addListener(syncAll);
  browser.permissions.onRemoved.addListener(syncAll);

  onRecordsChanged(() => {
    void refreshAllTabs();
    queueLinkSync();
  });

  onBoardsChanged(() => void refreshAllTabs());
  onBoardPrefsChanged(() => {
    void refreshAllTabs();
    queueBoardSync();
  });

  browser.runtime.onInstalled.addListener(() => {
    void refreshAllTabs();
    syncAll();
  });
  browser.runtime.onStartup.addListener(() => {
    void refreshAllTabs();
    syncAll();
  });
});
