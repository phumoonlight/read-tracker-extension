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
    popup/               toolbar popup: current page state, add, status, thumbnail
    options/             full list page (options_ui, open_in_tab): grid, search, filters, edit, delete, backup
  components/            shared React UI (RecordForm, ThumbnailPicker, Thumbnail, StatusPicker, Dialog)
  lib/                   framework-free logic (only storage.ts / tab.ts / thumbnails.ts touch browser APIs)
    types.ts             ReadingRecord, SCHEMA_VERSION, BackupFile
    url.ts               normalizeUrl, isTrackingParam, suggestPrefix
    match.ts             prefixMatches, findMatch
    migrate.ts           migrateRecord + MIGRATIONS table
    storage.ts           records in chrome.storage.local, change subscription
    idb.ts               tiny IndexedDB key-value wrapper (in-house; no idb-keyval)
    thumbnails.ts        thumbnail Blob store + canvas resize to 300px WebP
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
unique), `notes?`, `hasThumbnail`, `createdAt`, `updatedAt`, `readAt?`. Timestamps are epoch milliseconds.

Storage:
- `chrome.storage.local`: `schemaVersion` -> number, and one key per record: `record:<id>` -> ReadingRecord.
  One key per record keeps concurrent writers (background vs. popup vs. options) from clobbering each other.
- IndexedDB database `read-tracker`, store `thumbnails`: record id -> WebP Blob (≤300px wide, ≤600px tall).
  `hasThumbnail` on the record mirrors whether a Blob exists.

Rules:
- `updatedAt` must change on every edit; import merge depends on it. Use `updateRecord()`, which sets it.
- Change status through `statusChange()` so `readAt` stays in step (set on read, cleared otherwise).
- `lastReadUrl` is only meaningful for prefix records and only updated while status is "reading".

### Changing the schema

1. Bump `SCHEMA_VERSION` in `src/lib/types.ts`.
2. Add `MIGRATIONS[oldVersion] = (r) => newShape` in `src/lib/migrate.ts`.
3. Update `assertRecord` in `src/lib/backup.ts` and the test fixture in `tests/fixtures.ts`.

Stored records migrate lazily on first access in each context (`ensureMigrated` in storage.ts). Backups from older
versions migrate on import; backups from newer versions are rejected.

## URL matching

- `normalizeUrl()` drops the scheme (http and https match), lowercases the host, strips `www.` and a trailing dot,
  drops `#hash`, tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, … see `TRACKING_PARAMS`), and trailing
  slashes, and sorts the remaining params. Non-http(s) URLs give `null` (not trackable).
- Exact records match when `matchKey === normalizeUrl(tabUrl)`.
- Prefix records match on a path boundary (`prefixMatches`): `site.com/a` covers `site.com/a/...` and
  `site.com/a?...`, not `site.com/abc`. An exact match beats any prefix; otherwise the longest prefix wins.

## Background worker

Listens to `tabs.onUpdated` (url change / load complete), `tabs.onActivated` and record changes in storage, then sets
badge text and color per tab: `✓` green = read, `•` orange = reading, `•` blue = unread, empty = not in the list.
It caches records in memory and drops the cache on any record change. MV3 workers are short-lived, so never keep
state there that isn't in storage.

## Permissions

`storage`, `unlimitedStorage`, `tabs` (read tab URLs for the badge), `activeTab` (screenshot and script access to the
current page while the popup is open), `scripting` (read og:image meta).
`optional_host_permissions: ["<all_urls>"]` is requested at runtime for a single origin, only when an og:image
download is blocked by CORS. Don't add install-time permissions without a strong reason.

## Conventions

- No UI library and no CSS framework. Colors come only from tokens in `styles/base.css`; add a token for both light
  and dark if you need a new color.
- Keep `src/lib` free of React. Put pure logic in its own function so it can be tested without browser APIs.
- Import browser APIs from `wxt/browser` (`browser.*`), not the global `chrome`.
- Use `<dialog>` (components/Dialog.tsx) for confirmations, never `window.confirm`.
- Ask before adding runtime dependencies. The project deliberately uses its own IndexedDB wrapper (`lib/idb.ts`).
