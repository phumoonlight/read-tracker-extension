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
npm test             # vitest run (tests/**/*.test.ts)
npm run icons        # regenerate public/icon/*.png (scripts/make-icons.mjs, Node only)
```

Run `npm test` and `npm run compile` before declaring work done.

## Layout

```
src/
  entrypoints/
    background.ts        service worker: badge per tab, series progress (lastReadUrl)
    popup/               toolbar popup: current page state, add, status, folder, images
    options/             full list page (options_ui, open_in_tab): folder bar, grid/list views, search, filters, Manage dialog (edit + delete), backup
  components/            shared React UI (RecordForm, ImagePicker, ImageViewer, Thumbnail (cover), StatusPicker, Dialog)
  lib/                   framework-free logic (only db.ts / storage.ts / tab.ts / images.ts touch browser APIs)
    types.ts             ReadingRecord, Folder, SCHEMA_VERSION, BackupFile
    folders.ts           folder name rules (folderNameError), newFolder, sortFolders
    url.ts               normalizeUrl, isTrackingParam, suggestPrefix
    match.ts             prefixMatches, candidateKeys, chooseMatch (index lookup), findMatch (reference)
    migrate.ts           migrateRecord + MIGRATIONS table
    db.ts                IndexedDB open/upgrade (stores, indexes, DB_VERSION), withTx/req helpers
    storage.ts           records repository: lookups, paged queries, atomic writes, change signal
    images.ts            StoredImage, getImage/getImagePreview, prepareImage (validate + preview), sniffImageType
    tab.ts               active tab, captureVisibleTab, og:image lookup/download
    records.ts           createRecord, computeMatchKey, tag helpers
    backup.ts            parseBackup / planImport / buildBackup (pure, unit-tested)
    backup-io.ts         export download + import apply (side effects)
  styles/base.css        color tokens on :root, dark mode via prefers-color-scheme, shared classes
