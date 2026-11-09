import { useEffect, useState, type FormEvent } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { HoldButton } from '@/components/HoldButton';
import { matchedEntry } from '@/lib/match';
import { createRecord, formatAgo, formatDateTime, hasSeries } from '@/lib/records';
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
 * already in the list, change its read state. Images, extra URLs, tags and
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
        <button
          type="button"
          className="popup-icon-btn"
          onClick={() => openList()}
          title="Open full list"
          aria-label="Open full list"
        >
          {/* List icon */}
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path
              d="M7 5h10M7 10h10M7 15h10M3 5h.01M3 10h.01M3 15h.01"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      {state.kind === 'loading' && <p className="muted popup-body">Loading…</p>}
      {state.kind === 'untrackable' && (
        <p className="muted popup-body">This page can't be tracked (only http and https pages).</p>
      )}
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
    <form onSubmit={add}>
      <div className="popup-body">
        <h2 className="popup-section-title">Add this page</h2>
        <input type="text" value={title} aria-label="Title" placeholder="Title" onChange={(e) => setTitle(e.target.value)} />
        {folders.length > 0 && <FolderChips folders={folders} value={folderId} onChange={setFolderId} />}
        <span className="muted popup-url" title={tab.url}>
          {displayUrl(tab.url)}
        </span>
        {error && <span className="error">{error}</span>}
      </div>
      <div className="popup-footer">
        <button type="submit" className="btn btn-primary popup-main-action" disabled={saving}>
          Add to list
        </button>
      </div>
    </form>
  );
}

/** A page already in the list: its read state (one button) and a link to manage it (folder etc. live there). */
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
    <>
      <div className="popup-body">
        <div>
          <div className="current-title">{record.title}</div>
          {/* Relative time ("10 min ago"); the exact date and time are in the tooltip. */}
          <div className="current-meta" title={record.readAt ? formatDateTime(record.readAt) : undefined}>
            {revisit
              ? record.readAt
                ? `Last read ${formatAgo(record.readAt)}`
                : 'Not read yet'
              : record.status === 'read'
                ? record.readAt
                  ? `Read ${formatAgo(record.readAt)}`
                  : 'Read'
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
      </div>
      <div className="popup-footer">
        <button type="button" className="link-button" onClick={() => openList(`#edit=${record.id}`)}>
          Manage
        </button>
      </div>
    </>
  );
}

/** Folder choice as chips (Home first); no dropdown, so nothing has to fit inside the popup. */
function FolderChips({
  folders,
  value,
  onChange,
}: {
  folders: Folder[];
  /** '' = Home. */
  value: string;
  onChange: (folderId: string) => void;
}) {
  // A folder that no longer exists counts as Home.
  const current = folders.some((f) => f.id === value) ? value : '';
  const chip = (id: string, name: string) => (
    <button key={id || 'home'} type="button" className="folder-chip" aria-pressed={current === id} onClick={() => onChange(id)}>
      {name}
    </button>
  );
  return (
    <div className="field">
      <span>Folder</span>
      <div className="popup-folder-chips" role="group" aria-label="Folder">
        {chip('', 'Home')}
        {folders.map((f) => chip(f.id, f.name))}
      </div>
    </div>
  );
}
