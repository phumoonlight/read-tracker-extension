import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { RecordForm, defaultPrefix, type RecordFormResult } from '@/components/RecordForm';
import { Thumbnail } from '@/components/Thumbnail';
import { ThumbnailPicker } from '@/components/ThumbnailPicker';
import { exportToFile, importFromFile } from '@/lib/backup-io';
import { createRecord, openUrl } from '@/lib/records';
import {
  countRecords,
  deleteRecord,
  getRecord,
  listTags,
  onRecordsChanged,
  putRecord,
  queryRecords,
  statusChange,
  updateRecord,
  type SortKey,
} from '@/lib/storage';
import { STATUSES, STATUS_LABEL, type ReadingRecord, type ReadStatus } from '@/lib/types';

/** Cards loaded per page; more load as the end of the grid scrolls into view. */
const PAGE = 60;

const SORT_LABEL: Record<SortKey, string> = {
  updated: 'Recently updated',
  created: 'Recently added',
  title: 'Title A–Z',
  status: 'Status',
};

type Modal =
  | { kind: 'edit'; id: string }
  | { kind: 'new' }
  | { kind: 'delete'; record: ReadingRecord }
  | undefined;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Bumps whenever any record changes in any context. */
function useRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => onRecordsChanged(() => setRevision((r) => r + 1)), []);
  return revision;
}

export function App() {
  const revision = useRevision();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 200);
  const [status, setStatus] = useState<ReadStatus | 'all'>('all');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [limit, setLimit] = useState(PAGE);
  const [page, setPage] = useState<{ records: ReadingRecord[]; hasMore: boolean }>();
  const [total, setTotal] = useState<number>();
  const [allTags, setAllTags] = useState<string[]>([]);
  const [modal, setModal] = useState<Modal>();

  useEffect(() => {
    // The popup links here with #edit=<id>.
    const m = location.hash.match(/^#edit=(.+)$/);
    if (m?.[1]) {
      setModal({ kind: 'edit', id: decodeURIComponent(m[1]) });
      history.replaceState(null, '', location.pathname);
    }
  }, []);

  useEffect(() => {
    void countRecords().then(setTotal);
    void listTags().then(setAllTags);
  }, [revision]);

  // If the selected tag disappears (last record with it deleted or retagged), stop filtering by it.
  const activeTag = tag && allTags.includes(tag) ? tag : '';

  // Load the first `limit` matches. Any change re-runs it; stale responses are dropped.
  useEffect(() => {
    let stale = false;
    void queryRecords({
      search,
      status: status === 'all' ? undefined : status,
      tag: activeTag || undefined,
      sort,
      limit,
    }).then((p) => {
      if (!stale) setPage(p);
    });
    return () => {
      stale = true;
    };
  }, [search, status, activeTag, sort, limit, revision]);

  // Any filter change starts again from the first page.
  function resetting<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setLimit(PAGE);
    };
  }

  const loadMore = () => setLimit((l) => l + PAGE);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Reading list</h1>
        <div className="row">
          <span className="muted">
            {page && total !== undefined ? `${page.records.length}${page.hasMore ? '+' : ''} shown of ${total}` : ''}
          </span>
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>
            New record
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search title, URL, tags, notes"
          value={query}
          onChange={(e) => resetting(setQuery)(e.target.value)}
          aria-label="Search"
        />
        <select
          value={status}
          onChange={(e) => resetting(setStatus)(e.target.value as ReadStatus | 'all')}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={activeTag} onChange={(e) => resetting(setTag)(e.target.value)} aria-label="Filter by tag">
          <option value="">All tags</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => resetting(setSort)(e.target.value as SortKey)} aria-label="Sort">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      {page === undefined ? (
        <p className="muted">Loading…</p>
      ) : page.records.length === 0 ? (
        <div className="empty">
          {total === 0
            ? 'Your list is empty. Open a page and use the toolbar button to add it.'
            : 'No records match these filters.'}
        </div>
      ) : (
        <>
          <div className="grid">
            {page.records.map((r) => (
              <Card
                key={r.id}
                record={r}
                onEdit={() => setModal({ kind: 'edit', id: r.id })}
                onDelete={() => setModal({ kind: 'delete', record: r })}
                onTag={resetting(setTag)}
              />
            ))}
          </div>
          {page.hasMore && <LoadMore onLoad={loadMore} pageKey={page} />}
        </>
      )}

      <Backup />

      {modal?.kind === 'new' && (
        <Dialog title="New record" onClose={() => setModal(undefined)}>
          <RecordForm
            submitLabel="Add"
            initial={{ title: '', url: '', matchMode: 'exact', prefix: '', status: 'unread', tags: '', notes: '' }}
            onCancel={() => setModal(undefined)}
            onSubmit={async (v) => {
              const created = createRecord({ ...v, prefix: v.matchKey });
              if ('error' in created) throw new Error(created.error);
              await putRecord(created);
              // Continue in the edit dialog so a thumbnail can be added.
              setModal({ kind: 'edit', id: created.id });
            }}
          />
        </Dialog>
      )}

      {modal?.kind === 'edit' && (
        <EditDialog key={modal.id} id={modal.id} revision={revision} onClose={() => setModal(undefined)} />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete record?"
          message={
            <>
              “{modal.record.title}” and its thumbnail will be removed. This can't be undone (unless you have a
              backup).
            </>
          }
          confirmLabel="Delete"
          onClose={() => setModal(undefined)}
          onConfirm={() => deleteRecord(modal.record.id)}
        />
      )}
    </div>
  );
}

