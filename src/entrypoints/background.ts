import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
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

    const badge = match ? BADGE[match.status] : { text: '', color: '#000000' };
    await Promise.all([
      browser.action.setBadgeText({ tabId, text: badge.text }),
      browser.action.setBadgeBackgroundColor({ tabId, color: badge.color }),
      browser.action.setTitle({
        tabId,
        title: match ? `Read Tracker: ${match.status} - ${match.title}` : 'Read Tracker',
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

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || !isLinkMarksRequest(msg)) return;
    linkMarks(msg.urls).then(sendResponse, () => sendResponse(null));
    return true; // answered asynchronously
  });

  browser.permissions.onAdded.addListener(queueLinkSync);
  browser.permissions.onRemoved.addListener(queueLinkSync);

  onRecordsChanged(() => {
    void refreshAllTabs();
    queueLinkSync();
  });

  browser.runtime.onInstalled.addListener(() => {
    void refreshAllTabs();
    queueLinkSync();
  });
  browser.runtime.onStartup.addListener(() => {
    void refreshAllTabs();
    queueLinkSync();
  });
});
