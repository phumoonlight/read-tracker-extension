import { useEffect, useState, type FormEvent } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { HoldButton } from '@/components/HoldButton';
import { boardForHost } from '@/lib/boards';
import { folderForUrl } from '@/lib/domains';
import { matchedEntry } from '@/lib/match';
import { createRecord, formatAgo, formatDateTime, hasSeries } from '@/lib/records';
import { findRecordForUrl, listFolders, markReadNow, putRecord, setFavorite, statusChange, updateRecord } from '@/lib/storage';
import type { MarkingPrefs } from '@/lib/link-marks';
import { getMarkingPrefs, onMarkingPrefsChanged, updateMarkingPrefs } from '@/lib/marking-prefs';
import { getActiveTab } from '@/lib/tab';
import type { Folder, ReadingRecord } from '@/lib/types';
import { displayUrl, normalizeUrl } from '@/lib/url';
import { BoardPanel } from './BoardPanel';

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
        <DimSwitch />
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
      {state.kind === 'ready' && <BoardSection tab={state.tab} />}
      {state.kind === 'ready' &&
        (state.record ? (
          <CurrentRecord
            tab={state.tab}
            record={state.record}
            folders={state.folders}
            onChange={(record) => setState({ ...state, record })}
          />
        ) : (
          <AddPage
            tab={state.tab}
            folders={state.folders}
            // On a board the Booru card is the main thing: adding a record is folded away.
            collapsed={!!boardForHost(new URL(state.tab.url).hostname)}
            onAdded={(record) => setState({ ...state, record })}
          />
        ))}
    </main>
  );
}

/**
 * The global dimming switch (header): off = marked links and read board posts aren't dimmed
 * on websites. Marking itself (records, board posts, the badge) keeps working either way.
 */
function DimSwitch() {
  const [prefs, setPrefs] = useState<MarkingPrefs>();
  useEffect(() => {
    void getMarkingPrefs().then(setPrefs);
    return onMarkingPrefsChanged(setPrefs);
  }, []);
  if (!prefs) return <span className="dim-switch" />;
  const on = !prefs.paused;
  return (
    <label
      className="dim-switch"
      title={on ? 'Marked links and read posts are dimmed on websites' : 'Nothing is dimmed on websites (marking still works)'}
    >
      <input type="checkbox" role="switch" checked={on} onChange={() => void updateMarkingPrefs({ paused: on })} />
      <span className="dim-switch-track" aria-hidden="true" />
      Dim {on ? 'on' : 'off'}
    </label>
  );
}

/** Board marking controls on top, when the tab is on an image board (see BoardPanel). */
function BoardSection({ tab }: { tab: ActiveTab }) {
  const board = boardForHost(new URL(tab.url).hostname);
  return board ? <BoardPanel board={board} tabId={tab.id} url={tab.url} /> : null;
}

/** Add the current page: title and folder only. It starts unread. */
function AddPage({
  tab,
  folders,
  collapsed = false,
  onAdded,
}: {
  tab: ActiveTab;
  folders: Folder[];
  /** Start folded (on board sites); the title row expands it. */
  collapsed?: boolean;
  onAdded: (r: ReadingRecord) => void;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [title, setTitle] = useState(tab.title ?? '');
  // Preselect the folder whose preferred domains cover this page; otherwise Home.
  const [folderId, setFolderId] = useState(() => folderForUrl(folders, tab.url)?.id ?? '');
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

  const heading = 'Record this page';
  if (!open) {
    return (
      <div className="popup-body">
        <button type="button" className="popup-expand" aria-expanded={false} onClick={() => setOpen(true)}>
          <span className="popup-expand-chevron" aria-hidden="true">
            ▸
          </span>
          {heading}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={add}>
      <div className="popup-body">
        {collapsed ? (
          <button type="button" className="popup-expand" aria-expanded={true} onClick={() => setOpen(false)}>
            <span className="popup-expand-chevron is-open" aria-hidden="true">
              ▸
            </span>
            {heading}
          </button>
        ) : (
          <h2 className="popup-section-title">{heading}</h2>
        )}
        {/* A textarea so a long title shows whole (it grows with the text); still one line of text:
            Enter adds the page, pasted line breaks become spaces. */}
        <textarea
          className="popup-title-input"
          rows={1}
          autoFocus={collapsed}
          value={title}
          aria-label="Title"
          placeholder="Title"
          onChange={(e) => setTitle(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {folders.length > 0 && <FolderChips folders={folders} value={folderId} onChange={setFolderId} />}
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
        <div className="popup-record-info">
          <div className="current-title-row">
            <div className="current-title">{record.title}</div>
            <button
              type="button"
              className="btn btn-small btn-ghost fav-toggle"
              aria-pressed={!!record.favorite}
              aria-label={record.favorite ? 'Remove from favorites' : 'Add to favorites'}
              title={record.favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={async () => {
                const next = await setFavorite(record.id, !record.favorite);
                if (next) onChange(next);
              }}
            >
              <span className="fav-star" aria-hidden="true">⭐</span>
            </button>
          </div>
          {/* Relative time ("10 min ago"); the exact date and time are in the tooltip. */}
          <div
            className="current-meta"
            title={formatDateTime(record.status === 'read' || revisit ? (record.readAt ?? record.createdAt) : record.createdAt)}
          >
            {revisit
              ? record.readAt
                ? `Last read ${formatAgo(record.readAt)}`
                : 'Not read yet'
              : record.status === 'read'
                ? record.readAt
                  ? `Read ${formatAgo(record.readAt)}`
                  : 'Read'
                : `Unread · added ${formatAgo(record.createdAt)}`}
          </div>
          {record.tags.length > 0 && (
            <div className="popup-tags">
              {record.tags.map((t) => (
                <span key={t}>#{t}</span>
              ))}
            </div>
          )}
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
