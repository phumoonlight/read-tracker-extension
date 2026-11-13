import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { HoldButton } from '@/components/HoldButton';
import { getBoardPrefs, onBoardPrefsChanged, updateBoardPrefs } from '@/lib/board-prefs';
import { markBoardReads, onBoardsChanged, queryBoardReads } from '@/lib/board-store';
import {
  BOARD_PAGE_MESSAGE,
  postIdOn,
  type Board,
  type BoardPageInfo,
  type BoardPageRequest,
  type BoardPrefs,
} from '@/lib/boards';

/** "Mark this page read" is held, not clicked: it is the one action repeating can't undo. */
const HOLD_PAGE_MS = 600;

const openBoards = () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/boards.html') });
  window.close();
};

/** Ask the board script in the tab; undefined when it isn't running there (yet). */
async function askPage(tabId: number, req: BoardPageRequest): Promise<BoardPageInfo | undefined> {
  try {
    return ((await browser.tabs.sendMessage(tabId, req)) as BoardPageInfo | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Board marking controls, at the top of the popup on a board page (what the 📖 dock on
 * the page used to be): the open post's state, mark it, hold to mark the whole page,
 * marking mode, and pausing. Post state comes from IndexedDB directly; the page's own
 * thumbnails (counts, bookmarks, marking mode) from the board script in the tab.
 */
export function BoardPanel({ board, tabId, url }: { board: Board; tabId: number; url: string }) {
  const [prefs, setPrefs] = useState<BoardPrefs>();
  /** The open post's state (null when this isn't a post page). */
  const [post, setPost] = useState<{ id: number; read: boolean; floor: number } | null>();
  /** undefined = the board script didn't answer (marking off, or the page needs a reload). */
  const [page, setPage] = useState<BoardPageInfo>();
  const postId = postIdOn(board, url);

  useEffect(() => {
    const loadPost = async () => {
      if (postId === null) return setPost(null);
      const { read, floor } = await queryBoardReads(board.key, [postId]);
      setPost({ id: postId, read: read.length > 0, floor });
    };
    // The script repaints on the same change signal; a short wait lets it catch up first.
    const loadPage = () => void askPage(tabId, { type: BOARD_PAGE_MESSAGE, action: 'info' }).then(setPage);
    void getBoardPrefs().then(setPrefs);
    void loadPost();
    loadPage();
    const offPrefs = onBoardPrefsChanged((p) => {
      setPrefs(p);
      loadPage();
    });
    const offBoards = onBoardsChanged(() => {
      void loadPost();
      setTimeout(loadPage, 150);
    });
    return () => {
      offPrefs();
      offBoards();
    };
  }, [board.key, postId, tabId]);

  if (!prefs) return null;

  if (!prefs.enabled) {
    return (
      <div className="popup-body board-panel">
        <div className="board-panel-off">
          <span className="muted">{board.label}: board marking is off.</span>
          <button type="button" className="link-button" onClick={openBoards}>
            Turn on
          </button>
        </div>
      </div>
    );
  }

  const paused = !!prefs.paused;
  const floored = !!post && post.id <= post.floor;

  return (
    <div className="popup-body board-panel">
      <div className="board-panel-head">
        <span className={`board-post-state${post ? (post.read || floored ? ' is-read' : ' is-unread') : ''}`}>
          {post
            ? floored
              ? `${board.label} post ${post.id}: read (up to ${post.floor.toLocaleString()})`
              : `${board.label} post ${post.id}: ${post.read ? 'read' : 'not read'}`
            : board.label}
        </span>
        <button
          type="button"
          className="btn btn-small board-pause"
          aria-pressed={!paused}
          title={paused ? 'Read marking is off: nothing is faded or recorded' : 'Turn read marking off on boards'}
          onClick={() => void updateBoardPrefs({ paused: !paused })}
        >
          Read marking: {paused ? 'off' : 'on'}
        </button>
      </div>

      {post && (
        <button
          type="button"
          className={`btn popup-main-action${post.read ? '' : ' btn-primary'}`}
          disabled={paused || floored}
          onClick={async () => {
            await markBoardReads(board.key, [post.id], !post.read);
            setPost({ ...post, read: !post.read });
          }}
        >
          {post.read ? 'Mark this post unread' : 'Mark this post read'}
        </button>
      )}

      <div className="board-actions">
        <HoldButton
          className="btn"
          holdMs={HOLD_PAGE_MS}
          disabled={paused || !page?.posts}
          title={
            page?.kept
              ? `Press and hold to mark every post on this page read (${page.kept} bookmarked left alone)`
              : 'Press and hold to mark every post on this page read'
          }
          hintLabel="Hold to mark"
          doneLabel="Marked ✓"
          onConfirm={async () => setPage(await askPage(tabId, { type: BOARD_PAGE_MESSAGE, action: 'mark-page' }))}
        >
          Mark this page read
        </HoldButton>
        <button
          type="button"
          className={`btn${page?.marking ? ' btn-primary' : ''}`}
          disabled={paused || !page}
          title="Clicking thumbnails marks or unmarks them instead of opening them (Esc to stop)"
          onClick={async () => {
            const on = !page?.marking;
            const next = await askPage(tabId, { type: BOARD_PAGE_MESSAGE, action: 'marking', on });
            setPage(next);
            // Marking happens on the page: get out of the way.
            if (on && next?.marking) window.close();
          }}
        >
          {page?.marking ? 'Stop marking' : 'Start marking'}
        </button>
      </div>

      <div className="board-panel-foot">
        <span className="muted">
          {paused
            ? 'Nothing is faded or recorded.'
            : !page
              ? 'Reload the page to mark its posts.'
              : page.posts === 0
                ? 'No post thumbnails on this page.'
                : `${page.read} of ${page.posts} read here` +
                  (board.bookmarks ? (page.kept ? `, ${page.kept} bookmarked (left alone).` : ', none bookmarked.') : '.')}
        </span>
        <button type="button" className="link-button" onClick={openBoards}>
          Boards
        </button>
      </div>
    </div>
  );
}
