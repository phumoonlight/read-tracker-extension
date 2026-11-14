# Read Tracker (Chrome extension)

Local-only reading list. Manifest V3, built with WXT + React + TypeScript. No backend, no network calls except
downloading an og:image the user asked for.

## Commands

```sh
npm install          # also runs `wxt prepare` (generates .wxt/ types)
npm run dev          # WXT dev mode: opens a Chrome profile with the extension loaded and hot reload
npm run build        # production build -> .output/chrome-mv3/
npm run zip          # zip for the Chrome Web Store -> .output/*.zip
npm run compile      # tsc --noEmit
npm test             # vitest run (tests/**/*.test.ts); on Windows run it from a `C:\` path with an upper-case drive
                     # letter: from `c:\...` vitest loads twice and every suite fails with "reading 'config'"
npm run icons        # regenerate public/icon/*.png (scripts/make-icons.mjs, Node only)
```

Run `npm test` and `npm run compile` before declaring work done.

The extension is in use, so every change bumps the version: run `npm version patch --no-git-tag-version` (updates
`package.json` and `package-lock.json`; WXT puts it in the manifest) and commit the bump with the change itself. Use
`minor` instead of `patch` only when asked.

The extension is installed unpacked (not on the Chrome Web Store). `manifest.key` in `wxt.config.ts` pins its ID to
`dbdkjjjmnbpfmfgfbmcgkmledmnmbamj` on every PC and folder; IndexedDB data lives under that ID, so never change or
remove the key. The private key is outside the repo and isn't needed to build.

## Layout

```
src/
  entrypoints/
    background.ts        service worker: badge per tab, series progress (lastReadUrl), link marking (registers the
                         content script, answers its lookups)
    link-marks.content.ts  content script (registration: 'runtime', never in the manifest): dims marked links
    board-marks.content.ts content script (in the manifest, matches BOARD_ORIGINS): board marking (fade, marking mode)
    popup/               toolbar popup (short): add page (title + searchable folder dropdown, `FolderSelect`), or read state only; links to Manage.
                         On a board page, board marking controls on top (BoardPanel.tsx): a violet card (`--booru*`
                         tokens): the open post's Read / Not read pill, Mark page read
                         (hold) | Click to mark, and a page progress bar (no link to the Booru page; it is in the list header). Below it, "Record this page"
                         starts folded on board sites (AddPage `collapsed`; a chevron row opens the form)
    options/             full list page (options_ui, open_in_tab): folder bar, record list, search, filters, Manage dialog (edit + delete)
    backup/              Backup page (backup.html, linked from the list header): export / import (.zip), erase all data
                         (`wipeAllData`, one transaction; a dialog with a 3 s `HoldButton`)
    boards/              Boards page, titled "Booru" in the UI (boards.html, linked as "Booru" from the list header and the popup): "Dimming is off" banner / Turn on (only when off), collapsed help,
                         per-board table (posts, size, clear), import of a Booru explorer .json
  components/            shared React UI (RecordForm, ImagePicker, ImageViewer, Thumbnail (cover), UrlLink, HoldButton,
                         StatusPicker, Dialog)
  lib/                   framework-free logic (only db.ts / storage.ts / tab.ts / images.ts / board-store.ts /
                         marking-prefs.ts / changes.ts touch browser APIs)
    types.ts             ReadingRecord, Folder, SCHEMA_VERSION, BackupFile
    folders.ts           folder name rules (folderNameError), newFolder, sortFolders
    url.ts               normalizeUrl, isTrackingParam, suggestPrefix
    match.ts             prefixMatches, candidateKeys, chooseMatch (index lookup), findMatch (reference)
    migrate.ts           migrateRecord + MIGRATIONS table
    db.ts                IndexedDB open/upgrade (stores, indexes, DB_VERSION), withTx/req helpers
    storage.ts           records repository: lookups, paged queries, atomic writes, change signal
    changes.ts           change signal key + onRecordsChanged (no IndexedDB, so the content script can use it)
    link-marks.ts        link marking rules (linkMark, marksLinks), message type, origins (pure)
    boards.ts            board marking (pure): BOARDS, post ids, packed buckets, messages, prefs shape, .json format
    board-store.ts       board read history in IndexedDB (query, mark, stats, clear, import), own change signal
    marking-prefs.ts     global Dim switch in chrome.storage.local (`markingPrefs`: paused = no dimming)
    images.ts            StoredImage, getImage/getImagePreview, prepareImage (validate + preview), sniffImageType
    tab.ts               active tab, captureVisibleTab, og:image lookup/download
    records.ts           createRecord, computeMatchKey, tag helpers
    ids.ts               newId(): cuid2 ids for records, folders and images
    backup.ts            parseManifest / parseRecordLine / imagesFromZip / planImport / buildManifest (pure, unit-tested)
    backup-io.ts         export download + import apply (side effects)
    zip.ts               minimal ZIP writer / reader (stored entries, ZIP64, deflate on read), CRC-32
    lines.ts             readLines: stream a text Blob line by line (JSON Lines)
  styles/base.css        color tokens on :root, dark mode via prefers-color-scheme, shared classes
tests/                   vitest unit tests for pure lib code
public/icon/             extension icons
```

