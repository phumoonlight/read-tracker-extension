import { useEffect, useState, type FormEvent } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { FolderSelect } from '@/components/RecordForm';
import { HoldButton } from '@/components/HoldButton';
import { matchedEntry } from '@/lib/match';
import { createRecord, formatDateTime, hasSeries } from '@/lib/records';
import { findRecordForUrl, listFolders, markReadNow, putRecord, statusChange, updateRecord } from '@/lib/storage';
import { getActiveTab } from '@/lib/tab';
import type { Folder, ReadingRecord } from '@/lib/types';
import { displayUrl, normalizeUrl } from '@/lib/url';

type ActiveTab = Browser.tabs.Tab & { id: number; url: string };

type State =
  | { kind: 'loading' }
  | { kind: 'untrackable' }
  | { kind: 'ready'; tab: ActiveTab; record?: ReadingRecord; folders: Folder[] };

const openList = (hash = '') => {
  void browser.tabs.create({ url: browser.runtime.getURL(`/options.html${hash}`) });
  window.close();
};

/**
 * The toolbar popup, kept short: add the current page (title + folder), or for a page
 * already in the list, change its read state and folder. Images, extra URLs, tags and
 * notes are managed on the full list page ("Manage").
 */
export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    (async () => {
      const tab = await getActiveTab();
      const key = tab?.url ? normalizeUrl(tab.url) : null;
      if (!tab?.id || !tab.url || !key) {
        setState({ kind: 'untrackable' });
        return;
      }
      const [record, folders] = await Promise.all([findRecordForUrl(key), listFolders()]);
      setState({ kind: 'ready', tab: tab as ActiveTab, record, folders });
    })();
  }, []);

  return (
    <main className="popup">
      <header className="popup-header">
        <h1>Read Tracker</h1>
        <button type="button" className="btn btn-small" onClick={() => openList()}>
          Open full list
        </button>
      </header>
      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'untrackable' && <p className="muted">This page can't be tracked (only http and https pages).</p>}
      {state.kind === 'ready' &&
        (state.record ? (
          <CurrentRecord
            tab={state.tab}
            record={state.record}
            folders={state.folders}
            onChange={(record) => setState({ ...state, record })}
          />
        ) : (
          <AddPage tab={state.tab} folders={state.folders} onAdded={(record) => setState({ ...state, record })} />
        ))}
    </main>
  );
}

/** Add the current page: title and folder only. It starts unread. */
function AddPage({ tab, folders, onAdded }: { tab: ActiveTab; folders: Folder[]; onAdded: (r: ReadingRecord) => void }) {
  const [title, setTitle] = useState(tab.title ?? '');
  const [folderId, setFolderId] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const created = createRecord({
        title,
        url: tab.url,
        matchMode: 'exact',
        status: 'unread',
        ...(folders.some((f) => f.id === folderId) ? { folderId } : {}),
      });
      if ('error' in created) throw new Error(created.error);
      await putRecord(created);
      onAdded(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="popup-body" onSubmit={add}>
      <h2 className="popup-section-title">Add this page</h2>
      <input type="text" value={title} aria-label="Title" placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
      {folders.length > 0 && <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />}
      <span className="muted popup-url" title={tab.url}>
        {displayUrl(tab.url)}
      </span>
      {error && <span className="error">{error}</span>}
      <button type="submit" className="btn btn-primary popup-main-action" disabled={saving}>
        Add to list
      </button>
    </form>
  );
}

/** A page already in the list: its read state (one button), folder, and a link to manage it. */
function CurrentRecord({
  tab,
  record,
  folders,
  onChange,
}: {
  tab: ActiveTab;
  record: ReadingRecord;
  folders: Folder[];
  onChange: (r: ReadingRecord) => void;
}) {
  // Which of the record's URLs this page matched (a record can have several).
  const tabKey = normalizeUrl(tab.url);
  const viaPrefix = (tabKey ? matchedEntry(record, tabKey) : undefined)?.matchMode === 'prefix';
  // The record's folder decides how it is read (Status or Revisit); Home is always Status.
  const revisit = !!record.folderId && folders.find((f) => f.id === record.folderId)?.readMode === 'revisit';

  async function setFolder(folderId: string) {
    const next = await updateRecord(record.id, (r) =>
      (r.folderId ?? '') === folderId ? {} : { folderId: folderId || undefined },
    );
    if (next) onChange(next);
  }

  async function toggleRead() {
    const status = record.status === 'unread' ? 'read' : 'unread';
    const next = await updateRecord(record.id, (r) => ({
      ...statusChange(r, status),
      // Marking a series unread from this page counts as visiting it.
      ...(viaPrefix && status === 'unread' ? { lastReadUrl: tab.url } : {}),
    }));
    if (next) onChange(next);
  }

  const continueUrl = hasSeries(record) && record.lastReadUrl !== tab.url ? record.lastReadUrl : undefined;

  return (
    <div className="popup-body">
      <div>
        <div className="current-title">{record.title}</div>
        <div className="current-meta">
          {revisit
            ? record.readAt
              ? `Last read ${formatDateTime(record.readAt)}`
              : 'Not read yet'
            : record.status === 'read'
              ? `Read${record.readAt ? ` ${new Date(record.readAt).toLocaleDateString()}` : ''}`
              : 'Unread'}
        </div>
      </div>

      {revisit ? (
        <HoldButton
          className="btn btn-primary popup-main-action"
          title="Press and hold to record that you read it now"
          onConfirm={async () => {
            const next = await markReadNow(record.id);
            if (next) onChange(next);
          }}
        >
          Update read
        </HoldButton>
      ) : (
        <button
          type="button"
          className={`btn popup-main-action${record.status === 'unread' ? ' btn-primary' : ''}`}
          onClick={toggleRead}
        >
          {record.status === 'unread' ? 'Mark read' : 'Mark unread'}
        </button>
      )}

      {folders.length > 0 && <FolderSelect folders={folders} value={record.folderId ?? ''} onChange={setFolder} />}

      {continueUrl && (
        <a
          className="popup-url"
          href={continueUrl}
          title={continueUrl}
          onClick={(e) => {
            e.preventDefault();
            void browser.tabs.update(tab.id, { url: continueUrl });
            window.close();
          }}
        >
          Continue: {displayUrl(continueUrl)}
        </a>
      )}

      <button type="button" className="link-button" onClick={() => openList(`#edit=${record.id}`)}>
        Manage in full list →
      </button>
    </div>
  );
}
