import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { getBoardPrefs, onBoardPrefsChanged, updateBoardPrefs } from '@/lib/board-prefs';
import {
  BOARD_BATCH,
  BOARD_MARK_MESSAGE,
  BOARD_QUERY_MESSAGE,
  boardForHost,
  OPEN_BOARDS_MESSAGE,
  pinkish,
  postIdOn,
  type Board,
  type BoardMarkRequest,
  type BoardPrefs,
  type BoardQueryAnswer,
  type BoardQueryRequest,
} from '@/lib/boards';
import { onBoardsChanged } from '@/lib/changes';

/**
 * Board marking (merged from Booru explorer): on Gelbooru, Konachan and pixiv, post
 * thumbnails you have marked read are faded, and a 📖 dock at the bottom of the page marks
 * a whole page (hold), the open post, or thumbnails one by one (marking mode).
 *
 * Registered by the background at runtime (never in the manifest) while board marking is
 * on and the board host permission is granted. Post numbers are read from link URLs; the
 * read history lives in the extension's IndexedDB and is asked for through the background.
 * Changes to the page: attributes on post links, one <style>, and the dock (its own closed
 * shadow root).
 */
export default defineContentScript({
  registration: 'runtime',
  noScriptStartedPostMessage: true,
  main() {
    // Injected again into already-open tabs when marking is turned on: run once per page.
    const flag = '__readTrackerBoards';
    const w = window as unknown as Record<string, boolean>;
    if (w[flag]) return;
    w[flag] = true;

    const board = boardForHost(location.hostname);
    if (!board) return;

    let session: { stop(): void } | undefined;
    /** Set once a change event arrives: the first read may then be older than it. */
    let changed = false;
    const apply = (prefs: BoardPrefs) => {
      if (prefs.enabled && !session) session = startMarking(board, prefs);
      else if (!prefs.enabled && session) {
        session.stop();
        session = undefined;
      }
    };
    try {
      onBoardPrefsChanged((prefs) => {
        changed = true;
        apply(prefs);
      });
      void getBoardPrefs().then((prefs) => !changed && apply(prefs), () => {});
    } catch {
      // Extension context gone (reloaded under this page).
    }
  },
});

const POST_ATTR = 'data-read-tracker-post';
const READ_ATTR = 'data-read-tracker-read';
const MARKING_ATTR = 'data-read-tracker-marking';
const HOLD_PAGE_MS = 600;

const idle = (fn: () => void) =>
  window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 200);

