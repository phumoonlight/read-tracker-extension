import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { RecordForm, defaultPrefix, type RecordFormResult } from '@/components/RecordForm';
import { Thumbnail } from '@/components/Thumbnail';
import { ThumbnailPicker } from '@/components/ThumbnailPicker';
import { exportToFile, importFromFile } from '@/lib/backup-io';
import { createRecord, openUrl } from '@/lib/records';
import {
  countRecords,
  createFolder,
  deleteFolder,
  deleteRecord,
  folderCounts,
  getRecord,
  listFolders,
  listTags,
  onRecordsChanged,
  putRecord,
  queryRecords,
  renameFolder,
  statusChange,
  updateRecord,
  type SortKey,
} from '@/lib/storage';
import { FOLDER_NAME_MAX, STATUSES, STATUS_LABEL, type Folder, type ReadingRecord, type ReadStatus } from '@/lib/types';

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
  | { kind: 'folder-new' }
  | { kind: 'folder-rename'; folder: Folder }
  | { kind: 'folder-delete'; folder: Folder; count: number }
  | undefined;

/**
 * undefined = every record, null = records without a folder, string = that folder's id.
 * (Not sentinel strings: folder ids come from backup files and could be any string.)
 */
type FolderFilter = string | null | undefined;
const ALL = undefined;
const NONE = null;
const isFolderId = (f: FolderFilter): f is string => typeof f === 'string';

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
  const [folders, setFolders] = useState<Folder[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [folder, setFolder] = useState<FolderFilter>(ALL);
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
    void listFolders().then(setFolders);
    void folderCounts().then(setCounts);
  }, [revision]);

  // If the selected folder was deleted (here or in another window), go back to All.
  const activeFolder: FolderFilter = !isFolderId(folder) || folders.some((f) => f.id === folder) ? folder : ALL;
  const folderName = new Map(folders.map((f) => [f.id, f.name]));

  // If the selected tag disappears (last record with it deleted or retagged), stop filtering by it.
  const activeTag = tag && allTags.includes(tag) ? tag : '';

  // Load the first `limit` matches. Any change re-runs it; stale responses are dropped.
  useEffect(() => {
    let stale = false;
    void queryRecords({
      search,
      status: status === 'all' ? undefined : status,
      tag: activeTag || undefined,
      folder: activeFolder,
      sort,
      limit,
    }).then((p) => {
      if (!stale) setPage(p);
    });
    return () => {
      stale = true;
    };
  }, [search, status, activeTag, activeFolder, sort, limit, revision]);

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

      <FolderBar
        folders={folders}
        counts={counts}
        total={total}
        value={activeFolder}
        onChange={resetting(setFolder)}
        onNew={() => setModal({ kind: 'folder-new' })}
        onRename={(f) => setModal({ kind: 'folder-rename', folder: f })}
        onDelete={(f) => setModal({ kind: 'folder-delete', folder: f, count: counts.get(f.id) ?? 0 })}
      />

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
            : isFolderId(activeFolder) && !search && status === 'all' && !activeTag
              ? 'This folder is empty. Move records here from their Edit dialog or the popup.'
              : 'No records match these filters.'}
        </div>
      ) : (
        <>
          <div className="grid">
            {page.records.map((r) => (
              <Card
                key={r.id}
                record={r}
                folderName={activeFolder === ALL && r.folderId ? folderName.get(r.folderId) : undefined}
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
            folders={folders}
            initial={{
              title: '',
              url: '',
              matchMode: 'exact',
              prefix: '',
              status: 'unread',
              tags: '',
              notes: '',
              // Adding while a folder is open puts the record in that folder.
              folderId: isFolderId(activeFolder) ? activeFolder : '',
            }}
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
        <EditDialog
          key={modal.id}
          id={modal.id}
          revision={revision}
          folders={folders}
          onClose={() => setModal(undefined)}
        />
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

      {modal?.kind === 'folder-new' && (
        <FolderNameDialog
          title="New folder"
          submitLabel="Create"
          initial=""
          onClose={() => setModal(undefined)}
          onSubmit={async (name) => {
            const f = await createFolder(name);
            resetting(setFolder)(f.id);
          }}
        />
      )}

      {modal?.kind === 'folder-rename' && (
        <FolderNameDialog
          title="Rename folder"
          submitLabel="Rename"
          initial={modal.folder.name}
          onClose={() => setModal(undefined)}
          onSubmit={(name) => renameFolder(modal.folder.id, name)}
        />
      )}

      {modal?.kind === 'folder-delete' && (
        <ConfirmDialog
          title="Delete folder?"
          message={
            modal.count > 0 ? (
              <>
                “{modal.folder.name}” will be deleted. Its {modal.count} record{modal.count === 1 ? '' : 's'} will be kept
                and moved to No folder.
              </>
            ) : (
              <>The empty folder “{modal.folder.name}” will be deleted.</>
            )
          }
          confirmLabel="Delete folder"
          onClose={() => setModal(undefined)}
          onConfirm={async () => {
            await deleteFolder(modal.folder.id);
            setFolder(ALL);
          }}
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
  folderName,
  onEdit,
  onDelete,
  onTag,
}: {
  record: ReadingRecord;
  /** Shown when the list spans folders (the "All" view). */
  folderName?: string;
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
      {folderName && <div className="card-meta">In {folderName}</div>}
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

function EditDialog({
  id,
  revision,
  folders,
  onClose,
}: {
  id: string;
  revision: number;
  folders: Folder[];
  onClose: () => void;
}) {
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
      folderId: v.folderId,
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
        folders={folders}
        initial={{
          title: record.title,
          url: record.url,
          matchMode: record.matchMode,
          prefix: record.matchMode === 'prefix' ? record.matchKey : defaultPrefix(record.url),
          status: record.status,
          tags: record.tags.join(', '),
          notes: record.notes ?? '',
          folderId: record.folderId ?? '',
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

function FolderBar({
  folders,
  counts,
  total,
  value,
  onChange,
  onNew,
  onRename,
  onDelete,
}: {
  folders: Folder[];
  counts: Map<string, number>;
  total: number | undefined;
  value: FolderFilter;
  onChange: (v: FolderFilter) => void;
  onNew: () => void;
  onRename: (f: Folder) => void;
  onDelete: (f: Folder) => void;
}) {
  const inFolders = [...counts.values()].reduce((a, b) => a + b, 0);
  const selected = folders.find((f) => f.id === value);
  const chip = (v: FolderFilter, label: string, count: number | undefined) => (
    <button key={v === ALL ? 'all' : v === NONE ? 'none' : `f-${v}`} type="button" className="folder-chip" aria-pressed={value === v} onClick={() => onChange(v)}>
      {label}
      {count !== undefined && <span className="folder-count">{count}</span>}
    </button>
  );
  return (
    <nav className="folder-bar" aria-label="Folders">
      <div className="folder-chips">
        {chip(ALL, 'All', total)}
        {chip(NONE, 'No folder', total === undefined ? undefined : Math.max(0, total - inFolders))}
        {folders.map((f) => chip(f.id, f.name, counts.get(f.id) ?? 0))}
        <button type="button" className="btn btn-small btn-ghost" onClick={onNew}>
          + New folder
        </button>
      </div>
      {selected && (
        <div className="row">
          <button type="button" className="btn btn-small" onClick={() => onRename(selected)}>
            Rename folder
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onDelete(selected)}>
            Delete folder
          </button>
        </div>
      )}
    </nav>
  );
}

function FolderNameDialog({
  title,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial: string;
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(undefined);
          try {
            await onSubmit(name);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} maxLength={FOLDER_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <span className="error">{error}</span>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
