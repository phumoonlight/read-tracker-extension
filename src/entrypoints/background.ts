import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { matchedEntry } from '@/lib/match';
import { findRecordForUrl, onRecordsChanged, updateRecord } from '@/lib/storage';
import { normalizeUrl } from '@/lib/url';
import type { ReadingRecord } from '@/lib/types';

const BADGE: Record<ReadingRecord['status'], { text: string; color: string }> = {
  read: { text: '✓', color: '#1a7f37' },
  reading: { text: '•', color: '#bf6a02' },
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

    // Series progress: remember the latest chapter visited while reading.
    // (The record may have several URLs: what counts is that this page matched one of its series prefixes.)
    if (
      visited &&
      url &&
      key &&
      match &&
      matchedEntry(match, key)?.matchMode === 'prefix' &&
      match.status === 'reading' &&
      match.lastReadUrl !== url
    ) {
      await updateRecord(match.id, (r) =>
        r.status === 'reading' && r.lastReadUrl !== url ? { lastReadUrl: url } : {},
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

  onRecordsChanged(() => void refreshAllTabs());

  browser.runtime.onInstalled.addListener(() => void refreshAllTabs());
  browser.runtime.onStartup.addListener(() => void refreshAllTabs());
});
