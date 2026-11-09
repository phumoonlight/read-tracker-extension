import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { RecordForm, newUrlRow, urlRowsFor, type RecordFormResult } from '@/components/RecordForm';
import { UrlLink } from '@/components/UrlLink';
import { ImageStrip } from '@/components/Thumbnail';
import { HoldButton } from '@/components/HoldButton';
import { StatusPicker } from '@/components/StatusPicker';
import { ImagePicker } from '@/components/ImagePicker';
import { ImageViewer } from '@/components/ImageViewer';
import { decodeFolderFilter, encodeFolderFilter } from '@/lib/folders';
import { createRecord, formatDateTime, hasSeries, urlEntries } from '@/lib/records';
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

/** Rows loaded per page; more load as the end of the list scrolls into view. */
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
  | { kind: 'place' }
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

/** The page used to offer a grid view; drop its remembered Grid/List choice once (list only now). */
function forgetOldViewChoice() {
  try {
    localStorage.removeItem('read-tracker:view');
  } catch {
    // storage blocked: nothing to clean up
  }
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

  useEffect(() => {
    forgetOldViewChoice();
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
  // Revisit: "Update read" instead of statuses, always least recently read first.
  // Only folders can use it; Home is always Status.
  const revisit = openFolder?.readMode === 'revisit';

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
          <a className="btn" href="/backup.html">
            Backup
          </a>
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
        onManage={() => setModal({ kind: 'place' })}
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
          <div className="list" data-size={imageSize}>
            {page.records.map((r) => (
              <Card
                key={r.id}
                record={r}
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


      {modal?.kind === 'new' && (
        <Dialog title="New record" onClose={() => setModal(undefined)}>
          <RecordForm
            submitLabel="Add"
            folders={folders}
            initial={{
              title: '',
              urls: [newUrlRow()],
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

      {modal?.kind === 'place' && (
        <PlaceDialog
          // Remount when switching place so the name field starts fresh.
          key={openFolder?.id ?? 'home'}
          folder={openFolder}
          home={home}
          onClose={() => setModal(undefined)}
          onRename={(name) => renameFolder(openFolder!.id, name)}
          onSettings={(patch) => {
            // Changing mode starts from the first page of the new order.
            if (patch.readMode) setLimit(PAGE);
            void (openFolder ? updateFolderSettings(openFolder.id, patch) : updateHomeSettings({ imageSize: patch.imageSize }));
          }}
          onDelete={() =>
            openFolder && setModal({ kind: 'folder-delete', folder: openFolder, count: counts.get(openFolder.id) ?? 0 })
          }
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
  revisit,
  originalImages,
  onEdit,
  onView,
  onTag,
}: {
  record: ReadingRecord;
  /** Revisit place: show last read time and an "Update read" button instead of the status. */
  revisit: boolean;
  /** Large display sizes: show original files instead of the small previews. */
  originalImages: boolean;
  onEdit: () => void;
  /** Open the viewer at this image index. */
  onView: (index: number) => void;
  onTag: (t: string) => void;
}) {
  const updateRead = (
    <HoldButton
      className="btn btn-small btn-primary update-read"
      onConfirm={() => markReadNow(record.id)}
      title="Press and hold to record that you read it now; it then moves to the end of the list"
    >
      Update read
    </HoldButton>
  );
  return (
    <article className="card card-list" data-status={record.status}>
      <div className="card-body">
        {/* The title is plain text; the record's URLs below are the links (it can have several). */}
        <div className="card-title" title={record.title}>
          {record.title}
        </div>
        <div className="card-meta">
          {revisit ? (
            record.readAt ? `Last read ${formatDateTime(record.readAt)}` : 'Not read yet'
          ) : (
            <>
              <span className="status-dot" /> {STATUS_LABEL[record.status]}
            </>
          )}
          {hasSeries(record) && ' · series'}
          {!revisit && record.readAt && ` · read ${new Date(record.readAt).toLocaleDateString()}`}
        </div>
        <div className="card-links">
          {urlEntries(record).map((e) => (
            <UrlLink key={`${e.matchMode}|${e.matchKey}`} url={e.url} />
          ))}
          {hasSeries(record) && record.lastReadUrl && <UrlLink url={record.lastReadUrl} prefix="Last: " />}
        </div>
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
      {/* Middle column: Unread / Read buttons, or Update read in Revisit places. Images span the row below. */}
      <div className="card-center">
        {revisit ? (
          updateRead
        ) : (
          <StatusPicker value={record.status} onChange={(s) => void updateRecord(record.id, (r) => statusChange(r, s))} />
        )}
      </div>
      {record.images.length > 0 && <ImageStrip record={record} onOpen={onView} original={originalImages} />}
      <div className="card-actions">
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
  onClose,
}: {
  id: string;
  revision: number;
  folders: Folder[];
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
      otherUrls: v.otherUrls,
      tags: v.tags,
      notes: v.notes,
      folderId: v.folderId,
      // Keep series progress only while the record still has a series URL.
      lastReadUrl: [v, ...v.otherUrls].some((e) => e.matchMode === 'prefix') ? r.lastReadUrl : undefined,
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
        hideStatus={!!record.folderId && folders.find((f) => f.id === record.folderId)?.readMode === 'revisit'}
        initial={{
          title: record.title,
          urls: urlRowsFor(record),
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

function FolderBar({
  folders,
  counts,
  homeCount,
  value,
  onChange,
  onNew,
  onManage,
}: {
  folders: Folder[];
  counts: Map<string, number>;
  homeCount: number | undefined;
  value: FolderFilter;
  onChange: (v: FolderFilter) => void;
  onNew: () => void;
  /** Open the settings dialog of the selected place (folder or Home). */
  onManage: () => void;
}) {
  const selected = folders.find((f) => f.id === value);
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
        {/* + New folder and Manage sit together at the right end of the row. */}
        <button type="button" className="btn btn-small btn-ghost folder-actions-start" onClick={onNew}>
          + New folder
        </button>
        <button type="button" className="btn btn-small" onClick={onManage}>
          {selected ? 'Manage folder' : 'Manage Home'}
        </button>
      </div>
    </nav>
  );
}

/**
 * Settings of the open place. Folders: name (saved with its own button), image size,
 * read mode (both apply at once) and delete. Home: image size only (it is always Status
 * and can't be renamed or deleted).
 */
function PlaceDialog({
  folder,
  home,
  onClose,
  onRename,
  onSettings,
  onDelete,
}: {
  folder: Folder | undefined;
  home: HomeSettings | undefined;
  onClose: () => void;
  onRename: (name: string) => Promise<unknown>;
  onSettings: (patch: { imageSize?: ImageSize; readMode?: ReadMode }) => void;
  onDelete: () => void;
}) {
  const settings = folder ?? home;
  const placeName = folder ? folder.name : 'Home';
  const [name, setName] = useState(folder?.name ?? '');
  const [nameMsg, setNameMsg] = useState<{ text: string; error?: boolean }>();
  const [saving, setSaving] = useState(false);
  const nameChanged = !!folder && name.trim() !== folder.name;

  return (
    <Dialog title={folder ? 'Manage folder' : 'Manage Home'} onClose={onClose}>
      {folder ? (
        <form
          className="field"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setNameMsg(undefined);
            try {
              await onRename(name);
              setNameMsg({ text: 'Saved.' });
            } catch (err) {
              setNameMsg({ text: err instanceof Error ? err.message : String(err), error: true });
            } finally {
              setSaving(false);
            }
          }}
        >
          <span>Name</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input
              type="text"
              value={name}
              maxLength={FOLDER_NAME_MAX}
              aria-label="Folder name"
              onChange={(e) => {
                setName(e.target.value);
                setNameMsg(undefined);
              }}
            />
            <button type="submit" className="btn btn-small" disabled={saving || !nameChanged || !name.trim()}>
              Save
            </button>
          </div>
          {nameMsg && <span className={nameMsg.error ? 'error' : 'muted'}>{nameMsg.text}</span>}
        </form>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Home holds every record that isn't in a folder. It can't be renamed or deleted.
        </p>
      )}

      <div className="field">
        <span>Image size</span>
        <div className="segmented size-picker" role="group" aria-label={`Image size for ${placeName}`}>
          {IMAGE_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={(settings?.imageSize ?? 'medium') === s}
              onClick={() => onSettings({ imageSize: s })}
              title={{ small: 'Small', medium: 'Medium (default)', large: 'Large', xlarge: 'Extra large' }[s]}
            >
              {IMAGE_SIZE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Read mode</span>
        {folder ? (
          <>
            <div className="segmented size-picker" role="group" aria-label={`Read mode for ${placeName}`}>
              {READ_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={(folder.readMode ?? 'status') === m}
                  onClick={() => onSettings({ readMode: m })}
                >
                  {READ_MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <small className="muted">
              {(folder.readMode ?? 'status') === 'revisit'
                ? 'Revisit: hold “Update read” on a record to record when you last read it. The least recently read come first.'
                : 'Status: mark records unread or read.'}
            </small>
          </>
        ) : (
          <small className="muted">Status: mark records unread or read. Home always uses Status.</small>
        )}
      </div>

      <div className="dialog-actions" style={{ justifyContent: 'space-between' }}>
        {folder ? (
          <button type="button" className="btn btn-small btn-danger" onClick={onDelete}>
            Delete folder
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
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