function startMarking(board: Board, initial: BoardPrefs): { stop(): void } {
  let prefs = initial;
  let stopped = false;
  /** Ids asked about (or marked here), and the ones known to be read. */
  const seen = new Set<number>();
  const readIds = new Set<number>();
  /**
   * Anchors already looked at, with the href they had then: looked at again only when the
   * href changes (pixiv and paginated grids reuse <a> elements for other posts).
   */
  const examined = new WeakMap<Element, string>();
  /** Marking mode: clicking a thumbnail marks it instead of opening it. */
  let marking = false;
  /** Everything at or below it is read (set on the Boards page). */
  let floor = 0;
  /**
   * When each id was last marked here (a counter), so an answer to a question asked
   * before that mark doesn't undo it on screen.
   */
  let clock = 0;
  const markedAt = new Map<number, number>();
  const listeners = new AbortController();
  const on = { capture: true, signal: listeners.signal };

  const postIdOf = (href: string) => postIdOn(board, href, location.href);
  const active = () => !prefs.paused;

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
    dock.host.remove();
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
      floor = Number.isSafeInteger(answer.floor) ? answer.floor : 0;
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
      if (examined.get(a) === href) continue;
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
      examined.set(a, href);
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
      if (active() && readIds.has(Number(a.getAttribute(POST_ATTR)))) a.setAttribute(READ_ATTR, '');
      else a.removeAttribute(READ_ATTR);
    }
    repaintDock();
  }

  /** Paint first, then tell the store: a click shouldn't wait on a round trip. */
  function mark(ids: number[], read: boolean) {
    // Under the floor nothing can be unmarked (there is no record to remove).
    if (!read) ids = ids.filter((id) => id > floor);
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
  // Page styles: the fade and the marking-mode outline (colours that read on light and
  // dark boards; base.css tokens don't exist on web pages).

  const style = document.createElement('style');
  style.textContent = `
    [${READ_ATTR}] { opacity: .28 !important; transition: opacity .15s ease }
    [${READ_ATTR}]:hover { opacity: .5 !important }
    html[${MARKING_ATTR}] [${POST_ATTR}] { cursor: copy; outline: 1px dashed rgba(30, 136, 255, .5); outline-offset: 2px }
    html[${MARKING_ATTR}] [${POST_ATTR}]:hover { outline: 2px solid #1e88ff }
    html[${MARKING_ATTR}] [${READ_ATTR}] { outline-color: #12b76a }
  `;
  document.documentElement.append(style);

  // ---------------------------------------------------------------------------
  // The dock: one button at the bottom of the page and the menu it opens. Left by
  // default; drag it to the right (which side is out of the way depends on the board).

  const dock = buildDock();

  function buildDock() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        #dock { position: fixed; bottom: 18px; display: flex; flex-direction: column; align-items: flex-start;
          gap: 8px; pointer-events: auto; font: 13px/1.4 system-ui, sans-serif; color: #e6e6ea }
        #dock.right { align-items: flex-end }
        #fab { all: unset; box-sizing: border-box; width: 44px; height: 44px; display: grid; place-items: center;
          font-size: 20px; border-radius: 50%; background: #14141a; cursor: grab; touch-action: none;
          box-shadow: 0 0 0 1px rgba(255,255,255,.18), 0 8px 24px rgba(0,0,0,.5) }
        #fab:active { cursor: grabbing }
        #fab:focus-visible { outline: 2px solid #1e88ff; outline-offset: 2px }
        #fab.on { background: #1e88ff; box-shadow: 0 0 0 1px #1e88ff, 0 10px 28px rgba(30,136,255,.5) }
        #fab.off { opacity: .45 }
        #menu { min-width: 236px; padding: 6px; border-radius: 10px; background: #14141a;
          box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 18px 48px rgba(0,0,0,.6) }
        #menu[hidden] { display: none }
        .item { all: unset; box-sizing: border-box; position: relative; overflow: hidden; display: flex;
          align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border-radius: 7px; cursor: pointer }
        .item:hover, .item:focus-visible { background: #22222c; color: #fff }
        .item[disabled] { opacity: .35; cursor: default }
        .item[disabled]:hover { background: transparent; color: #e6e6ea }
        .fill { position: absolute; inset: 0 auto 0 0; width: 0; background: rgba(30,136,255,.4); pointer-events: none }
        .item.holding .fill { width: 100%; transition: width ${HOLD_PAGE_MS}ms linear }
        .label { position: relative }
        .state { position: relative; margin-left: auto; font-size: 11px; opacity: .55; letter-spacing: .04em }
        #status { display: flex; align-items: center; gap: 8px; padding: 7px 10px 8px; font-size: 11px;
          letter-spacing: .04em; opacity: .6 }
        #status.read { color: #12b76a; opacity: 1 }
        #status[hidden], #note[hidden] { display: none }
        #note { padding: 5px 10px 6px; font-size: 11px; opacity: .55 }
      </style>
      <div id="dock">
        <div id="menu" hidden>
          <div id="status" hidden><span id="status-mark" aria-hidden="true"></span><span id="status-text"></span></div>
          <button class="item" id="all">
            <span class="fill"></span>
            <span class="label" aria-hidden="true">📚</span>
            <span class="label">Mark this page read</span>
            <span class="state">hold</span>
          </button>
          <button class="item" id="one"><span aria-hidden="true">✅</span><span id="one-label">Mark this post read</span></button>
          <button class="item" id="pick"><span aria-hidden="true">👆</span><span id="pick-label">Start marking</span></button>
          <button class="item" id="power">
            <span aria-hidden="true">👁️</span><span>Read marking</span><span class="state" id="power-state">on</span>
          </button>
          <button class="item" id="settings"><span aria-hidden="true">⚙️</span><span>Boards page</span></button>
          <div id="note"></div>
        </div>
        <button id="fab" aria-label="Read Tracker: board marking" title="Read Tracker: board marking">📖</button>
      </div>
    `;
    const part = <T extends HTMLElement = HTMLElement>(id: string) => root.getElementById(id) as T;
    document.documentElement.append(host);
    return {
      host,
      dock: part('dock'),
      fab: part('fab'),
      menu: part('menu'),
      all: part<HTMLButtonElement>('all'),
      one: part<HTMLButtonElement>('one'),
      oneLabel: part('one-label'),
      pick: part<HTMLButtonElement>('pick'),
      pickLabel: part('pick-label'),
      power: part<HTMLButtonElement>('power'),
      powerState: part('power-state'),
      settings: part<HTMLButtonElement>('settings'),
      status: part('status'),
      statusMark: part('status-mark'),
      statusText: part('status-text'),
      note: part('note'),
    };
  }

  const menuOpen = () => !dock.menu.hidden;
  const closeMenu = () => {
    dock.menu.hidden = true;
  };

  function repaintDock() {
    if (stopped) return;
    const right = prefs.side === 'right';
    dock.dock.classList.toggle('right', right);
    dock.dock.style.left = right ? 'auto' : '18px';
    dock.dock.style.right = right ? '18px' : 'auto';
    dock.fab.classList.toggle('on', marking);
    dock.fab.classList.toggle('off', !active());
    dock.pickLabel.textContent = marking ? 'Stop marking' : 'Start marking';
    dock.powerState.textContent = active() ? 'on' : 'off';
    dock.pick.disabled = !active();
    dock.all.disabled = !active();

    // On a post's own page there is one post to mark; say what it is, above what the button would do.
    const current = postIdOf(location.href);
    const currentRead = current !== null && readIds.has(current);
    const floored = current !== null && current <= floor;
    dock.one.disabled = !active() || current === null || floored;
    dock.oneLabel.textContent = currentRead ? 'Mark this post unread' : 'Mark this post read';
    dock.status.hidden = current === null;
    dock.status.classList.toggle('read', currentRead);
    if (current !== null) {
      dock.statusMark.textContent = currentRead ? '✅' : '👁️';
      dock.statusText.textContent = floored
        ? `Post ${current}: read (up to ${floor.toLocaleString()})`
        : `Post ${current}: ${currentRead ? 'read' : 'not read'}`;
    }

    const ids = pageIds();
    const read = ids.filter((id) => readIds.has(id)).length;
    // Counting bookmarks walks the board's markup, so only while the menu is open.
    const kept = menuOpen() && board.bookmarks ? bookmarkedIds().size : 0;
    dock.note.textContent = !active()
      ? 'Read marking is off: nothing is faded or recorded.'
      : ids.length === 0
        ? current === null
          ? 'No posts on this page.'
          : ''
        : !board.bookmarks
          ? `${read} of ${ids.length} read on this page.`
          : kept === 0
            ? `${read} of ${ids.length} read here, none bookmarked.`
            : `${read} of ${ids.length} read here. ${kept} bookmarked, which 📚 leaves alone.`;
    dock.note.hidden = dock.note.textContent === '';
  }

  function setMarking(next: boolean) {
    marking = next && active();
    document.documentElement.toggleAttribute(MARKING_ATTR, marking);
    repaintDock();
  }

  // Fab: a drag and a click are the same gesture until the pointer moves.
  let drag: { x: number; moved: boolean } | null = null;
  dock.fab.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, moved: false };
    dock.fab.setPointerCapture(e.pointerId);
  });
  dock.fab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 6) drag.moved = true;
    if (!drag.moved) return;
    closeMenu();
    dock.dock.style.left = `${Math.round(e.clientX - 22)}px`;
    dock.dock.style.right = 'auto';
  });
  dock.fab.addEventListener('pointerup', (e) => {
    const gesture = drag;
    drag = null;
    if (!gesture) return;
    if (gesture.moved) {
      prefs = { ...prefs, ...(e.clientX > innerWidth / 2 ? { side: 'right' } : { side: undefined }) };
      repaintDock();
      void updateBoardPrefs({ side: e.clientX > innerWidth / 2 ? 'right' : 'left' }).catch(() => {});
      return;
    }
    dock.menu.hidden = !dock.menu.hidden;
    repaintDock();
  });
  // Keyboard: Enter / Space on the fab (pointer events don't fire for those).
  dock.fab.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    dock.menu.hidden = !dock.menu.hidden;
    repaintDock();
  });

  // A whole page is the one action repeating can't undo, so it is held, not clicked.
  let holding: ReturnType<typeof setTimeout> | undefined;
  const startHold = () => {
    if (dock.all.disabled) return;
    dock.all.classList.add('holding');
    holding = setTimeout(() => {
      dock.all.classList.remove('holding');
      const kept = bookmarkedIds();
      mark(
        pageIds().filter((id) => !kept.has(id)),
        true,
      );
      closeMenu();
      repaintDock();
    }, HOLD_PAGE_MS);
  };
  const cancelHold = () => {
    clearTimeout(holding);
    dock.all.classList.remove('holding');
  };
  dock.all.addEventListener('pointerdown', startHold);
  dock.all.addEventListener('pointerup', cancelHold);
  dock.all.addEventListener('pointerleave', cancelHold);
  dock.all.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  });
  dock.all.addEventListener('keyup', cancelHold);

  dock.one.addEventListener('click', () => {
    const current = postIdOf(location.href);
    if (current !== null) mark([current], !readIds.has(current));
  });
  dock.pick.addEventListener('click', () => {
    setMarking(!marking);
    closeMenu();
  });
  dock.power.addEventListener('click', () => {
    const paused = active();
    prefs = { ...prefs, ...(paused ? { paused: true } : { paused: undefined }) };
    if (paused) setMarking(false);
    paintRead();
    void updateBoardPrefs({ paused }).catch(() => {});
  });
  dock.settings.addEventListener('click', () => {
    void send({ type: OPEN_BOARDS_MESSAGE });
    closeMenu();
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
      if (e.key !== 'Escape') return;
      if (marking) setMarking(false);
      closeMenu();
    },
    on,
  );
  // A click anywhere else closes the menu (events from the shadow root are retargeted to the host).
  document.addEventListener(
    'mousedown',
    (e) => {
      if (menuOpen() && e.target !== dock.host) {
        closeMenu();
        repaintDock();
      }
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

  // Paused / dock side changed elsewhere (enabled is handled by main()).
  const unsubscribePrefs = onBoardPrefsChanged((next) => {
    if (stopped || !next.enabled) return;
    prefs = next;
    if (!active()) setMarking(false);
    paintRead();
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
