import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { RecordForm, newUrlRow, urlRowsFor, type RecordFormResult } from '@/components/RecordForm';
import { UrlLink } from '@/components/UrlLink';
import { ImageStrip } from '@/components/Thumbnail';
import { HoldButton } from '@/components/HoldButton';
import { TagInput } from '@/components/TagInput';
import { ImagePicker } from '@/components/ImagePicker';
import { ImageViewer } from '@/components/ImageViewer';
import { FolderLabel, HomeLabel } from '@/components/PlaceLabel';
import { cleanEmoji, decodeFolderFilter, encodeFolderFilter, isCustomColor } from '@/lib/folders';
import { addDomainText } from '@/lib/domains';
import { createRecord, formatAgo, formatDateTime, hasSeries, urlEntries } from '@/lib/records';
import {
  createFolder,
  deleteFolder,
  deleteRecord,
  placeCounts,
  getRecord,
  listFolders,
  allTagCounts,
  placeStats,
  onRecordsChanged,
  putRecord,
  queryRecords,
  getHomeSettings,
  markReadNow,
  renameFolder,
  setFavorite,
  setFolderDomains,
  updateFolderSettings,
  updateHomeSettings,
  statusChange,
  updateRecord,
  type PlaceCount,
  type PlaceCounts,
  type PlaceSettings,
  type SortKey,
} from '@/lib/storage';
import { hasLinkMarkAccess, requestLinkMarkAccess } from '@/lib/tab';
import {
  FOLDER_COLORS,
  FOLDER_NAME_MAX,
  HOME_EMOJI,
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
  type ReadingRecord,
  type ReadStatus,
} from '@/lib/types';

/** Rows loaded per page; more load as the end of the list scrolls into view. */
const PAGE = 60;

