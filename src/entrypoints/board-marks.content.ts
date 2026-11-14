import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { getMarkingPrefs, onMarkingPrefsChanged } from '@/lib/marking-prefs';
import type { MarkingPrefs } from '@/lib/link-marks';
import {
  BOARD_BATCH,
  BOARD_ORIGINS,
  BOARD_MARK_MESSAGE,
  BOARD_QUERY_MESSAGE,
  boardForHost,
  isBoardPageRequest,
  pinkish,
  postIdOn,
  type Board,
  type BoardMarkRequest,
  type BoardPageInfo,
  type BoardQueryAnswer,
  type BoardQueryRequest,
} from '@/lib/boards';
import { onBoardsChanged } from '@/lib/changes';
import { MARK_SHOWN_CSS, MARK_TRANSITION_CSS, markCss } from '@/lib/link-marks';

/**
 * Board marking (merged from Booru explorer): on Gelbooru, Konachan and pixiv, post
 * thumbnails you have marked read are faded. The controls are in the toolbar popup, which
 * asks this script about the page, to mark the whole page, or to start marking mode
 * (thumbnail clicks mark instead of navigating; a banner shows while it is on).
 *
 * Always on: in the manifest for BOARD_ORIGINS (the popup can pause it). Post numbers are
 * read from link URLs; the
 * read history lives in the extension's IndexedDB and is asked for through the background.
 * Changes to the page: attributes on post links, one <style>, and the marking-mode banner
 * (its own closed shadow root).
 */
export default defineContentScript({
  // Always on: declared in the manifest for the board hosts (install-time host permission).
  matches: BOARD_ORIGINS,
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main() {
    // Also injected into already-open board tabs when the extension is installed or
    // reloaded (see background). One copy per page: a copy that is already here (e.g. a
    // dead one left by the previous extension instance, in the same isolated world) is
    // stopped and this one takes over.
    const handover = '__readTrackerBoards';
    const w = window as unknown as Record<string, unknown>;
    const previous = w[handover];
    if (typeof previous === 'function') previous();
    let session: { stop(): void } | undefined;
    let replaced = false;
    w[handover] = () => {
      replaced = true;
      session?.stop();
    };

    const board = boardForHost(location.hostname);
    if (!board) return;

    // Start once the prefs are known (so with dimming off nothing fades first); later
    // changes are handled inside.
    const start = (prefs: MarkingPrefs) => {
      if (session || replaced) return;
      session = startMarking(board, prefs);
    };
    try {
      void getMarkingPrefs().then(start, () => start({}));
    } catch {
      // Extension context gone (reloaded under this page).
    }
  },
});

const POST_ATTR = 'data-read-tracker-post';
const READ_ATTR = 'data-read-tracker-read';
const MARKING_ATTR = 'data-read-tracker-marking';

const idle = (fn: () => void) =>
  window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 200);

