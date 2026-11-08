# Read Tracker

A Chrome extension for keeping a reading list on your own machine. No account, no server: everything is
stored in the browser.

- The toolbar badge shows whether the current page is in your list: **✓** read, **•** unread or reading.
- Track a single page, or a whole series with a URL prefix (for example every chapter under
  `site.com/novel/abc/`). While a series is marked "reading", the extension remembers the last chapter you opened.
- Give each record a thumbnail: upload a file, paste an image, screenshot the tab, or use the page's og:image.
- Browse everything in a full-page list with search, status and tag filters, and sorting.
- Back up to a single JSON file (thumbnails included) and import it again later or on another machine.

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
- **Change status or thumbnail:** open the popup on a page that is in your list.
- **Full list:** click **Open full list** in the popup, or right-click the toolbar icon and choose **Options**.
- **Backup:** in the full list, use **Export JSON** and **Import JSON** at the bottom. When the same record exists
  in both places, the copy that was edited most recently is kept.

## Permissions

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Save your list locally without the 10 MB cap |
| `tabs` | Read the current tab's URL to update the badge |
| `activeTab` | Screenshot the page when you ask for it from the popup |
| `scripting` | Read the page's og:image tag |
| Optional site access | Asked for one site at a time, only if an og:image can't be downloaded otherwise |

## Other scripts

```sh
npm test         # unit tests
npm run compile  # type check
npm run zip      # zip for the Chrome Web Store
```