tests/                   vitest unit tests for pure lib code
public/icon/             extension icons
```

`@/` is an alias for `src/`.

## Data model

`ReadingRecord` (src/lib/types.ts): `id` (crypto.randomUUID), `title`, `url` (as entered), `matchKey`,
`matchMode` ("exact" | "prefix"), `status` ("unread" | "reading" | "read"), `lastReadUrl?`, `tags` (lowercase,
unique), `folderId?`, `notes?`, `images` (ids, max `MAX_IMAGES` = 3, first = cover), `createdAt`, `updatedAt`,
`readAt?`, `otherUrls?`. Timestamps are epoch milliseconds. Current `SCHEMA_VERSION` is 4 (v4 added `otherUrls`; v2 added `folderId`; v3 replaced
`hasThumbnail` with `images`, mapping an old thumbnail to image id `legacyImageId(recordId)` = `legacy-<recordId>`).

Read modes (`readMode?` on `Folder` and `HomeSettings`; absent = `status`): **Status** is unread / reading / read.
**Revisit** is for things read again and again: cards show a press-and-hold "Update read" button (`HoldButton`, `HOLD_MS` = 1 s; `markReadNow`: status `read`, `readAt` = now)
and "Last read …" instead of a status, the list is always least recently read first (`queryRecords` sort `revisit`
over the `readOrder` index `[_readSort, createdAt]`, where the derived `_readSort` = `readAt ?? 0`, so never-read
records come first), and the status/sort filters and the Manage dialog's status picker are hidden. In list rows Update read sits in the centre
column (`.card-center`; rows are a 3-column grid `body | center | actions` with images on a second row). Settings changes
go through `updateFolderSettings` / `updateHomeSettings`, which merge and store defaults as absent.

`Folder`: `id`, `name`, `imageSize?` (`small` | `medium` | `large` | `xlarge`; absent = medium), `readMode?`, `createdAt`,
`updatedAt`. `imageSize` applies while that folder is open. Home has no Folder record: its size is `HomeSettings` in the `meta`
store (key `home`, `getHomeSettings` / `setHomeImageSize`), exported as `home` in backups and merged newer-wins.
Home can't be renamed or deleted. In either place, grid column width and
list tile width scale with it, and at large/xlarge cards show original files instead of previews
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
  (the viewer shows it at full resolution), plus a ≤480px WebP `preview` used only for covers and tiles. Change
  images only through `addImages` / `removeImage` / `reorderImages` (drag to sort in `ImagePicker`; first = cover; a stale order
  is ignored) (they update the record's `images` list in the
  same transaction); `deleteRecord` removes a record's images. Files over 25 MB are rejected (`prepareImage`).
  DB v4 converted the old `thumbnails` store (300px WebP per record) into images `legacy-<recordId>` and dropped it;
  those few stay 300px because the originals were never kept.
- `meta`: `schemaVersion` (record shape version) and `home` (`HomeSettings`).
- `chrome.storage.local` holds only `recordsRevision`, bumped after every write. IndexedDB has no change events;
  `storage.onChanged` reaches every context and wakes the service worker, so this key is the change signal
  (`onRecordsChanged`). Builds before the IndexedDB move stored records there as `record:<id>`;
  `moveLegacyStorage()` copies them in and deletes them on first use.

How data is read:
- Badge and popup: `findRecordForUrl()` looks up `lookupTags(url)` (the exact tag `e|<url>`, then `p|<key>` for each
  of `candidateKeys(url)`, the URL cut at each `/` or `?`) on the `matchKeys` index. No full load. `chooseMatch` must
  agree with `findMatch`; a randomized test (with multi-URL records) checks it.
- List page: `queryRecords()` walks the sort index, filters rows as it goes (search, status, tag, folder), and stops
  after `limit` matches (60 per page, more on scroll). Cover previews load only when a card nears the viewport;
  originals load only in the viewer.
  Folder counts come from the `folderId` index keys (`folderCounts`), not from record values.
- `getAllRecords()` is for export/import only.

Rules:
- All writes go through storage.ts so the change signal fires. Each write is one transaction; inside `withTx`
  only issue IDB requests (no fetch, no other awaits) or the transaction auto-commits.
- Record writes (`putRecords`, `updateRecord`, `applyImport`) drop a `folderId` whose folder no longer exists, in the
  same transaction, so a record never points at a deleted folder.
- `updatedAt` must change on every edit; import merge depends on it. Use `updateRecord()`, which sets it and is
  atomic (read and write in one transaction). An empty patch is a no-op.
- Change status through `statusChange()` so `readAt` stays in step (set on read, cleared otherwise).
- `lastReadUrl` is only meaningful for prefix records and only updated while status is "reading".

### Changing the schema

1. Bump `SCHEMA_VERSION` in `src/lib/types.ts`.
2. Add `MIGRATIONS[oldVersion] = (r) => newShape` in `src/lib/migrate.ts`.
3. Update `assertRecord` in `src/lib/backup.ts` and the test fixture in `tests/fixtures.ts`.
4. If you need a new index or store, bump `DB_VERSION` in `src/lib/db.ts` and add an `if (oldVersion < N)` step
   to `upgrade()`. Never edit an existing step.

Stored records migrate on first access in each context (`ensureReady` in storage.ts). Backups from older versions
migrate on import; backups from newer versions are rejected.

### Backup and images

Schema v3 backups carry `images: [{ id, recordId, dataUrl }]` with the original files (so files can be large); v1/v2
files carried `thumbnails` (record id -> data URL), which `parseBackup` turns into `legacy-<recordId>` images.
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
- A record has a main URL (`url` / `matchKey` / `matchMode`, opened from the title) plus optional `otherUrls`
  (`UrlEntry[]`, up to `MAX_URLS` = 10 in total, schema v4); `urlEntries(record)` lists them all. Each URL matches on
  its own; `matchedEntry(record, url)` says which one did (the background uses it so `lastReadUrl` only follows
  series URLs). Editing happens in `RecordForm` rows (`validateUrlRows`: blank extra rows ignored, duplicates of the
  same mode+key rejected).
- An exact URL matches when its `matchKey === normalizeUrl(tabUrl)`.
- Prefix records match on a path boundary (`prefixMatches`): `site.com/a` covers `site.com/a/...` and
  `site.com/a?...`, not `site.com/abc`. An exact match beats any prefix; otherwise the longest prefix wins.

## Background worker

Listens to `tabs.onUpdated` (url change / load complete), `tabs.onActivated` and record changes in storage, then sets
badge text and color per tab: `✓` green = read, `•` orange = reading, `•` blue = unread, empty = not in the list.
It keeps no copy of the list: each event is a few index lookups. MV3 workers are short-lived, so never keep state
there that isn't in storage.

## Permissions

`storage` (change signal), `unlimitedStorage` (IndexedDB quota), `tabs` (read tab URLs for the badge), `activeTab` (screenshot and script access to the
current page while the popup is open), `scripting` (read og:image meta), `favicon` (site icons from Chrome's cache via
`chrome-extension://<id>/_favicon/?pageUrl=…`, see `faviconUrl` and `components/SiteLabel.tsx`; Chrome returns a
generic globe for sites it has no icon for).
`optional_host_permissions: ["<all_urls>"]` is requested at runtime for a single origin, only when an og:image
download is blocked by CORS. Don't add install-time permissions without a strong reason.

## Conventions

- No UI library and no CSS framework. Colors come only from tokens in `styles/base.css`; add a token for both light
  and dark if you need a new color.
- Keep `src/lib` free of React. Put pure logic in its own function so it can be tested without browser APIs.
- Import browser APIs from `wxt/browser` (`browser.*`), not the global `chrome`.
- Use `<dialog>` (components/Dialog.tsx) for confirmations, never `window.confirm`.
- Read event values (`e.target.value`) synchronously in the handler, never inside an `updateRecord` callback or after
  an `await`: controlled inputs are reset to the old value by then (this broke the card status picker once).
- `<Thumbnail>` (the cover) shows all of a record's images as a mosaic in one 16:10 box (1 full, 2 side by side,
  3 = large left + two stacked), so card sizes never depend on the image count; clicking an image opens the viewer
  at that index. Grid cards and the popup use it. List rows instead use `<ImageStrip>`: each image as its own
  tile below the text (96px at medium; nothing when the record has no images).
- Records may have no images. `<Thumbnail>` then shows a placeholder tinted per site (`siteLabel` + `hueFor`,
  colors from the `--ph-*` tokens): the domain at size "large", its first letter at "small". Never derive the
  placeholder from the title (its first character can be a combining mark, e.g. in Thai).
- `localStorage` is only for per-browser UI conveniences, always wrapped in try/catch: the grid/list choice
  (`read-tracker:view`) and the open folder (`read-tracker:folder`, encoded by `encodeFolderFilter`; a folder that no
  longer exists, or an old "all" value, falls back to Home once folders have loaded). Data goes in IndexedDB.
- Ask before adding dependencies. The project deliberately uses its own IndexedDB layer (`lib/db.ts`), and unit
  tests cover only pure code (there is no IndexedDB in Node without adding `fake-indexeddb`).