/**
 * Loads the next page when it scrolls near the viewport. The observer is re-created
 * for each new page (`pageKey`); its initial observation fires again, so on a tall
 * screen where the sentinel is still visible after a load, the next page loads too.
 */
function LoadMore({ onLoad, pageKey }: { onLoad: () => void; pageKey: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  // Latest callback without re-creating the observer on every render (which would
  // re-fire the initial observation and load page after page).
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadRef.current();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pageKey]);
  return (
    <div ref={ref} className="row" style={{ justifyContent: 'center' }}>
      <button type="button" className="btn" onClick={onLoad}>
        Load more
      </button>
    </div>
  );
}

function Card({
  record,
  onEdit,
  onDelete,
  onTag,
}: {
  record: ReadingRecord;
  onEdit: () => void;
  onDelete: () => void;
  onTag: (t: string) => void;
}) {
  return (
    <article className="card" data-status={record.status}>
      <a href={openUrl(record)} target="_blank" rel="noreferrer">
        <Thumbnail record={record} />
      </a>
      <a className="card-title" href={openUrl(record)} target="_blank" rel="noreferrer">
        {record.title}
      </a>
      <div className="card-meta">
        <span className="status-dot" /> {STATUS_LABEL[record.status]}
        {record.matchMode === 'prefix' && ' · series'}
        {record.readAt && ` · read ${new Date(record.readAt).toLocaleDateString()}`}
      </div>
      {record.matchMode === 'prefix' && record.lastReadUrl && (
        <div className="card-meta" title={record.lastReadUrl}>
          Last: {record.lastReadUrl.replace(/^https?:\/\/(www\.)?/, '')}
        </div>
      )}
      {record.tags.length > 0 && (
        <div className="card-tags">
          {record.tags.map((t) => (
            <button key={t} type="button" className="tag" style={{ border: 0, cursor: 'pointer' }} onClick={() => onTag(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="card-actions">
        <select
          value={record.status}
          aria-label="Status"
          onChange={(e) => void updateRecord(record.id, (r) => statusChange(r, e.target.value as ReadStatus))}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-small" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onDelete} aria-label={`Delete ${record.title}`}>
          Delete
        </button>
      </div>
    </article>
  );
}

function EditDialog({ id, revision, onClose }: { id: string; revision: number; onClose: () => void }) {
  // Loaded by id (the record may not be on the loaded page) and reloaded on any change,
  // so the thumbnail preview stays current. The form keeps its own unsaved edits.
  const [record, setRecord] = useState<ReadingRecord | null>();
  useEffect(() => {
    let stale = false;
    void getRecord(id).then((r) => {
      if (!stale) setRecord(r ?? null);
    });
    return () => {
      stale = true;
    };
  }, [id, revision]);

  if (record === undefined) return null;
  if (record === null) {
    return (
      <Dialog title="Edit record" onClose={onClose}>
        <p className="muted">This record no longer exists.</p>
      </Dialog>
    );
  }

  async function save(v: RecordFormResult) {
    await updateRecord(id, (r) => ({
      ...statusChange(r, v.status),
      title: v.title,
      url: v.url,
      matchMode: v.matchMode,
      matchKey: v.matchKey,
      tags: v.tags,
      notes: v.notes,
      lastReadUrl: v.matchMode === 'prefix' ? r.lastReadUrl : undefined,
    }));
    onClose();
  }

  return (
    <Dialog title="Edit record" onClose={onClose}>
      <Thumbnail record={record} />
      <ThumbnailPicker record={record} />
      <RecordForm
        submitLabel="Save"
        initial={{
          title: record.title,
          url: record.url,
          matchMode: record.matchMode,
          prefix: record.matchMode === 'prefix' ? record.matchKey : defaultPrefix(record.url),
          status: record.status,
          tags: record.tags.join(', '),
          notes: record.notes ?? '',
        }}
        onCancel={onClose}
        onSubmit={save}
      />
    </Dialog>
  );
}

function Backup() {
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  return (
    <section className="backup">
      <h2>Backup</h2>
      <p className="muted" style={{ margin: 0 }}>
        Export everything (thumbnails included) to one JSON file. Importing merges by record id: the copy with the
        newer “updated” time wins.
      </p>
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              const n = await exportToFile();
              setMessage({ text: `Exported ${n} record${n === 1 ? '' : 's'}.` });
            } catch (e) {
              setMessage({ text: `Export failed: ${e instanceof Error ? e.message : e}`, error: true });
            }
          }}
        >
          Export JSON
        </button>
        <label className="btn">
          Import JSON
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                const p = await importFromFile(file);
                setMessage({ text: `Imported: ${p.added} added, ${p.updated} updated, ${p.skipped} unchanged.` });
              } catch (err) {
                setMessage({ text: `Import failed: ${err instanceof Error ? err.message : err}`, error: true });
              }
            }}
          />
        </label>
      </div>
      {message && <span className={message.error ? 'error' : 'muted'}>{message.text}</span>}
    </section>
  );
}