/** Sorts offered in Status places (each tab has one status, so no status sort; Revisit uses its own order). */
type ListSort = Exclude<SortKey, 'revisit' | 'status'>;
const SORT_LABEL: Record<ListSort, string> = {
  updated: 'Recently updated',
  created: 'Recently added',
  title: 'Title A–Z',
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

/** Re-render every minute so relative times ("10 min ago") stay current on an idle page. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}

export function App() {
  const revision = useRevision();
  useMinuteTick();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 200);
  /** Status tab in Status places (Revisit places have no tabs). */
  const [status, setStatus] = useState<ReadStatus>('unread');
  /** Selected tag filters (records must have all of them). */
  const [selTags, setSelTags] = useState<string[]>([]);
  /** Show only favorites (kept when switching place, like the status tab). */
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<ListSort>('updated');
  const [limit, setLimit] = useState(PAGE);
  const [page, setPage] = useState<{ records: ReadingRecord[]; hasMore: boolean }>();
  /** Tags used in the open place, with counts. */
  const [placeTags, setPlaceTags] = useState<[string, number][]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<ReadStatus, number>>();
  const [favCounts, setFavCounts] = useState<Record<ReadStatus, number>>();
  // undefined until first loaded, so a remembered folder isn't mistaken for a deleted one.
  const [loadedFolders, setFolders] = useState<Folder[]>();
  const folders = loadedFolders ?? NO_FOLDERS;
  // Record / unread counts of Home and each folder; undefined until first loaded.
  const [counts, setCounts] = useState<PlaceCounts>();
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
    void listFolders().then(setFolders);
    void getHomeSettings().then(setHome);
    void placeCounts().then(setCounts);
  }, [revision]);

  // If the selected folder was deleted (here or in another window), go back to Home.
  const activeFolder: FolderFilter =
    !isFolderId(folder) || loadedFolders === undefined || folders.some((f) => f.id === folder) ? folder : HOME;
  const total = counts && [...counts.folders.values()].reduce((a, c) => a + c.total, counts.home.total);
  const placeCount = !counts
    ? undefined
    : isFolderId(activeFolder)
      ? (counts.folders.get(activeFolder)?.total ?? 0)
      : counts.home.total;
  // The open place's settings (Home's live in their own record).
  const openFolder = isFolderId(activeFolder) ? folders.find((f) => f.id === activeFolder) : undefined;
  const placeSettings = isFolderId(activeFolder) ? openFolder : home;
  const imageSize: ImageSize = placeSettings?.imageSize ?? 'medium';
  // Revisit: "Update read" instead of statuses, always least recently read first.
  // Only folders can use it; Home is always Status.
  const revisit = openFolder?.readMode === 'revisit';

  // Every tag in use, for suggestions in the record form.
  const [tagSuggestions, setTagSuggestions] = useState<[string, number][]>([]);
  useEffect(() => {
    void allTagCounts().then(setTagSuggestions);
  }, [revision]);

  // Tags and status counts of the open place.
  useEffect(() => {
    let stale = false;
    void placeStats(activeFolder).then((st) => {
      if (stale) return;
      setPlaceTags(st.tags);
      setStatusCounts(st.status);
      setFavCounts(st.favorites);
    });
    return () => {
      stale = true;
    };
  }, [activeFolder, revision]);

  // A selected tag that isn't used here any more (record changed or moved) stops filtering.
  const activeTags = selTags.filter((t) => placeTags.some(([pt]) => pt === t));
  const toggleTag = (t: string) => {
    setSelTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
    setLimit(PAGE);
  };
  const addTag = (t: string) => {
    setSelTags((cur) => (cur.includes(t) ? cur : [...cur, t]));
    setLimit(PAGE);
  };

  // "N shown of M": M is the open tab's count (or the whole place in Revisit).
  // Favorites in the open tab (or the whole place in Revisit); with the favorites filter on, M counts only those.
  const favCount = favCounts && (revisit ? favCounts.unread + favCounts.read : favCounts[status]);
  const shownOf = favOnly ? favCount : revisit ? placeCount : statusCounts?.[status];

  // Load the first `limit` matches. Any change re-runs it; stale responses are dropped.
  useEffect(() => {
    let stale = false;
    void queryRecords({
      search,
      status: revisit ? undefined : status,
      favorite: favOnly,
      tags: activeTags,
      folder: activeFolder,
      sort: revisit ? 'revisit' : sort,
      limit,
    }).then((p) => {
      if (!stale) setPage(p);
    });
    return () => {
      stale = true;
    };
  }, [search, status, favOnly, activeTags.join('\u0000'), activeFolder, sort, revisit, limit, revision]);

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
          <a className="btn" href="/boards.html">
            Booru
          </a>
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
        home={home}
        counts={counts}
        value={activeFolder}
        onChange={(f) => {
          // Tag filters belong to the place they were chosen in.
          setSelTags([]);
          resetting(setFolder)(f);
        }}
        onNew={() => setModal({ kind: 'folder-new' })}
      />

      {/* Status places split into Unread / Read tabs (Revisit places don't use statuses); the
          open place's settings sit at the right end of the same row. */}
      <div className="place-row">
        {!revisit ? <StatusTabs value={status} counts={statusCounts} onChange={resetting(setStatus)} /> : <span />}
        <button type="button" className="btn btn-small btn-ghost place-manage" onClick={() => setModal({ kind: 'place' })}>
          <span aria-hidden="true">⚙</span>
          {openFolder ? 'Manage folder' : 'Manage Home'}
        </button>
      </div>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search title, URL, tags, notes"
          value={query}
          onChange={(e) => resetting(setQuery)(e.target.value)}
          aria-label="Search"
        />
        <button
          type="button"
          className={`btn fav-filter${favOnly ? ' btn-primary' : ''}`}
          aria-pressed={favOnly}
          onClick={() => resetting(setFavOnly)(!favOnly)}
          title={favOnly ? 'Showing favorites only; click to show all' : 'Show favorites only'}
        >
          <span className="fav-star" aria-hidden="true">⭐</span> Favorites
          {favCount !== undefined && <span className="tag-chip-count">{favCount}</span>}
        </button>
        {/* Revisit places have a fixed order (least recently read first), so no sort menu. */}
        {!revisit && (
          <select value={sort} onChange={(e) => resetting(setSort)(e.target.value as ListSort)} aria-label="Sort">
            {(Object.keys(SORT_LABEL) as ListSort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Count of the open place, then the tag filter chips. */}
      <div className="list-meta">
        <span className="muted list-count">
          {page && shownOf !== undefined ? `${page.records.length}${page.hasMore ? '+' : ''} shown of ${shownOf}` : ''}
        </span>
        <TagFilter tags={placeTags} selected={activeTags} onToggle={toggleTag} onClear={() => resetting(setSelTags)([])} />
      </div>

      {page === undefined ? (
        <p className="muted">Loading…</p>
      ) : page.records.length === 0 ? (
        <div className="empty">
          {total === 0
            ? 'Your list is empty. Open a page and use the toolbar button to add it.'
            : search || activeTags.length > 0
              ? 'No records here match these filters.'
              : favOnly
                ? 'No favorites here. Star a record with ⭐ to add it.'
              : !revisit && (placeCount ?? 0) > 0
                ? status === 'unread'
                  ? 'Nothing unread here.'
                  : 'Nothing marked read here yet.'
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
                onTag={addTag}
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
            tagSuggestions={tagSuggestions}
            initial={{
              title: '',
              urls: [newUrlRow()],
              status: 'unread',
              tags: [],
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
          tagSuggestions={tagSuggestions}
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
          onSubmit={async (name, domains) => {
            const f = await createFolder(name, domains);
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
          onDomains={(domains) => setFolderDomains(openFolder!.id, domains)}
          onSettings={(patch) => {
            // Changing mode starts from the first page of the new order.
            if (patch.readMode) setLimit(PAGE);
            if (openFolder) {
              void updateFolderSettings(openFolder.id, patch);
            } else {
              // Home has no read mode. Pass only the keys that are set (an undefined key would reset it).
              const { readMode: _ignored, emoji: _noEmoji, ...homePatch } = patch;
              void _ignored;
              void _noEmoji;
              void updateHomeSettings(homePatch);
            }
          }}
          onDelete={() =>
            openFolder && setModal({ kind: 'folder-delete', folder: openFolder, count: counts?.folders.get(openFolder.id)?.total ?? 0 })
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
        {/* The tab already shows Unread / Read, so this line is just the time: when it was read
            (or last read, in Revisit), or for unread records when it was added. */}
        <div className="card-meta">
          {revisit ? (
            record.readAt ? (
              <span title={formatDateTime(record.readAt)}>Last read {formatAgo(record.readAt)}</span>
            ) : (
              'Not read yet'
            )
          ) : record.status === 'read' ? (
            <>
              <span className="status-dot" />{' '}
              {record.readAt ? <span title={formatDateTime(record.readAt)}>Read {formatAgo(record.readAt)}</span> : 'Read'}
            </>
          ) : (
            <span title={formatDateTime(record.createdAt)}>Added {formatAgo(record.createdAt)}</span>
          )}
          {hasSeries(record) && ' · series'}
        </div>
        {record.tags.length > 0 && (
          <div className="card-tags">
            {record.tags.map((t) => (
              <button key={t} type="button" className="hashtag" title={`Filter by “${t}”`} onClick={() => onTag(t)}>
                #{t}
              </button>
            ))}
          </div>
        )}
        <div className="card-links">
          {urlEntries(record).map((e) => (
            <UrlLink key={`${e.matchMode}|${e.matchKey}`} url={e.url} />
          ))}
          {hasSeries(record) && record.lastReadUrl && <UrlLink url={record.lastReadUrl} prefix="Last: " />}
        </div>
      </div>
      {/* Middle column: Unread / Read buttons, or Update read in Revisit places. Images span the row below. */}
      <div className="card-center">
        {revisit ? (
          updateRead
        ) : (
          // One button: moves the record to the other tab.
          <button
            type="button"
            className={`btn btn-small toggle-read${record.status === 'unread' ? ' btn-primary' : ''}`}
            onClick={() => {
              const next = record.status === 'unread' ? 'read' : 'unread';
              void updateRecord(record.id, (r) => statusChange(r, next));
            }}
          >
            {record.status === 'unread' ? 'Mark read' : 'Mark unread'}
          </button>
        )}
      </div>
      {record.images.length > 0 && <ImageStrip record={record} onOpen={onView} original={originalImages} />}
      <div className="card-actions">
        <FavoriteButton record={record} />
        <button type="button" className="btn btn-small" onClick={onEdit} aria-label={`Manage ${record.title}`}>
          Manage
        </button>
      </div>
    </article>
  );
}

/** ⭐ toggle: bright when the record is a favorite, faded otherwise. */
function FavoriteButton({ record }: { record: ReadingRecord }) {
  const on = !!record.favorite;
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost fav-toggle"
      aria-pressed={on}
      aria-label={on ? `Remove ${record.title} from favorites` : `Add ${record.title} to favorites`}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => void setFavorite(record.id, !on)}
    >
      <span className="fav-star" aria-hidden="true">⭐</span>
    </button>
  );
}

function EditDialog({
  id,
  revision,
  folders,
  tagSuggestions,
  onClose,
}: {
  id: string;
  revision: number;
  folders: Folder[];
  tagSuggestions: [string, number][];
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
      {viewing !== undefined && (
        <ImageViewer title={record.title} imageIds={record.images} start={viewing} onClose={() => setViewing(undefined)} />
      )}
      <RecordForm
        footerStart={
          <button type="button" className="btn btn-small btn-danger-text" onClick={() => setConfirmDelete(true)}>
            Delete record
          </button>
        }
        submitLabel="Save"
        folders={folders}
        tagSuggestions={tagSuggestions}
        // Revisit records keep their last-read time; a status change here would clear it.
        hideStatus={!!record.folderId && folders.find((f) => f.id === record.folderId)?.readMode === 'revisit'}
        initial={{
          title: record.title,
          urls: urlRowsFor(record),
          status: record.status,
          tags: record.tags,
          notes: record.notes ?? '',
          folderId: record.folderId ?? '',
        }}
        onCancel={onClose}
        onSubmit={save}
      >
        {/* Images save right away (they're not part of Save). */}
        <ImagePicker record={record} onView={setViewing} />
      </RecordForm>
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

/** Unread / Read tabs with counts. */
function StatusTabs({
  value,
  counts,
  onChange,
}: {
  value: ReadStatus;
  counts: Record<ReadStatus, number> | undefined;
  onChange: (s: ReadStatus) => void;
}) {
  return (
    <div className="status-tabs" role="tablist" aria-label="Status">
      {STATUSES.map((s) => (
        <button key={s} type="button" role="tab" aria-selected={value === s} onClick={() => onChange(s)}>
          {STATUS_LABEL[s]}
          {counts && <span className="status-tab-count">{counts[s]}</span>}
        </button>
      ))}
    </div>
  );
}

/** How many tag chips show before "+N more". */
const TAG_CHIPS_SHOWN = 12;

/**
 * Tag filter: one chip per tag used in the open place, with its count. Click to select
 * (several can be selected: records must have all of them), click again to remove.
 */
function TagFilter({
  tags,
  selected,
  onToggle,
  onClear,
}: {
  tags: [string, number][];
  selected: string[];
  onToggle: (t: string) => void;
  onClear: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (tags.length === 0) return null;
  // Selected tags always stay visible, even when the list is collapsed.
  const visible = showAll
    ? tags
    : tags.filter(([t], i) => i < TAG_CHIPS_SHOWN || selected.includes(t));
  const hidden = tags.length - visible.length;
  return (
    <div className="tag-filter" role="group" aria-label="Filter by tag">
      <span className="tag-filter-label">Tags</span>
      {visible.map(([t, n]) => (
        <button key={t} type="button" className="tag-chip" aria-pressed={selected.includes(t)} onClick={() => onToggle(t)}>
          {t}
          <span className="tag-chip-count">{n}</span>
        </button>
      ))}
      {hidden > 0 && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setShowAll(true)}>
          +{hidden} more
        </button>
      )}
      {showAll && tags.length > TAG_CHIPS_SHOWN && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setShowAll(false)}>
          Show less
        </button>
      )}
      {selected.length > 0 && (
        <button type="button" className="btn btn-small btn-ghost" onClick={onClear}>
          Clear
        </button>
      )}
    </div>
  );
}

function FolderBar({
  folders,
  home,
  counts,
  value,
  onChange,
  onNew,
}: {
  folders: Folder[];
  home: HomeSettings | undefined;
  counts: PlaceCounts | undefined;
  value: FolderFilter;
  onChange: (v: FolderFilter) => void;
  onNew: () => void;
}) {
  const NONE: PlaceCount = { total: 0, unread: 0 };
  // Status places show "unread / read"; Revisit places (no statuses) show the record count.
  const chip = (v: FolderFilter, label: React.ReactNode, count: PlaceCount | undefined, revisit: boolean) => (
    <button key={v === HOME ? 'home' : `f-${v}`} type="button" className="folder-chip" aria-pressed={value === v} onClick={() => onChange(v)}>
      {label}
      {count &&
        (revisit ? (
          <span className="folder-count">{count.total}</span>
        ) : (
          <span className="folder-count" title={`${count.unread} unread, ${count.total - count.unread} read`}>
            {count.unread}
            <span className="folder-count-sep">/</span>
            {count.total - count.unread}
          </span>
        ))}
    </button>
  );
  return (
    <nav className="folder-bar" aria-label="Folders">
      <div className="folder-chips">
        {chip(HOME, <HomeLabel home={home} />, counts?.home, false)}
        {folders.map((f) =>
          chip(f.id, <FolderLabel folder={f} />, counts && (counts.folders.get(f.id) ?? NONE), f.readMode === 'revisit'),
        )}
        {/* Right after the last folder, as a dashed chip: where a new one will appear. */}
        <button type="button" className="folder-chip folder-chip-new" onClick={onNew}>
          + New folder
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
/** How long after the last keystroke a folder name saves itself. */
const NAME_SAVE_MS = 600;

function PlaceDialog({
  folder,
  home,
  onClose,
  onRename,
  onSettings,
  onDomains,
  onDelete,
}: {
  folder: Folder | undefined;
  home: HomeSettings | undefined;
  onClose: () => void;
  onRename: (name: string) => Promise<unknown>;
  /** Save the folder's preferred domains (throws if another folder already has one). */
  onDomains: (domains: string[]) => Promise<unknown>;
  onSettings: (patch: PlaceSettings) => void;
  onDelete: () => void;
}) {
  const settings = folder ?? home;
  const placeName = folder ? folder.name : 'Home';
  const [name, setName] = useState(folder?.name ?? '');
  const [nameMsg, setNameMsg] = useState<{ text: string; error?: boolean }>();
  const [domainMsg, setDomainMsg] = useState<string>();
  const [markMsg, setMarkMsg] = useState<string>();
  /** Whether the site access link marking needs is granted (it can be on without it, e.g. after an import). */
  const [linkAccess, setLinkAccess] = useState<boolean>();
  useEffect(() => {
    void hasLinkMarkAccess().then(setLinkAccess, () => setLinkAccess(false));
  }, []);
  const nameChanged = !!folder && name.trim() !== folder.name;

  // The name saves itself shortly after typing stops (and on leaving the box). An invalid
  // name (empty, taken) shows why and isn't saved; the folder keeps its old name.
  const saveName = useRef<() => void>(() => {});
  saveName.current = () => {
    if (!nameChanged) return;
    if (!name.trim()) return setNameMsg({ text: 'Folder name is required.', error: true });
    onRename(name).then(
      () => setNameMsg({ text: 'Saved.' }),
      (err: unknown) => setNameMsg({ text: err instanceof Error ? err.message : String(err), error: true }),
    );
  };
  useEffect(() => {
    if (!nameChanged) return;
    const t = setTimeout(() => saveName.current(), NAME_SAVE_MS);
    return () => clearTimeout(t);
  }, [name, nameChanged]);
  // Closing the dialog (Done, Esc) before the delay is up still saves what was typed.
  useEffect(() => () => saveName.current(), []);

  return (
    <Dialog title={folder ? 'Manage folder' : 'Manage Home'} onClose={onClose}>
      {folder ? (
        <form
          className="field"
          onSubmit={(e) => {
            // Enter saves at once.
            e.preventDefault();
            saveName.current();
          }}
        >
          <span>Name</span>
          <input
            type="text"
            value={name}
            maxLength={FOLDER_NAME_MAX}
            aria-label="Folder name"
            onChange={(e) => {
              setName(e.target.value);
              setNameMsg(undefined);
            }}
            onBlur={() => saveName.current()}
          />
          {nameMsg && <span className={nameMsg.error ? 'error' : 'muted'}>{nameMsg.text}</span>}
        </form>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Home holds every record that isn't in a folder. It can't be renamed or deleted.
        </p>
      )}

      <PlaceLook folder={folder} home={home} onSettings={onSettings} />

      {folder && (
        <div className="field-group">
          <DomainInput
            value={folder.domains ?? []}
            onChange={async (domains) => {
              setDomainMsg(undefined);
              try {
                await onDomains(domains);
              } catch (err) {
                setDomainMsg(err instanceof Error ? err.message : String(err));
              }
            }}
          />
          {domainMsg ? (
            <span className="error">{domainMsg}</span>
          ) : (
            <small className="muted">Pages added from these domains go into this folder by default.</small>
          )}
        </div>
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

      <div className="field">
        <span>Mark links on websites</span>
        <div className="segmented size-picker" role="group" aria-label={`Mark links to ${placeName} records on websites`}>
          {[false, true].map((on) => (
            <button
              key={String(on)}
              type="button"
              aria-pressed={!!settings?.markLinks === on}
              onClick={async () => {
                setMarkMsg(undefined);
                // The permission prompt needs the click's user gesture: ask before anything else.
                if (on) {
                  const granted = await requestLinkMarkAccess().catch(() => false);
                  setLinkAccess(granted);
                  if (!granted) {
                    setMarkMsg('Marking links needs access to websites. It stays off.');
                    return;
                  }
                }
                onSettings({ markLinks: on });
              }}
            >
              {on ? 'On' : 'Off'}
            </button>
          ))}
        </div>
        {markMsg ? (
          <span className="error">{markMsg}</span>
        ) : settings?.markLinks && linkAccess === false ? (
          <span className="error">
            On, but the extension has no access to websites, so links aren't marked.{' '}
            <button
              type="button"
              className="btn btn-small"
              onClick={async () => setLinkAccess(await requestLinkMarkAccess().catch(() => false))}
            >
              Allow
            </button>
          </span>
        ) : (
          <small className="muted">
            {settings?.markLinks
              ? folder?.readMode === 'revisit'
                ? 'Links to records here are dimmed and blurred on websites (Revisit: every record counts as read).'
                : 'Links to records here are marked on websites: unread dimmed and slightly blurred, read dimmed and blurred more.'
              : 'Off: websites are left as they are.'}{' '}
            Marking reads the links on every page you open, and a site's own scripts could see which of its links are marked.
          </small>
        )}
      </div>

      <div className="dialog-actions" style={{ justifyContent: 'space-between' }}>
        {folder ? (
          <button type="button" className="btn btn-small btn-danger-text" onClick={onDelete}>
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

/**
 * How a place looks in chips and pickers: an emoji before the name (folders; Home always
 * shows HOME_EMOJI) and the name's colour. Both apply at once.
 */
function PlaceLook({
  folder,
  home,
  onSettings,
}: {
  folder: Folder | undefined;
  home: HomeSettings | undefined;
  onSettings: (patch: PlaceSettings) => void;
}) {
  const [emojiText, setEmojiText] = useState(folder?.emoji ?? '');
  const color = folder ? folder.color : home?.color;
  const custom = isCustomColor(color) ? color : undefined;
  // The picker reports every step while dragging: show it at once, save once it settles.
  const [picked, setPicked] = useState<string>();
  // onSettings is a new function on every render of the page (which re-renders after each
  // save): read it through a ref so only a new pick schedules a save.
  const save = useRef(onSettings);
  save.current = onSettings;
  /** A pick not saved yet (saved on close too, so a quick close doesn't drop it). */
  const pending = useRef<string | undefined>(undefined);
  const flush = () => {
    if (pending.current) save.current({ color: pending.current as `#${string}` });
    pending.current = undefined;
  };
  useEffect(() => {
    if (!picked) return;
    pending.current = picked;
    const t = setTimeout(flush, 250);
    return () => clearTimeout(t);
  }, [picked]);
  useEffect(() => () => flush(), []);
  const shownCustom = picked ?? custom;
  const emojiInvalid = !!emojiText.trim() && !cleanEmoji(emojiText);
  return (
    <div className="place-look">
      <div className="field">
        <span>Emoji</span>
        {folder ? (
          <>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                type="text"
                className="emoji-input"
                value={emojiText}
                placeholder="📁"
                aria-label="Folder emoji"
                onChange={(e) => {
                  const text = e.target.value;
                  const emoji = cleanEmoji(text);
                  // Typing or pasting keeps only the first emoji; clearing the box removes it.
                  setEmojiText(emoji ?? text);
                  if (emoji || !text.trim()) onSettings({ emoji: emoji ?? null });
                }}
              />
              {folder.emoji && (
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => {
                    setEmojiText('');
                    onSettings({ emoji: null });
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            {emojiInvalid ? (
              <span className="error">That isn't an emoji.</span>
            ) : (
              <small className="muted">Shown before the name. Win + . (Windows) opens the emoji picker.</small>
            )}
          </>
        ) : (
          <small className="muted">{HOME_EMOJI} Home always shows this emoji.</small>
        )}
      </div>
      <div className="field">
        <span>Name colour</span>
        <div className="color-swatches" role="group" aria-label="Name colour">
          <button
            type="button"
            className="color-swatch"
            aria-pressed={!color}
            title="Default colour"
            onClick={() => {
              pending.current = undefined;
              setPicked(undefined);
              onSettings({ color: null });
            }}
          >
            ∅
          </button>
          {FOLDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-swatch place-c-${c}`}
              aria-pressed={color === c}
              title={c[0]!.toUpperCase() + c.slice(1)}
              aria-label={c}
              onClick={() => {
                pending.current = undefined;
                setPicked(undefined);
                onSettings({ color: c });
              }}
            />
          ))}
          <label
            className={`color-swatch color-swatch-custom${shownCustom ? ' is-set' : ''}`}
            style={shownCustom ? { ['--place-c' as string]: shownCustom } : undefined}
            title={shownCustom ? `Custom colour ${shownCustom}` : 'Pick any colour'}
          >
            <input
              type="color"
              aria-label="Pick a custom colour"
              value={shownCustom ?? '#3fa7d6'}
              onChange={(e) => setPicked(e.target.value)}
            />
          </label>
        </div>
        {shownCustom && (
          <small className="muted">
            Custom colour {shownCustom}: the same shade in light and dark mode, so check it reads in both.
          </small>
        )}
      </div>
    </div>
  );
}

/** Preferred domains as chips (no "#"), normalized as they're added. */
function DomainInput({ value, onChange }: { value: string[]; onChange: (domains: string[]) => void }) {
  return (
    <TagInput
      label="Preferred domains"
      value={value}
      onChange={onChange}
      suggestions={[]}
      chipPrefix=""
      addText={addDomainText}
      placeholder="e.g. x.com, youtube.com"
    />
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
  onSubmit: (name: string, domains: string[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [domains, setDomains] = useState<string[]>([]);
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
            await onSubmit(name, domains);
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
        <DomainInput value={domains} onChange={setDomains} />
        <small className="muted">Pages added from these domains go into this folder by default (optional).</small>
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
