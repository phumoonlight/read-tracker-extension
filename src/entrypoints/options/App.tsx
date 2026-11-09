import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { RecordForm, defaultPrefix, type RecordFormResult } from '@/components/RecordForm';
import { SiteLabel } from '@/components/SiteLabel';
import { ImageStrip, Thumbnail } from '@/components/Thumbnail';
import { ImagePicker } from '@/components/ImagePicker';
import { ImageViewer } from '@/components/ImageViewer';
import { exportToFile, importFromFile } from '@/lib/backup-io';
import { decodeFolderFilter, encodeFolderFilter } from '@/lib/folders';
import { createRecord, formatDateTime, openUrl } from '@/lib/records';
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
  getHomeSettings,
  markReadNow,
  renameFolder,
  updateFolderSettings,
  updateHomeSettings,
  statusChange,
  updateRecord,
  type SortKey,
} from '@/lib/storage';
import {
  FOLDER_NAME_MAX,
  IMAGE_SIZES,
  IMAGE_SIZE_LABEL,
  READ_MODES,
  READ_MODE_LABEL,
  STATUSES,
  STATUS_LABEL,
  usesOriginalImages,
  type Folder,
  type HomeSettings,
  type ImageSize,
  type ReadMode,
  type ReadingRecord,
  type ReadStatus,
} from '@/lib/types';

/** Cards loaded per page; more load as the end of the grid scrolls into view. */
const PAGE = 60;

/** Sorts offered in Status mode (Revisit places always use least recently read first). */
type ListSort = Exclude<SortKey, 'revisit'>;
const SORT_LABEL: Record<ListSort, string> = {
  updated: 'Recently updated',
  created: 'Recently added',
  title: 'Title A–Z',
  status: 'Status',
};

type Modal =
  | { kind: 'edit'; id: string }
  | { kind: 'view'; recordId: string; index: number }
  | { kind: 'new' }
  | { kind: 'folder-new' }
  | { kind: 'folder-rename'; folder: Folder }
  | { kind: 'folder-delete'; folder: Folder; count: number }
  | undefined;

/**
 * The place being shown: null = Home (records without a folder, the default), string =
 * that folder's id. (Not a sentinel string: folder ids come from backups and could be anything.)
 */
type FolderFilter = string | null;
const HOME = null;
const isFolderId = (f: FolderFilter): f is string => typeof f === 'string';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type ViewMode = 'grid' | 'list';
const VIEW_KEY = 'read-tracker:view';

/** Grid or list layout, remembered per browser (a convenience; falls back to grid if storage is unavailable). */
function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const set = (v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // storage blocked: keep the in-memory choice
    }
  };
  return [view, set];
}

const NO_FOLDERS: Folder[] = [];
const FOLDER_KEY = 'read-tracker:folder';

/**
 * The open place, remembered per browser so a reload reopens it (a convenience;
 * falls back to Home if storage is unavailable or the folder no longer exists).
 */
