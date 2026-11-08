import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { RecordForm, defaultPrefix, type RecordFormResult } from '@/components/RecordForm';
import { Thumbnail } from '@/components/Thumbnail';
import { ThumbnailPicker } from '@/components/ThumbnailPicker';
import { exportToFile, importFromFile } from '@/lib/backup-io';
import { createRecord, openUrl } from '@/lib/records';
import { deleteRecord, getAllRecords, onRecordsChanged, putRecord, statusChange, updateRecord } from '@/lib/storage';
import { deleteThumbnail } from '@/lib/thumbnails';
import { STATUSES, STATUS_LABEL, type ReadingRecord, type ReadStatus } from '@/lib/types';

type SortKey = 'updated' | 'created' | 'title' | 'status';
const SORTS: Record<SortKey, { label: string; cmp: (a: ReadingRecord, b: ReadingRecord) => number }> = {
  updated: { label: 'Recently updated', cmp: (a, b) => b.updatedAt - a.updatedAt },
  created: { label: 'Recently added', cmp: (a, b) => b.createdAt - a.createdAt },
  title: { label: 'Title A–Z', cmp: (a, b) => a.title.localeCompare(b.title) },
  status: {
    label: 'Status',
    cmp: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || b.updatedAt - a.updatedAt,
  },
};

type Modal =
  | { kind: 'edit'; id: string }
  | { kind: 'new' }
  | { kind: 'delete'; record: ReadingRecord }
  | undefined;

export function App() {
  const [records, setRecords] = useState<ReadingRecord[]>();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ReadStatus | 'all'>('all');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [modal, setModal] = useState<Modal>();

  useEffect(() => {
    const load = () => getAllRecords().then(setRecords);
    void load();
    const off = onRecordsChanged(load);
    // The popup links here with #edit=<id>.
    const m = location.hash.match(/^#edit=(.+)$/);
    if (m?.[1]) {
      setModal({ kind: 'edit', id: decodeURIComponent(m[1]) });
      history.replaceState(null, '', location.pathname);
    }
    return off;
  }, []);

  const allTags = useMemo(() => [...new Set((records ?? []).flatMap((r) => r.tags))].sort(), [records]);
  // If the selected tag disappears (last record with it deleted or retagged), stop filtering by it.
  const activeTag = tag && allTags.includes(tag) ? tag : '';

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (records ?? [])
      .filter((r) => status === 'all' || r.status === status)
      .filter((r) => !activeTag || r.tags.includes(activeTag))
      .filter(
        (r) =>
          !q ||
          [r.title, r.url, r.notes ?? '', ...r.tags].some((s) => s.toLowerCase().includes(q)),
      )
      .sort(SORTS[sort].cmp);
  }, [records, query, status, activeTag, sort]);

  const editing = modal?.kind === 'edit' ? records?.find((r) => r.id === modal.id) : undefined;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Reading list</h1>
        <div className="row">
          <span className="muted">{records ? `${visible.length} of ${records.length}` : ''}</span>
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>
            New record
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input type="search" placeholder="Search title, URL, tags, notes" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        <select value={status} onChange={(e) => setStatus(e.target.value as ReadStatus | 'all')} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={activeTag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
          <option value="">All tags</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          {Object.entries(SORTS).map(([k, s]) => (
            <option key={k} value={k}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {records === undefined ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="empty">
          {records.length === 0
            ? 'Your list is empty. Open a page and use the toolbar button to add it.'
            : 'No records match these filters.'}
        </div>
      ) : (
        <div className="grid">
          {visible.map((r) => (
            <Card
              key={r.id}
              record={r}
              onEdit={() => setModal({ kind: 'edit', id: r.id })}
              onDelete={() => setModal({ kind: 'delete', record: r })}
              onTag={setTag}
            />
          ))}
        </div>
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

      {modal?.kind === 'edit' && editing && <EditDialog key={editing.id} record={editing} onClose={() => setModal(undefined)} />}

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
          onConfirm={async () => {
            await deleteRecord(modal.record.id);
            await deleteThumbnail(modal.record.id);
          }}
        />
      )}
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

function EditDialog({ record, onClose }: { record: ReadingRecord; onClose: () => void }) {
  async function save(v: RecordFormResult) {
    await updateRecord(record.id, (r) => ({
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
