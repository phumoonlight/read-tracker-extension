import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { findMatch } from '@/lib/match';
import { getAllRecords, onRecordsChanged, updateRecord } from '@/lib/storage';
import { normalizeUrl } from '@/lib/url';
import type { ReadingRecord } from '@/lib/types';

const BADGE: Record<ReadingRecord['status'], { text: string; color: string }> = {
  read: { text: '✓', color: '#1a7f37' },
  reading: { text: '•', color: '#bf6a02' },
  unread: { text: '•', color: '#0969da' },
};

export default defineBackground(() => {
  // Records are cached in memory and reloaded on any storage change. The worker
  // may be shut down at any time; the cache is just rebuilt on the next event.
  let cache: Promise<ReadingRecord[]> | undefined;
  const records = () => (cache ??= getAllRecords());

  async function refreshTab(tabId: number, url: string | undefined, visited = false) {
    const key = url ? normalizeUrl(url) : null;
    const match = key ? findMatch(await records(), key) : undefined;

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
    if (visited && url && match?.matchMode === 'prefix' && match.status === 'reading' && match.lastReadUrl !== url) {
      await updateRecord(match.id, (r) => (r.status === 'reading' ? { lastReadUrl: url } : {}));
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

  onRecordsChanged(() => {
    cache = undefined;
    void refreshAllTabs();
  });

  browser.runtime.onInstalled.addListener(() => void refreshAllTabs());
  browser.runtime.onStartup.addListener(() => void refreshAllTabs());
});