function startMarking(board: Board, initial: MarkingPrefs): { stop(): void } {
  let prefs = initial;
  let stopped = false;
  /** Ids asked about (or marked here), and the ones known to be read. */
  const seen = new Set<number>();
  const readIds = new Set<number>();
  /**
   * Anchors already looked at, with the href they had then: looked at again only when the
   * href changes (pixiv and paginated grids reuse <a> elements for other posts).
   */
  const examined = new WeakMap<Element, { href: string; post: boolean }>();
  /** Marking mode: clicking a thumbnail marks it instead of opening it. */
  let marking = false;
  /**
   * When each id was last marked here (a counter), so an answer to a question asked
   * before that mark doesn't undo it on screen.
   */
  let clock = 0;
  const markedAt = new Map<number, number>();
  const listeners = new AbortController();
  const on = { capture: true, signal: listeners.signal };

  const postIdOf = (href: string) => postIdOn(board, href, location.href);

  function stop() {
    if (stopped) return;
    stopped = true;
    listeners.abort();
    observer.disconnect();
    try {
      unsubscribe();
    } catch {
      // Extension context already gone.
    }
    style.remove();
    fade.remove();
    banner.host.remove();
    document.documentElement.removeAttribute(MARKING_ATTR);
    for (const a of document.querySelectorAll(`[${POST_ATTR}]`)) {
      a.removeAttribute(POST_ATTR);
      a.removeAttribute(READ_ATTR);
    }
  }

  async function send<T>(msg: unknown): Promise<T | undefined> {
    try {
      return (await browser.runtime.sendMessage(msg)) as T;
    } catch {
      // Stop only when the extension was reloaded or removed (this copy can't reach it any
      // more: runtime.id is gone), not on a one-off failure such as a message nobody answered.
      if (!browser.runtime?.id) stop();
      return undefined;
    }
  }

  async function ask(ids: number[]) {
    const askedAt = clock;
    for (let i = 0; i < ids.length && !stopped; i += BOARD_BATCH) {
      const chunk = ids.slice(i, i + BOARD_BATCH);
      const msg: BoardQueryRequest = { type: BOARD_QUERY_MESSAGE, site: board.key, ids: chunk };
      const answer = await send<BoardQueryAnswer>(msg);
      if (!answer || !Array.isArray(answer.read)) return;
      const read = new Set(answer.read);
      for (const id of chunk) {
        if ((markedAt.get(id) ?? -1) > askedAt) continue;
        if (read.has(id)) readIds.add(id);
        else readIds.delete(id);
      }
    }
    paintRead();
  }

  /** Find post links that appeared, tag them, and ask about the new ids. */
  function scan() {
    if (stopped) return;
    const fresh: number[] = [];
    // A post's own page: its number is in the address, not in a thumbnail link.
    const current = postIdOf(location.href);
    if (current !== null && !seen.has(current)) {
      seen.add(current);
      fresh.push(current);
    }
    for (const a of document.links) {
      const href = a.href;
      const before = examined.get(a);
      // Skip what's done, unless a post link lost its tag (another copy stopping removes them).
      if (before?.href === href && (!before.post || a.hasAttribute(POST_ATTR))) continue;
      const id = postIdOf(href);
      // A post link without a picture is a title or caption: not faded. Not remembered
      // either, since pixiv mounts a card's thumbnail over several renders.
      if (id !== null && !a.querySelector('img')) {
        if (a.getAttribute(POST_ATTR) !== String(id)) {
          a.removeAttribute(POST_ATTR);
          a.removeAttribute(READ_ATTR);
        }
        continue;
      }
      examined.set(a, { href, post: id !== null });
      if (id === null) {
        // Was a post before its href changed: it isn't one now.
        a.removeAttribute(POST_ATTR);
        a.removeAttribute(READ_ATTR);
        continue;
      }
      a.setAttribute(POST_ATTR, String(id));
      if (!seen.has(id)) {
        seen.add(id);
        fresh.push(id);
      }
    }
    paintRead();
    if (fresh.length) void ask(fresh);
  }

  function paintRead() {
    if (stopped) return;
    for (const a of document.querySelectorAll(`[${POST_ATTR}]`)) {
      if (readIds.has(Number(a.getAttribute(POST_ATTR)))) a.setAttribute(READ_ATTR, '');
      else a.removeAttribute(READ_ATTR);
    }
  }

  /** Paint first, then tell the store: a click shouldn't wait on a round trip. */
  function mark(ids: number[], read: boolean) {
    if (!ids.length) return;
    clock++;
    for (const id of ids) {
      seen.add(id);
      markedAt.set(id, clock);
      if (read) readIds.add(id);
      else readIds.delete(id);
    }
    paintRead();
    for (let i = 0; i < ids.length; i += BOARD_BATCH) {
      const msg: BoardMarkRequest = { type: BOARD_MARK_MESSAGE, site: board.key, ids: ids.slice(i, i + BOARD_BATCH), read };
      void send(msg);
    }
  }

  function pageIds(): number[] {
    const ids = new Set<number>();
    for (const a of document.querySelectorAll(`[${POST_ATTR}]`)) ids.add(Number(a.getAttribute(POST_ATTR)));
    return [...ids];
  }

  // ---------------------------------------------------------------------------
  // pixiv bookmarks: read off the page each time (never stored), so "Mark this page read"
  // leaves posts you kept alone.

  function onlyPost(el: Element, id: number) {
    for (const link of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const other = postIdOf(link.href);
      if (other !== null && other !== id) return false;
    }
    return true;
  }

  /** The card a thumbnail belongs to: the highest ancestor that is still about this one post. */
  function cardOf(anchor: Element, id: number) {
    let card = anchor;
    for (let up = 0; up < 6 && card.parentElement; up++) {
      if (!onlyPost(card.parentElement, id)) break;
      card = card.parentElement;
    }
    return card;
  }

  function drawnPink(root: Element) {
    for (const part of [root, ...root.querySelectorAll('*')]) {
      // pixiv keeps both heart states in the markup; a hidden one says nothing.
      if (part.checkVisibility && !part.checkVisibility({ checkOpacity: true })) continue;
      const cs = getComputedStyle(part);
      if (pinkish(cs.fill) || pinkish(cs.color) || pinkish(part.getAttribute('fill'))) return true;
    }
    return false;
  }

  function bookmarked(anchor: Element, id: number) {
    const card = cardOf(anchor, id);
    for (const button of card.querySelectorAll('button, [role="button"]')) {
      if (button.getAttribute('aria-pressed') === 'true' || drawnPink(button)) return true;
    }
    for (const svg of card.querySelectorAll('svg')) if (drawnPink(svg)) return true;
    return false;
  }

  function bookmarkedIds(): Set<number> {
    const held = new Set<number>();
    if (!board.bookmarks) return held;
    for (const a of document.querySelectorAll(`[${POST_ATTR}]`)) {
      const id = Number(a.getAttribute(POST_ATTR));
      if (!held.has(id) && bookmarked(a, id)) held.add(id);
    }
    return held;
  }

  // ---------------------------------------------------------------------------
  // Page styles: the read look (the same as a read record's link mark, MARK_LOOK) and the
  // marking-mode outline (colours that read on light and dark boards; base.css tokens don't
  // exist on web pages). The look is on the pictures, not
  // the link: opacity on the link makes it a stacking context, and on pixiv that put the
  // thumbnail under the card's placeholder layer (gone, not faded) and faded the title too.

  // The read look is its own <style>: the popup's dimming switch turns only it off (media
  // "not all"); marking, recording and the marking-mode outline keep working.
  const fade = document.createElement('style');
  fade.textContent = `
    [${READ_ATTR}] img { ${markCss('read')}; ${MARK_TRANSITION_CSS} }
    [${READ_ATTR}]:hover img, [${READ_ATTR}]:focus-visible img { ${MARK_SHOWN_CSS} }
  `;
  const applyPrefs = () => (fade.media = prefs.paused ? 'not all' : '');
  applyPrefs();
  document.documentElement.append(fade);
  const style = document.createElement('style');
  style.textContent = `
    html[${MARKING_ATTR}] [${POST_ATTR}] { cursor: copy; outline: 1px dashed rgba(30, 136, 255, .5); outline-offset: 2px }
    html[${MARKING_ATTR}] [${POST_ATTR}]:hover { outline: 2px solid #1e88ff }
    html[${MARKING_ATTR}] [${READ_ATTR}] { outline-color: #12b76a }
  `;
  document.documentElement.append(style);

  // ---------------------------------------------------------------------------
  // Marking mode banner: the controls are in the toolbar popup, which closes when the page
  // is clicked, so while marking mode is on the page says so and how to leave it.

  const banner = buildBanner();

  function buildBanner() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        #bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center;
          gap: 10px; padding: 8px 8px 8px 14px; border-radius: 999px; background: #1e88ff; color: #fff;
          font: 14px/1.3 system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.4); pointer-events: auto;
          max-width: calc(100vw - 32px) }
        #bar[hidden] { display: none }
        button { all: unset; cursor: pointer; padding: 4px 12px; border-radius: 999px; background: #fff;
          color: #0b4fa8; font-weight: 600 }
        button:focus-visible { outline: 2px solid #fff; outline-offset: 2px }
      </style>
      <div id="bar" role="status" hidden>
        <span>👆 Marking: click thumbnails to mark or unmark them. Esc to stop.</span>
        <button type="button" id="stop">Stop</button>
      </div>
    `;
    const bar = root.getElementById('bar')!;
    root.getElementById('stop')!.addEventListener('click', () => setMarking(false));
    document.documentElement.append(host);
    return { host, bar };
  }

  function setMarking(next: boolean) {
    marking = next;
    document.documentElement.toggleAttribute(MARKING_ATTR, marking);
    banner.bar.hidden = !marking;
  }

  // ---------------------------------------------------------------------------
  // The popup asks the content script of the active tab (tabs.sendMessage).

  function pageInfo(): BoardPageInfo {
    const ids = pageIds();
    // Walks the board's markup, so only when the popup asks.
    const kept = bookmarkedIds();
    return {
      posts: ids.length,
      read: ids.filter((id) => readIds.has(id)).length,
      kept: kept.size,
      left: ids.filter((id) => !readIds.has(id) && !kept.has(id)).length,
      marking,
    };
  }

  const onMessage: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (msg, sender, sendResponse) => {
    if (stopped || sender.id !== browser.runtime.id || !isBoardPageRequest(msg)) return;
    if (msg.action === 'mark-page') {
      // Bookmarked posts were kept on purpose: a sweep over the page leaves them alone.
      const kept = bookmarkedIds();
      mark(
        pageIds().filter((id) => !kept.has(id)),
        true,
      );
    }
    // The page is done (nothing left to mark): the same button unmarks every read post on it.
    if (msg.action === 'unmark-page') mark(pageIds().filter((id) => readIds.has(id)), false);
    if (msg.action === 'marking') setMarking(msg.on);
    sendResponse(pageInfo());
  };
  browser.runtime.onMessage.addListener(onMessage);
  listeners.signal.addEventListener('abort', () => {
    try {
      browser.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Extension context already gone.
    }
  });

  // ---------------------------------------------------------------------------
  // Marking mode: a thumbnail is a checkbox, so the board's navigation is stopped on the
  // way down (by the time a bubbling handler sees the click the tab is opening).

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!marking || !(e.target instanceof Element) || !e.target.closest(`[${POST_ATTR}]`)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    on,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!marking || !(e.target instanceof Element)) return;
      const anchor = e.target.closest(`[${POST_ATTR}]`);
      if (!anchor) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(anchor.getAttribute(POST_ATTR));
      mark([id], !readIds.has(id));
    },
    on,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !marking) return;
      setMarking(false);
    },
    on,
  );

  // Boards append posts (pagination, pixiv's SPA), so rescan on DOM changes, when idle.
  let rescanQueued = false;
  const observer = new MutationObserver(() => {
    if (rescanQueued) return;
    rescanQueued = true;
    idle(() => {
      rescanQueued = false;
      scan();
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });

  // Read history changed (another tab, the Boards page, an import): ask again for everything seen.
  const unsubscribe = onBoardsChanged(() => {
    if (seen.size) void ask([...seen]);
  });

  // Dimming switched off / on in the popup: only the read look changes.
  const unsubscribePrefs = onMarkingPrefsChanged((next) => {
    if (stopped) return;
    prefs = next;
    applyPrefs();
  });
  listeners.signal.addEventListener('abort', () => {
    try {
      unsubscribePrefs();
    } catch {
      // Extension context already gone.
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, on);
  scan();
  return { stop };
}
