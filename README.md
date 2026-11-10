# Read Tracker

A Chrome extension for keeping a reading list on your own machine. No account, no server: everything is
stored in the browser.

- The toolbar badge shows whether the current page is in your list: **✓** read, **•** unread.
- Each record tracks specific pages: the badge shows when you're on one of its URLs.
- Attach up to 3 images to each record: upload files, paste an image, screenshot the tab, or use the page's
  og:image. Images are kept at full resolution; click one to view it full size.
- Group records into folders. Records start in **Home** (the default place for records without a folder); pick a
  folder when adding or editing.
- Browse everything in a full-page list with folders, **Unread / Read** tabs, search, tag filters and sorting.
- Back up to a single ZIP file (records and folders as JSON, plus the original images) and import it again later or on another machine.

## Install from source

Requires Node.js 22.12 or newer.

```sh
npm install
npm run build
```

Then load the build into Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `.output/chrome-mv3` folder in this project.
4. Optional: click the puzzle-piece icon in the toolbar and pin **Read Tracker**, so the badge is always visible.

After you rebuild, press the reload icon on the extension's card in `chrome://extensions`.

For development, `npm run dev` starts a separate Chrome window with the extension loaded and reloads it when files
change.

## Using it

- **Add a page:** click the toolbar icon, check the title, pick a folder and click **Add to list** (it starts
  unread).
- **Manage a record:** click **Manage** on its card (or in the popup) to edit its details, folder and images.
  A record can have several URLs (up to 10): use **+ Add URL** for a mirror or another site. Each URL matches
  that exact page, so the badge shows the record on any of them; the first one is the main URL. On the card, each URL is a link under the title (the title itself is not a link).
  **Delete record** is at the bottom of that dialog and asks for confirmation.
- **On a page in your list:** the popup shows **Mark read** / **Mark unread** (or **Update read** in Revisit
  folders). The folder, images, extra URLs, tags and notes are managed on the full list page.
- **View images:** click a card's image in the full list (or an image tile) to open the full-size viewer; use
  the arrow keys to step through a record's images, or **Open original** to see it in a tab.
- **Full list:** click the list icon (**Open full list**) in the popup, or right-click the toolbar icon and choose **Options**.
- **Home and folders:** the full list opens on **Home**, which holds every record that isn't in a folder. Click
  **+ New folder** to make one, and click a folder to see its records. **Manage folder** (or **Manage Home**) opens
  its settings: name, **Image size** (S / M / L / XL), **Read mode** and **Delete folder**. Home can't be renamed
  or deleted, and always uses the Status read mode. A folder can also have **Preferred domains** (e.g. `x.com`): pages you add
  from the popup on exactly that domain go into that folder by default (otherwise Home). Each domain can belong to
  only one folder. Deleting a folder keeps its records (they move to Home). Move a record by choosing a folder (or
  Home) in its **Manage** dialog or in the popup. The list remembers which place you had open. Search and filters
  apply within the open place. Filter by tag with the **Tags** chips under the search box (select several to
  narrow down; click a tag on a record to add it).
- **Read mode:** **Status** (the default) is Unread / Read: the list has Unread and Read tabs, and each row's **Mark read** / **Mark unread** button moves it to the other tab. **Revisit** is for things you come
  back to again and again: each record gets an **Update read** button (press and hold it for a second) that
  records when you last read it. The list always shows the least recently read first (never read at the top), and
  after **Update read** the record moves to the bottom to wait its turn.
- **Mark links on websites** (in **Manage folder** / **Manage Home**, off by default): while on, links on any website
  that point to records in that place are dimmed and their text glows: unread dimmed to 50% and slightly blurred with a blue
  glow, read dimmed to 20% and blurred more with a green glow. In a Revisit folder every record counts as read. Turning it on the first time asks for access to all websites; the page's links are
  matched inside the extension, but a site's own scripts could see which of its links are dimmed.
- **Backup:** in the full list, click **Backup** (top right) to open the Backup page with **Export backup** and
  **Import backup**. The export is a `.zip` with `manifest.json` (summary, folders, settings), `records.jsonl` (one
  record per line) and an `images` folder of the original files named by image id (any unzip tool can open it).
  Importing shows what the backup contains before anything is changed; when the same record exists in both places,
  the copy that was edited most recently is kept. Anything skipped (e.g. a missing image file) is listed afterwards.
  Older `.json` backups can't be imported.
- **Erase all data:** at the bottom of the Backup page. Click **Erase all data…**, then in the dialog press and hold
  **Hold to erase** for 3 seconds to delete every record, image and folder and reset Home's settings. It can't be
  undone, so export first.

## Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Your list is kept in the browser's IndexedDB with no size cap; `storage` carries a tiny "list changed" signal between the popup, list page and badge |
| `tabs` | Read the current tab's URL to update the badge |
| `activeTab` | Screenshot the page when you ask for it from the popup |
| `scripting` | Read the page's og:image tag |
| `favicon` | Show each site's icon next to its name, from the icons Chrome already has stored (no network requests) |
| Optional site access | Asked for one site at a time, only if an og:image can't be downloaded otherwise; or for all sites when you turn on **Mark links on websites** (the link script runs only while some place has it on) |

## Other scripts

```sh
npm test         # unit tests
npm run compile  # type check
npm run zip      # zip for the Chrome Web Store
```
