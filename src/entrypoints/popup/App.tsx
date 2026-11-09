import { useEffect, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import { FolderSelect, RecordForm, defaultPrefix } from '@/components/RecordForm';
import { StatusPicker } from '@/components/StatusPicker';
import { Thumbnail } from '@/components/Thumbnail';
import { ImagePicker } from '@/components/ImagePicker';
import { createRecord } from '@/lib/records';
import {
  findRecordForUrl,
  getHomeSettings,
  listFolders,
  markReadNow,
  putRecord,
  statusChange,
  updateRecord,
} from '@/lib/storage';
import { formatDateTime } from '@/lib/records';
import { getActiveTab } from '@/lib/tab';
import { STATUS_LABEL, type Folder, type HomeSettings, type ReadingRecord, type ReadStatus } from '@/lib/types';
import { normalizeUrl } from '@/lib/url';

type ActiveTab = Browser.tabs.Tab & { id: number; url: string };

type State =
  | { kind: 'loading' }
  | { kind: 'untrackable' }
  | { kind: 'ready'; tab: ActiveTab; record?: ReadingRecord; folders: Folder[]; home?: HomeSettings };

const viewHash = (recordId: string, index: number) => `#view=${encodeURIComponent(recordId)}&i=${index}`;

const openList = (hash = '') => {
  void browser.tabs.create({ url: browser.runtime.getURL(`/options.html${hash}`) });
  window.close();
};

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
      const [record, folders, home] = await Promise.all([findRecordForUrl(key), listFolders(), getHomeSettings()]);
      setState({ kind: 'ready', tab: tab as ActiveTab, record, folders, home });
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
      {state.kind === 'untrackable' && (
        <div className="banner">This page can't be tracked. Only http and https pages are supported.</div>
      )}
      {state.kind === 'ready' &&
        (state.record ? (
          <CurrentRecord
            tab={state.tab}
            record={state.record}
            folders={state.folders}
            home={state.home}
            onChange={(record) => setState({ ...state, record })}
          />
        ) : (
          <AddPage tab={state.tab} folders={state.folders} onAdded={(record) => setState({ ...state, record })} />
        ))}
    </main>
  );
}

function AddPage({
  tab,
  folders,
  onAdded,
}: {
  tab: ActiveTab;
  folders: Folder[];
  onAdded: (r: ReadingRecord) => void;
}) {
  return (
    <>
      <div className="banner">This page is not in your list.</div>
      <RecordForm
        compact
        folders={folders}
        submitLabel="Add current page"
        initial={{
          title: tab.title ?? '',
          url: tab.url,
          matchMode: 'exact',
          prefix: defaultPrefix(tab.url),
          status: 'unread',
          tags: '',
          notes: '',
          folderId: '',
        }}
        onSubmit={async (v) => {
          const created = createRecord({ ...v, prefix: v.matchKey });
          if ('error' in created) throw new Error(created.error);
          const record: ReadingRecord =
            created.matchMode === 'prefix' && created.status === 'reading' ? { ...created, lastReadUrl: tab.url } : created;
          await putRecord(record);
          onAdded(record);
        }}
      />
    </>
  );
}

function CurrentRecord({
  tab,
  record,
  folders,
  home,
  onChange,
}: {
  tab: ActiveTab;
  record: ReadingRecord;
  folders: Folder[];
  home: HomeSettings | undefined;
  onChange: (r: ReadingRecord) => void;
}) {
  // The record's place decides how it is read (Status or Revisit).
  const place = record.folderId ? folders.find((f) => f.id === record.folderId) : home;
  const revisit = place?.readMode === 'revisit';
  async function setFolder(folderId: string) {
    const next = await updateRecord(record.id, (r) =>
      (r.folderId ?? '') === folderId ? {} : { folderId: folderId || undefined },
    );
    if (next) onChange(next);
  }

  async function setStatus(status: ReadStatus) {
    const next = await updateRecord(record.id, (r) => ({
      ...statusChange(r, status),
      // Starting a series from this page counts as visiting it.
      ...(r.matchMode === 'prefix' && status === 'reading' ? { lastReadUrl: tab.url } : {}),
    }));
    if (next) onChange(next);
  }

  const continueUrl = record.matchMode === 'prefix' && record.lastReadUrl !== tab.url ? record.lastReadUrl : undefined;

  return (
    <>
      <div className="current" data-status={record.status}>
        <Thumbnail record={record} size="small" onOpen={(i) => openList(viewHash(record.id, i))} />
        <div>
          <div className="current-title">{record.title}</div>
          <div className="current-meta">
            <span className="status-dot" /> {STATUS_LABEL[record.status]}
            {record.matchMode === 'prefix' && <> · series</>}
          </div>
          {record.matchMode === 'prefix' && <div className="current-meta">Prefix: {record.matchKey}</div>}
        </div>
      </div>

      {revisit ? (
        <div className="field">
          <span>{record.readAt ? `Last read ${formatDateTime(record.readAt)}` : 'Not read yet'}</span>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                const next = await markReadNow(record.id);
                if (next) onChange(next);
              }}
            >
              Read now
            </button>
          </div>
        </div>
      ) : (
        <div className="field">
          <span>Status</span>
          <StatusPicker value={record.status} onChange={setStatus} />
        </div>
      )}

      {folders.length > 0 && <FolderSelect folders={folders} value={record.folderId ?? ''} onChange={setFolder} />}

      {continueUrl && (
        <div className="field">
          <span>Last chapter visited</span>
          <a
            href={continueUrl}
            onClick={(e) => {
              e.preventDefault();
              void browser.tabs.update(tab.id, { url: continueUrl });
              window.close();
            }}
          >
            {continueUrl}
          </a>
        </div>
      )}

      <ImagePicker
        record={record}
        tab={{ id: tab.id, windowId: tab.windowId }}
        onChange={onChange}
        // Full-size images don't fit the popup: view them on the list page.
        onView={(i) => openList(viewHash(record.id, i))}
      />

      <div className="row">
        <button type="button" className="btn" onClick={() => openList(`#edit=${record.id}`)}>
          Edit details
        </button>
      </div>
    </>
  );
}