`@/` is an alias for `src/`.

## Data model

`ReadingRecord` (src/lib/types.ts): `id` (`newId()` in lib/ids.ts: a cuid2; records made earlier have UUIDs, which stay. Ids are opaque strings, never parse them), `title`, `url` (as entered), `matchKey`,
`matchMode` ("exact" | "prefix"), `status` ("unread" | "read"), `lastReadUrl?`, `tags` (lowercase,
unique), `folderId?`, `notes?`, `images` (ids, max `MAX_IMAGES` = 3, first = cover), `createdAt`, `updatedAt`,
`readAt?`, `otherUrls?`, `favorite?: true` (starred; absent = no, never stored as false; key `fav` in backups). Timestamps are epoch milliseconds. Current `SCHEMA_VERSION` is 1 (reset before the first
release; there are no migrations yet).

Read modes (`readMode?` on `Folder` only; absent = `status`. **Home is always Status**: it has no read mode,
`getHomeSettings` / `updateHomeSettings` strip one saved by an older build, and backups ignore it): **Status** is unread / read (Unread / Read tabs; each row's centre column has one Mark read / Mark unread button).
**Revisit** is for things read again and again: cards show a press-and-hold "Update read" button (`HoldButton`, `HOLD_MS` = 1 s; `markReadNow`: status `read`, `readAt` = now)
and "Last read …" instead of a status, the list is always least recently read first (`queryRecords` sort `revisit`
over the `readOrder` index `[_readSort, createdAt]`, where the derived `_readSort` = `readAt ?? 0`, so never-read
records come first), and the status/sort filters and the Manage dialog's status picker are hidden. In list rows Update read sits in the centre
column (`.card-center`; rows are a 3-column grid `body | center | actions` with images on a second row). Settings changes
go through `updateFolderSettings` / `updateHomeSettings`, which merge and store defaults as absent.

Preferred domains (`domains?` on `Folder`, `lib/domains.ts`): normalized hosts (`normalizeDomain`: no scheme / path /
port / leading "www."). Matching is the **exact host** (subdomains don't count; "www." is ignored). A domain belongs to
at most one folder: `createFolder` / `setFolderDomains` refuse a clash in the same transaction, and `planImport`
drops a clashing domain from incoming folders. The popup's Add form preselects `folderForUrl(folders, tab.url)`,
else Home. Edited as chips (`TagInput` with `chipPrefix=""`, `addText=addDomainText`) in New folder / Manage folder.

Link marking (`markLinks?: true` on `Folder` and `HomeSettings`; absent = off, stored only when on; carried in
backups): links on websites to records of a place with it on get `data-read-tracker="unread|read"` and are dimmed
(opacity: unread .5, read .25) and blurred (`filter: blur`, 1px / 2px; both undone on hover / focus; on a link that wraps an `<img>` they go on the image, since opacity / filter on the link hid pixiv thumbnails). No text colour or glow
(removed by request). The look is `MARK_LOOK` / `markCss` in `lib/link-marks.ts`, shared with board marking: a board
post marked read looks exactly like a read record. Revisit places mark every record `read` (`linkMark`). The content script
(`entrypoints/link-marks.content.ts`) is registered by the background with `scripting.registerContentScripts` only
while `marksLinks(folders, home)` and the optional host permission (`LINK_MARK_ORIGINS`, requested from the Manage
dialog's click) are both true, and injected into open tabs when it gets registered (it runs once per page). It sends
the page's link URLs in batches (`LINK_MARKS_MESSAGE`); the background answers with `linkMarks(urls)` (storage.ts: one
transaction, each index tag looked up once, same match as the badge). It rescans on DOM changes (throttled) and
asks again for everything on the change signal. The dialog warns when marking is on without the permission (e.g. after an import).

`Folder`: `id`, `name`, `imageSize?` (`small` | `medium` | `large` | `xlarge`; absent = medium), `readMode?`, `markLinks?`, `createdAt`,
`updatedAt`. `imageSize` applies while that folder is open. Home has no Folder record: its size is `HomeSettings` in the `meta`
store (key `home`, `getHomeSettings` / `setHomeImageSize`), exported as `home` in backups and merged newer-wins.
Home can't be renamed or deleted. In either place, the list's image tile height scales with it
(60 / 120 / 240 / 320 px; width follows each image's aspect ratio while the images fit in the row), and at large/xlarge tiles show original files instead of previews
(`usesOriginalImages`). Set it with `setFolderImageSize`; unknown values in backups fall back to medium. Folders are flat and a record is in at most one folder;
`folderId` absent = the record is in **Home**, the default place (there is no "All" view: the list always shows
Home or one folder, and search/filters apply within it). Names are trimmed, whitespace-collapsed, at most
`FOLDER_NAME_MAX` characters, and unique case-insensitively (`folderNameError`). Deleting a folder keeps its records
and moves them to Home (bumping their `updatedAt`).

Storage: IndexedDB database `read-tracker` (layout in `src/lib/db.ts`, no third-party wrapper):
- `records` (keyPath `id`): the record plus derived index fields `_title` (lowercased), `_rank` (status sort),
  `_readSort` (`readAt ?? 0`, Revisit order) and `_matchKeys` (one `mode|key` tag per URL, see `matchTag`).
  `toRow`/`fromRow` in storage.ts add and strip them; they never leave storage.ts.
  Indexes: `matchKeys` (multiEntry over `_matchKeys`, DB v6; replaced `matchKey`), `updatedAt`, `createdAt`, `title`, `status` (`[_rank, updatedAt]`), `readOrder`
  (`[_readSort, createdAt]`, DB v5), `tags` (multiEntry),
  `folderId` (records without a folder are not in it). `toRow` drops an undefined `folderId` so it is never stored.
- `folders` (keyPath `id`): Folder. Same change signal as records.
- `images` (keyPath `id`, index `recordId`): `StoredImage` = the original file Blob, never resized or re-encoded
  (the viewer shows it at full resolution), plus a WebP `preview` (whole image fitted within 480 × 900) used only for covers and small tiles. Change
  images only through `addImages` / `removeImage` / `reorderImages` (drag to sort in `ImagePicker`; first = cover; a stale order
  is ignored) (they update the record's `images` list in the
  same transaction); `deleteRecord` removes a record's images. Files over 25 MB are rejected (`prepareImage`).
  DB v4 converted the old `thumbnails` store (300px WebP per record) into images `legacy-<recordId>` and dropped it;
  those few stay 300px because the originals were never kept.
- `meta`: `recordVersion` (record `SCHEMA_VERSION`; pre-release builds used `schemaVersion`, numbered up to 5, which
  is dropped on startup) and `home` (`HomeSettings`).
- `boardReads` (keyPath `[site, bucket]`, DB v7): board read history, see "Board marking". (`boardFloors`, v7, was
  removed in v8: each floor became posts 1..floor marked in `boardReads`.)
- `chrome.storage.local` holds `recordsRevision`, bumped after every write. IndexedDB has no change events;
  `storage.onChanged` reaches every context and wakes the service worker, so this key is the change signal
  (`onRecordsChanged`). Also `boardsRevision` (board history change signal, `onBoardsChanged`) and `markingPrefs`.

How data is read:
- Badge and popup: `findRecordForUrl()` looks up `lookupTags(url)` (the exact tag `e|<url>`, then `p|<key>` for each
  of `candidateKeys(url)`, the URL cut at each `/` or `?`) on the `matchKeys` index. No full load. `chooseMatch` must
  agree with `findMatch`; a randomized test (with multi-URL records) checks it.
- List page: `queryRecords()` walks the sort index, filters rows as it goes (search, status, tag, folder), and stops
  after `limit` matches (60 per page, more on scroll). Cover previews load only when a card nears the viewport;
  originals load only in the viewer.
  Folder bar counts come from index keys only (`placeCounts`: the `status` index's unread range joined with the
  `folderId` index on record id; Home = total minus the folders), not from record values. Status places' chips
  show `unread/read`, Revisit folders show the record count.
- Tag filter: a chip row under the search box (`TagFilter`) lists the tags used in the open place with counts
  (`placeStats(place)`, one pass over that place's records, also gives the status counts); several can be selected and `queryRecords({ tags })` keeps
  records that have all of them. Selection resets when switching place.
- Favorites: a ⭐ toggle on each row (`setFavorite`) and in the popup; the toolbar's ⭐ Favorites button filters the
  open place/tab (`queryRecords({ favorite: true })`, count from `placeStats(place).favorites`).
- Status places show **Unread / Read tabs** (`StatusTabs`, counts from `placeStats`; default Unread) instead of a
  status filter; the list queries one status. Revisit places have no tabs. The sort menu has no status sort.
- `getAllRecords()` is for export/import only.

Rules:
- All writes go through storage.ts so the change signal fires. Each write is one transaction; inside `withTx`
  only issue IDB requests (no fetch, no other awaits) or the transaction auto-commits.
- Record writes (`putRecords`, `updateRecord`, `applyImport`) drop a `folderId` whose folder no longer exists, in the
  same transaction, so a record never points at a deleted folder.
- `updatedAt` must change on every edit; import merge depends on it. Use `updateRecord()`, which sets it and is
  atomic (read and write in one transaction). An empty patch is a no-op.
- Change status through `statusChange()` so `readAt` stays in step (set on read, cleared otherwise).
- `lastReadUrl` is only meaningful for prefix records and only updated while the record is not read.

### Board marking

Merged from the "Booru explorer" extension (only its read marking; not its hover preview or save button). On
Gelbooru, Konachan (.com/.net = one board) and pixiv (`BOARDS` in `lib/boards.ts`: host, `postId(url)`), post
thumbnails marked read look like a read record's link mark (`markCss('read')`: dimmed and blurred, sharp on hover). Board posts are **not records**: only post numbers are stored, per board, and they
never appear in the list.
- Storage (`board-store.ts`): ids grouped 65536 to a row (`[site, bucket]`), each row a sorted `Uint16Array` of
  offsets (2 bytes a post) or an 8 KB bitmap (1 bit per post) once more than 4096 of its posts are read, whichever is
  smaller (`packRow`, re-decided on every write). There is **no floor / "read up to"** (removed by request): only
  marked posts. Writes bump `boardsRevision` (not `recordsRevision`, so link marking doesn't rescan).
- Board marking is **always on** (user request). The popup header's global **Dim** switch (`markingPrefs` in
  chrome.storage.local, `marking-prefs.ts`; `MarkingPrefs` / `parseMarkingPrefs` in `lib/link-marks.ts`) only turns
  the dimming off on websites, for both board posts and record link marks: marking, recording, marking mode and the
  badge keep working (by request). The content scripts set their dim `<style>`'s `media` to `not all` while off.
  `paused: true` = off; absent = on. Builds up to 0.1.22 stored a board-only `boardPrefs.paused`; it is read when
  `markingPrefs` is absent and removed on the next change.
- `board-marks.content.ts` is a manifest content script (`matches: BOARD_ORIGINS`, `document_start`), so Chrome runs
  it on every board page; its `matches` are install-time host access for those sites. On install / reload the
  background injects it into board tabs already open, and removes the runtime registration (id `board-marks`) that
  builds up to 0.1.9 made. It runs once per page (window flag); it stops itself only when the extension context is
  gone (it removes its attributes, style and banner). It tags post links
  that wrap an `<img>`, asks the background which ids are read (`BOARD_QUERY_MESSAGE`, batched), writes with
  `BOARD_MARK_MESSAGE` (painted first; `markedAt` keeps an older answer from undoing a newer mark), and asks again for
  everything on `onBoardsChanged`.
- Controls are in the **popup** (`popup/BoardPanel.tsx`, on top when the tab's host is a board; there is no on-page
  dock). The open post is read and marked in IndexedDB directly; page actions go to the tab's script with
  `tabs.sendMessage` (`BOARD_PAGE_MESSAGE`: `info`, `mark-page`, `unmark-page`, `marking`; each answered with
  `BoardPageInfo`): hold "Mark page read" (600 ms; skips pixiv bookmarks, read off the heart's pink each time, never
  stored); once nothing is left to mark (`BoardPageInfo.left` = 0, e.g. 6 / 6) the same button is "Unmark page" (unmarks
  every read post on the page, bookmarks included); marking
  mode (clicks mark instead of navigating; the popup closes, a banner on the page shows it, Esc / Stop leaves). No
  answer = the script isn't in the tab (the popup says to reload).
- Toolbar badge: a board post page with no matching record shows ✓ / • from the board history.
- Import: the Boards page reads Booru explorer's export (`parseBoardFile`: `{ format: "booru-explorer-reads",
  version: 1, exported, sites: { board: [ids] }, floors? }`); merge only (ids unioned, `importBoardReads`, one
  transaction). A file's `floors` ("read up to N") is imported as posts 1..N marked read (`addRange`: whole buckets
  become full bitmaps directly). Export (`booru/<board>.bin` in the backup) has every read id (`rowsToIds`); nothing writes
  the JSON format or `floors` any more (by request). Unknown boards are reported and skipped.

### Changing the schema

1. Bump `SCHEMA_VERSION` in `src/lib/types.ts`.
2. Add `MIGRATIONS[oldVersion] = (r) => newShape` in `src/lib/migrate.ts`.
3. Update `assertRecord` and `RECORD_KEYS` (short key for records.jsonl) in `src/lib/backup.ts`, and the test
   fixture in `tests/fixtures.ts`.
4. If you need a new index or store, bump `DB_VERSION` in `src/lib/db.ts` and add an `if (oldVersion < N)` step
   to `upgrade()`. Never edit an existing step.

Stored records migrate on first access in each context (`ensureReady` in storage.ts). Backups from older schema
versions migrate on import; backups from newer versions (schema or `BACKUP_LAYOUT`) are rejected.

### Backup and images

Backups are **ZIP files** (`lib/zip.ts`, own writer/reader, no dependency). Layout 4 (`BACKUP_LAYOUT`, separate
from `SCHEMA_VERSION`; bump it when the files in the ZIP change; layouts 1 (no board history) and 2 (one `boards.json`)
still import; layout 3's `booru/<board>.json` was never used for real data and is ignored):
- `manifest.json` (`BackupManifest`): format, `layout`, record schema `version`, `exportedAt`, `counts`, `folders`,
  `home`. Read first (`openBackup`), so the Backup page previews counts and rejects newer backups before reading
  records.
- `records.jsonl`: one record per line, read as a stream (`lib/lines.ts` `readLines`), never as one string. A bad
  line is fatal and names its line (`parseRecordLine`; nothing is written). Lines are compact (`encodeRecord` /
  `decodeRecord`): keys of at most 3 characters (`RECORD_KEYS`: id, ttl, url, mk, mm, sts, lru, tag, fid, nt, img,
  ca, ua, ra, ou; `URL_KEYS` inside `ou`), and left out when absent, empty (tags, images), default (`mm` "exact") or
  derivable (`mk` equal to `computeMatchKey(url, mm)`; restored on import). Adding a record field without a key in
  `RECORD_KEYS` is a type error. Migrations run on the decoded (long-key) record.
- `booru/<board>.bin` (`boardBackupPath`; by request): board read history, one binary file per board with anything
  read, named after the board (`boardOfIdsFile`). Format (`encodeBoardIds` / `decodeBoardIds` in boards.ts): `RTBI`,
  a version byte, the count, the first id, then the gaps to the previous id, each a varint (7 bits a byte, low first,
  top bit = more), so mostly 1 byte a post. Not Booru explorer compatible (not needed: its marking is being dropped).
  On import, `booru/*.bin`, plus `boards.json` from layout 2 (Booru explorer's JSON,
  `parseBoardFile`), are found by `boardBackupEntries`, merged (`mergeBoardReads`) and imported like the Booru page
  import; `counts.booruPosts` in the manifest for the preview (read as `boardPosts` from backups before 0.1.17). The Booru page import takes several files at once
  (`.bin` from a backup's `booru/` folder, or a Booru explorer `.json`).
- `images/<id>.<ext>` (`imagePath`, `imageStem`): original files. There is no image list: on import each id in a
  record's `images` is looked up by file-name stem among the ZIP's entries (`imageIndex` + `imagesFromZip`; any
  extension, first record listing an id gets it).

Import reports what it skipped or changed as `issues` (strings; `planImport` adds folder renames skipped, domain
clashes, images not in the file or owned by another record, records moved to Home; parsing adds invalid folder
domains; an image file that can't be read is skipped and taken off its record instead of failing
the import). The Backup page lists them under a collapsed summary (`describeIssues` caps the list). Entries are stored
(not compressed) and the archive Blob is assembled from the image Blobs, so export doesn't copy files into memory
(only a streaming CRC-32 pass); ZIP64 records are written only when needed. The reader takes stored or deflated
entries (via `DecompressionStream`), so a re-zipped backup imports. Only ZIP backups import: the
old `.json` format (images as data URLs) was removed, so `.json` files are rejected.
On import, a written record keeps only image ids the file carries for it (or already stored for it); previews are
rebuilt; stored images the winning copy no longer lists are deleted; an id owned by another local record is never
re-pointed.

### Backup and folders

Backups carry `folders` (absent in v1 files). `planImport` merges folders by id (newer `updatedAt` wins). An incoming
folder with a new id but the same name as a local one is not created; its records go into the local folder. A newer
rename that would duplicate another folder's name is skipped. A record `folderId` naming no known folder becomes
Home.

## URL matching

- `normalizeUrl()` drops the scheme (http and https match), lowercases the host, strips `www.` and a trailing dot,
  drops `#hash`, tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, … see `TRACKING_PARAMS`), and trailing
  slashes, and sorts the remaining params. Non-http(s) URLs give `null` (not trackable).
- A record has a main URL (`url` / `matchKey` / `matchMode`, listed first) plus optional `otherUrls`
  (`UrlEntry[]`, up to `MAX_URLS` = 10 in total); `urlEntries(record)` lists them all. Each URL matches on
  its own; `matchedEntry(record, url)` says which one did (the background uses it so `lastReadUrl` only follows
  series URLs). Editing happens in `RecordForm` rows (`validateUrlRows`: blank extra rows ignored, duplicates of the
  same mode+key rejected).
- **Series (prefix) matching is paused in the UI** (user request): `RecordForm` has no match-mode toggle and new
  URLs are always `exact`. Everything else still supports `prefix` (matching, index, backups, `lastReadUrl`), and a
  URL already saved as a series keeps working; its form row shows a note and a "Match this page only" button.
  To bring series back, restore the This page / Series toggle in `UrlRowEditor`.
- An exact URL matches when its `matchKey === normalizeUrl(tabUrl)`.
- Prefix records match on a path boundary (`prefixMatches`): `site.com/a` covers `site.com/a/...` and
  `site.com/a?...`, not `site.com/abc`. An exact match beats any prefix; otherwise the longest prefix wins.

## Background worker

Listens to `tabs.onUpdated` (url change / load complete), `tabs.onActivated` and record changes in storage, then sets
badge text and color per tab: `✓` green = read, `•` blue = unread, empty = not in the list.
It keeps no copy of the list: each event is a few index lookups. MV3 workers are short-lived, so never keep state
there that isn't in storage.

## Permissions

`storage` (change signal), `unlimitedStorage` (IndexedDB quota), `tabs` (read tab URLs for the badge), `activeTab` (screenshot and script access to the
current page while the popup is open), `scripting` (read og:image meta), `favicon` (site icons from Chrome's cache via
`chrome-extension://<id>/_favicon/?pageUrl=…`, see `faviconUrl` and `components/UrlLink.tsx`; Chrome returns a
generic globe for sites it has no icon for).
`optional_host_permissions: ["<all_urls>"]` is requested at runtime for a single origin, only when an og:image
download is blocked by CORS, or as `http://*/*` + `https://*/*` when link marking is turned on. WXT adds a runtime
content script's `matches` to `host_permissions`, so `link-marks.content.ts` must not declare `matches`. The one
install-time site access is `board-marks.content.ts`'s manifest `matches` (`BOARD_ORIGINS`: gelbooru, konachan, pixiv;
always-on board marking, by request). An entrypoint name can't be shared: the Boards page is `boards`, its content
script `board-marks`. Don't add install-time permissions without a strong reason.

## Conventions

- No UI library and no CSS framework. Colors come only from tokens in `styles/base.css`; add a token for both light
  and dark if you need a new color.
- Keep `src/lib` free of React. Put pure logic in its own function so it can be tested without browser APIs.
- Import browser APIs from `wxt/browser` (`browser.*`), not the global `chrome`.
- Use `<dialog>` (components/Dialog.tsx) for confirmations, never `window.confirm`.
- Read event values (`e.target.value`) synchronously in the handler, never inside an `updateRecord` callback or after
  an `await`: controlled inputs are reset to the old value by then (this broke the card status picker once).
- The list page has one layout: rows (there used to be a grid view; its stored choice `read-tracker:view` is
  removed on load). Each row is a 3-column grid `body | center | actions` with images on a second row via
  `<ImageStrip>` (each image its own tile, one line, never scrolling: fixed height `--tile-h` per image size and
  natural width while they fit; otherwise tiles shrink, wider ones more, and crop with `object-fit: cover`. The
  viewer always shows the whole image. Nothing when the record has no images). Previews are scaled to fit
  480 × 900 without cropping (`previewSize`).
- `<Thumbnail>` (a 16:10 cover mosaic of all images: 1 full, 2 side by side, 3 = large left + two stacked) is used
  only by the popup now; clicking an image opens the viewer at that index.
- In rows the title is plain text; each of the record's URLs is a `<UrlLink>` (site icon + `displayUrl`) under the
  status line, plus a "Last: …" link for series progress.
- Records may have no images. `<Thumbnail>` then shows a placeholder tinted per site (`siteLabel` + `hueFor`,
  colors from the `--ph-*` tokens): the domain at size "large", its first letter at "small". Never derive the
  placeholder from the title (its first character can be a combining mark, e.g. in Thai).
- `localStorage` is only for per-browser UI conveniences, always wrapped in try/catch: the open folder (`read-tracker:folder`, encoded by `encodeFolderFilter`; a folder that no
  longer exists, or an old "all" value, falls back to Home once folders have loaded). Data goes in IndexedDB.
- Ask before adding dependencies (approved so far: `@paralleldrive/cuid2` 2.x for ids; 3.x doubles its size). The project deliberately uses its own IndexedDB layer (`lib/db.ts`), and unit
  tests cover only pure code (there is no IndexedDB in Node without adding `fake-indexeddb`).
