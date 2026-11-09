# Read Tracker

A Chrome extension for keeping a reading list on your own machine. No account, no server: everything is
stored in the browser.

- The toolbar badge shows whether the current page is in your list: **✓** read, **•** unread or reading.
- Track a single page, or a whole series with a URL prefix (for example every chapter under
  `site.com/novel/abc/`). While a series is marked "reading", the extension remembers the last chapter you opened.
- Attach up to 3 images to each record: upload files, paste an image, screenshot the tab, or use the page's
  og:image. Images are kept at full resolution; click one to view it full size.
- Group records into folders. Records start in **Home** (the default place for records without a folder); pick a
  folder when adding or editing.
- Browse everything in a full-page list with folders, search, status and tag filters, and sorting.
- Back up to a single JSON file (original images included) and import it again later or on another machine.

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

- **Add a page:** click the toolbar icon, check the title, choose **This page** or **Series (prefix)**, pick a
  status and click **Add current page**.
- **Manage a record:** click **Manage** on its card (or in the popup) to edit its details, folder and images.
  A record can have several URLs (up to 10): use **+ Add URL** for a mirror or the same series on another site.
  Each URL matches on its own (this page, or a series prefix), so the badge shows the record on any of them; the
  first one is the main URL that the title opens.
  **Delete record** is at the bottom of that dialog and asks for confirmation.
- **Change status, folder or images:** open the popup on a page that is in your list.
- **View images:** click a card's image in the full list (or an image tile) to open the full-size viewer; use
  the arrow keys to step through a record's images, or **Open original** to see it in a tab.
- **Full list:** click **Open full list** in the popup, or right-click the toolbar icon and choose **Options**.
- **Home and folders:** the full list opens on **Home**, which holds every record that isn't in a folder. Click
  **+ New folder** to make one, and click a folder to see its records. **Manage folder** (or **Manage Home**) opens
  its settings: name, **Image size** (S / M / L / XL), **Read mode** and **Delete folder**. Home can't be renamed
  or deleted. Deleting a folder keeps its records (they move to Home). Move a record by choosing a folder (or
  Home) in its **Manage** dialog or in the popup. The list remembers which place you had open. Search and filters
  apply within the open place.
- **Read mode:** **Status** (the default) is the usual unread / reading / read. **Revisit** is for things you come
  back to again and again: each record gets an **Update read** button (press and hold it for a second) that
  records when you last read it. The list always shows the least recently read first (never read at the top), and
  after **Update read** the record moves to the bottom to wait its turn.
- **Backup:** in the full list, use **Export JSON** and **Import JSON** at the bottom. When the same record exists
  in both places, the copy that was edited most recently is kept.

## Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Your list is kept in the browser's IndexedDB with no size cap; `storage` carries a tiny "list changed" signal between the popup, list page and badge |
| `tabs` | Read the current tab's URL to update the badge |
| `activeTab` | Screenshot the page when you ask for it from the popup |
| `scripting` | Read the page's og:image tag |
| `favicon` | Show each site's icon next to its name, from the icons Chrome already has stored (no network requests) |
| Optional site access | Asked for one site at a time, only if an og:image can't be downloaded otherwise |

## Other scripts

```sh
npm test         # unit tests
npm run compile  # type check
npm run zip      # zip for the Chrome Web Store
```