function useStoredFolder(): [FolderFilter, (f: FolderFilter) => void] {
  const [folder, setFolder] = useState<FolderFilter>(() => {
    try {
      return decodeFolderFilter(localStorage.getItem(FOLDER_KEY));
    } catch {
      return HOME;
    }
  });
  const set = (f: FolderFilter) => {
    setFolder(f);
    try {
      localStorage.setItem(FOLDER_KEY, encodeFolderFilter(f));
    } catch {
      // storage blocked: keep the in-memory choice
    }
  };
  return [folder, set];
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
  const [sort, setSort] = useState<ListSort>('updated');
  const [limit, setLimit] = useState(PAGE);
  const [page, setPage] = useState<{ records: ReadingRecord[]; hasMore: boolean }>();
  const [total, setTotal] = useState<number>();
  const [allTags, setAllTags] = useState<string[]>([]);
  // undefined until first loaded, so a remembered folder isn't mistaken for a deleted one.
  const [loadedFolders, setFolders] = useState<Folder[]>();
  const folders = loadedFolders ?? NO_FOLDERS;
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [folder, setFolder] = useStoredFolder();
  const [home, setHome] = useState<HomeSettings>();
  const [modal, setModal] = useState<Modal>();
  const [view, setView] = useViewMode();

  useEffect(() => {
    // The popup links here with #edit=<id> or #view=<id>&i=<index>.
    const edit = location.hash.match(/^#edit=([^&]+)$/);
    const view = location.hash.match(/^#view=([^&]+)&i=(\d+)$/);
    if (edit?.[1]) setModal({ kind: 'edit', id: decodeURIComponent(edit[1]) });
    else if (view?.[1]) setModal({ kind: 'view', recordId: decodeURIComponent(view[1]), index: Number(view[2]) });
    if (edit || view) history.replaceState(null, '', location.pathname);
  }, []);

  useEffect(() => {
    void countRecords().then(setTotal);
    void listTags().then(setAllTags);
    void listFolders().then(setFolders);
    void getHomeSettings().then(setHome);
    void folderCounts().then(setCounts);
  }, [revision]);

  // If the selected folder was deleted (here or in another window), go back to Home.
  const activeFolder: FolderFilter =
    !isFolderId(folder) || loadedFolders === undefined || folders.some((f) => f.id === folder) ? folder : HOME;
  // Home holds every record that isn't in a folder.
  const homeCount = total === undefined ? undefined : Math.max(0, total - [...counts.values()].reduce((a, b) => a + b, 0));
  const placeCount = isFolderId(activeFolder) ? (counts.get(activeFolder) ?? 0) : homeCount;
  // The open place's settings (Home's live in their own record).
  const openFolder = isFolderId(activeFolder) ? folders.find((f) => f.id === activeFolder) : undefined;
  const placeSettings = isFolderId(activeFolder) ? openFolder : home;
  const imageSize: ImageSize = placeSettings?.imageSize ?? 'medium';
  // Revisit: "Read now" instead of statuses, always least recently read first.
  const revisit = placeSettings?.readMode === 'revisit';

  // If the selected tag disappears (last record with it deleted or retagged), stop filtering by it.
  const activeTag = tag && allTags.includes(tag) ? tag : '';

  // Load the first `limit` matches. Any change re-runs it; stale responses are dropped.
  useEffect(() => {
    let stale = false;
    void queryRecords({
      search,
      status: revisit || status === 'all' ? undefined : status,
      tag: activeTag || undefined,
      folder: activeFolder,
      sort: revisit ? 'revisit' : sort,
      limit,
    }).then((p) => {
      if (!stale) setPage(p);
    });
    return () => {
      stale = true;
    };
  }, [search, status, activeTag, activeFolder, sort, revisit, limit, revision]);

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
            {page && placeCount !== undefined
              ? `${page.records.length}${page.hasMore ? '+' : ''} shown of ${placeCount}`
              : ''}
          </span>
          <div className="segmented" role="group" aria-label="Layout">
            {(['grid', 'list'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={view === m} onClick={() => setView(m)}>
                {m === 'grid' ? 'Grid' : 'List'}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setModal({ kind: 'new' })}>
            New record
          </button>
        </div>
      </header>

      <FolderBar
        folders={folders}
        counts={counts}
        homeCount={homeCount}
        value={activeFolder}
        onChange={resetting(setFolder)}
        onNew={() => setModal({ kind: 'folder-new' })}
        onRename={(f) => setModal({ kind: 'folder-rename', folder: f })}
        onDelete={(f) => setModal({ kind: 'folder-delete', folder: f, count: counts.get(f.id) ?? 0 })}
        home={home}
        onSettings={(f, patch) => {
          // Changing mode starts from the first page of the new order.
          if (patch.readMode) setLimit(PAGE);
          void (f ? updateFolderSettings(f.id, patch) : updateHomeSettings(patch));
        }}
      />

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search title, URL, tags, notes"
          value={query}
          onChange={(e) => resetting(setQuery)(e.target.value)}
          aria-label="Search"
        />
        {!revisit && (
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
        )}
        <select value={activeTag} onChange={(e) => resetting(setTag)(e.target.value)} aria-label="Filter by tag">
          <option value="">All tags</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {revisit ? (
          <span className="muted toolbar-note">Revisit: least recently read first</span>
        ) : (
          <select value={sort} onChange={(e) => resetting(setSort)(e.target.value as ListSort)} aria-label="Sort">
            {(Object.keys(SORT_LABEL) as ListSort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        )}
      </div>

      {page === undefined ? (
        <p className="muted">Loading…</p>
      ) : page.records.length === 0 ? (
        <div className="empty">
          {total === 0
            ? 'Your list is empty. Open a page and use the toolbar button to add it.'
            : search || status !== 'all' || activeTag
              ? 'No records here match these filters.'
              : isFolderId(activeFolder)
                ? 'This folder is empty. Move records here from their Edit dialog or the popup.'
                : 'Home is empty: every record is in a folder.'}
        </div>
      ) : (
        <>
          <div className={view === 'list' ? 'list' : 'grid'} data-size={imageSize}>
            {page.records.map((r) => (
              <Card
                key={r.id}
                record={r}
                layout={view}
                revisit={revisit}
                originalImages={usesOriginalImages(imageSize)}
                onEdit={() => setModal({ kind: 'edit', id: r.id })}
                onView={(index) => setModal({ kind: 'view', recordId: r.id, index })}
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
              // Continue in the Manage dialog so images can be added.
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
          home={home}
          onClose={() => setModal(undefined)}
        />
      )}

      {modal?.kind === 'view' && (
        <RecordViewer recordId={modal.recordId} index={modal.index} onClose={() => setModal(undefined)} />
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
                and moved to Home.
              </>
            ) : (
              <>The empty folder “{modal.folder.name}” will be deleted.</>
            )
          }
          confirmLabel="Delete folder"
          onClose={() => setModal(undefined)}
          onConfirm={async () => {
            await deleteFolder(modal.folder.id);
            setFolder(HOME);
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
  layout,
  revisit,
  originalImages,
  onEdit,
  onView,
  onTag,
}: {
  record: ReadingRecord;
  layout: ViewMode;
  /** Revisit place: show last read time and a "Read now" button instead of the status. */
  revisit: boolean;
  /** Large display sizes: show original files instead of the small previews. */
  originalImages: boolean;
  onEdit: () => void;
  /** Open the viewer at this image index. */
  onView: (index: number) => void;
  onTag: (t: string) => void;
}) {
  const href = openUrl(record);
  const readNow = (
    <button
      type="button"
      className="btn btn-small btn-primary read-now"
      onClick={() => void markReadNow(record.id)}
      title="Record that you read it now; it moves to the end of the list"
    >
      Read now
    </button>
  );
  return (
    <article className={`card card-${layout}`} data-status={record.status}>
      {layout === 'grid' && (
        <div className="card-thumb">
          {record.images.length > 0 ? (
            // Clicking an image opens the full-resolution viewer at that image.
            <Thumbnail record={record} onOpen={onView} original={originalImages} />
          ) : (
            // No image: the placeholder links to the page, like the title.
            <a href={href} target="_blank" rel="noreferrer" tabIndex={-1} aria-hidden="true">
              <Thumbnail record={record} />
            </a>
          )}
        </div>
      )}
      <div className="card-body">
        <a className="card-title" href={href} target="_blank" rel="noreferrer" title={record.title}>
          {record.title}
        </a>
        <div className="card-meta">
          {revisit ? (
            record.readAt ? `Last read ${formatDateTime(record.readAt)}` : 'Not read yet'
          ) : (
            <>
              <span className="status-dot" /> {STATUS_LABEL[record.status]}
            </>
          )}
          {record.matchMode === 'prefix' && ' · series'}
          {!revisit && record.readAt && ` · read ${new Date(record.readAt).toLocaleDateString()}`}
          {' · '}
          <SiteLabel url={record.url} />
        </div>
        {record.matchMode === 'prefix' && record.lastReadUrl && (
          <div className="card-meta card-last" title={record.lastReadUrl}>
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
      </div>
      {/* List rows: Read now sits in the middle column, images span the row below the text. */}
      {layout === 'list' && revisit && <div className="card-center">{readNow}</div>}
      {layout === 'list' && record.images.length > 0 && (
        <ImageStrip record={record} onOpen={onView} original={originalImages} />
      )}
      <div className="card-actions">
        {revisit ? (
          layout === 'grid' && readNow
        ) : (
          <select
            value={record.status}
            aria-label="Status"
            onChange={(e) => {
              // Read the value now: the select is controlled, so by the time updateRecord's
              // callback runs (after an IndexedDB read), React has reset it to the old status.
              const status = e.target.value as ReadStatus;
              void updateRecord(record.id, (r) => statusChange(r, status));
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn-small" onClick={onEdit} aria-label={`Manage ${record.title}`}>
          Manage
        </button>
      </div>
    </article>
  );
}

function EditDialog({
  id,
  revision,
  folders,
  home,
  onClose,
}: {
  id: string;
  revision: number;
  folders: Folder[];
  home: HomeSettings | undefined;
  onClose: () => void;
}) {
  // Loaded by id (the record may not be on the loaded page) and reloaded on any change,
  // so the image tiles stay current. The form keeps its own unsaved edits.
  const [record, setRecord] = useState<ReadingRecord | null>();
  const [viewing, setViewing] = useState<number>();
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      <Dialog title="Manage record" onClose={onClose}>
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
    <Dialog title="Manage record" onClose={onClose}>
      <ImagePicker record={record} onView={setViewing} />
      {viewing !== undefined && (
        <ImageViewer title={record.title} imageIds={record.images} start={viewing} onClose={() => setViewing(undefined)} />
      )}
      <RecordForm
        submitLabel="Save"
        folders={folders}
        // Revisit records keep their last-read time; a status change here would clear it.
        hideStatus={(record.folderId ? folders.find((f) => f.id === record.folderId) : home)?.readMode === 'revisit'}
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
      <div className="danger-zone">
        <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirmDelete(true)}>
          Delete record
        </button>
      </div>
      {confirmDelete && (
        // Cancel returns to this dialog; Delete closes both.
        <ConfirmDialog
          title="Delete record?"
          message={
            <>
              “{record.title}” and its images will be removed. This can't be undone (unless you have a backup).
            </>
          }
          confirmLabel="Delete"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await deleteRecord(id);
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}

function Backup() {
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  return (
    <section className="backup">
      <h2>Backup</h2>
      <p className="muted" style={{ margin: 0 }}>
        Export everything (original images included) to one JSON file. Importing merges by record id: the copy with the
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
  homeCount,
  value,
  onChange,
  onNew,
  onRename,
  onDelete,
  onSettings,
  home,
}: {
  folders: Folder[];
  counts: Map<string, number>;
  homeCount: number | undefined;
  value: FolderFilter;
  onChange: (v: FolderFilter) => void;
  onNew: () => void;
  onRename: (f: Folder) => void;
  onDelete: (f: Folder) => void;
  /** Change settings of a folder, or of Home (null). */
  onSettings: (f: Folder | null, patch: { imageSize?: ImageSize; readMode?: ReadMode }) => void;
  home: HomeSettings | undefined;
}) {
  const selected = folders.find((f) => f.id === value);
  const settings = selected ?? home;
  const placeName = selected ? selected.name : 'Home';
  const chip = (v: FolderFilter, label: string, count: number | undefined) => (
    <button key={v === HOME ? 'home' : `f-${v}`} type="button" className="folder-chip" aria-pressed={value === v} onClick={() => onChange(v)}>
      {label}
      {count !== undefined && <span className="folder-count">{count}</span>}
    </button>
  );
  return (
    <nav className="folder-bar" aria-label="Folders">
      <div className="folder-chips">
        {chip(HOME, 'Home', homeCount)}
        {folders.map((f) => chip(f.id, f.name, counts.get(f.id) ?? 0))}
        <button type="button" className="btn btn-small btn-ghost" onClick={onNew}>
          + New folder
        </button>
      </div>
      {/* Home can only change its settings; folders can also be renamed and deleted. */}
      <div className="row">
        {selected && (
          <>
            <button type="button" className="btn btn-small" onClick={() => onRename(selected)}>
              Rename folder
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => onDelete(selected)}>
              Delete folder
            </button>
          </>
        )}
        <span className="muted" style={{ fontSize: 12, marginLeft: selected ? 8 : 0 }}>
          Image size
        </span>
        <div className="segmented size-picker" role="group" aria-label={`Image size for ${placeName}`}>
          {IMAGE_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={(settings?.imageSize ?? 'medium') === s}
              onClick={() => onSettings(selected ?? null, { imageSize: s })}
              title={{ small: 'Small', medium: 'Medium (default)', large: 'Large', xlarge: 'Extra large' }[s]}
            >
              {IMAGE_SIZE_LABEL[s]}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
          Read mode
        </span>
        <div className="segmented size-picker" role="group" aria-label={`Read mode for ${placeName}`}>
          {READ_MODES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={(settings?.readMode ?? 'status') === m}
              onClick={() => onSettings(selected ?? null, { readMode: m })}
              title={
                m === 'status'
                  ? 'Status (default): mark records unread, reading or read'
                  : 'Revisit: a "Read now" button records when you last read it; least recently read comes first'
              }
            >
              {READ_MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
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

/** Viewer opened from a card or from the popup (#view=...): loads the record by id. */
function RecordViewer({ recordId, index, onClose }: { recordId: string; index: number; onClose: () => void }) {
  const [record, setRecord] = useState<ReadingRecord | null>();
  useEffect(() => {
    void getRecord(recordId).then((r) => setRecord(r ?? null));
  }, [recordId]);
  if (record === undefined) return null;
  if (!record || record.images.length === 0) {
    return (
      <Dialog title="Images" onClose={onClose}>
        <p className="muted">{record ? 'This record has no images.' : 'This record no longer exists.'}</p>
      </Dialog>
    );
  }
  return <ImageViewer title={record.title} imageIds={record.images} start={index} onClose={onClose} />;
}
