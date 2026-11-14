import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { HoldButton } from '@/components/HoldButton';
import { markBoardReads, onBoardsChanged, queryBoardReads } from '@/lib/board-store';
import { BOARD_PAGE_MESSAGE, postIdOn, type Board, type BoardPageInfo, type BoardPageRequest } from '@/lib/boards';

/** "Mark page read" / "Unmark page" are held, not clicked: one slip changes a whole page. */
const HOLD_PAGE_MS = 600;

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
 * and marking mode (dimming on / off is the popup header's switch). Post state comes from IndexedDB directly; the page's own
 * thumbnails (counts, bookmarks, marking mode) from the board script in the tab.
 */
export function BoardPanel({ board, tabId, url }: { board: Board; tabId: number; url: string }) {
  /** The open post's state (null when this isn't a post page). */
  const [post, setPost] = useState<{ id: number; read: boolean } | null>();
  /** undefined = the board script didn't answer (the page needs a reload). */
  const [page, setPage] = useState<BoardPageInfo>();
  const postId = postIdOn(board, url);

  useEffect(() => {
    const loadPost = async () => {
      if (postId === null) return setPost(null);
      const { read } = await queryBoardReads(board.key, [postId]);
      setPost({ id: postId, read: read.length > 0 });
    };
    // The script repaints on the same change signal; a short wait lets it catch up first.
    const loadPage = () => void askPage(tabId, { type: BOARD_PAGE_MESSAGE, action: 'info' }).then(setPage);
    void loadPost();
    loadPage();
    const offBoards = onBoardsChanged(() => {
      void loadPost();
      setTimeout(loadPage, 150);
    });
    return () => {
      offBoards();
    };
  }, [board.key, postId, tabId]);

  /** Every post "Mark page read" would mark is read (an older page script sends no `left`). */
  const pageDone = !!page && page.read > 0 && page.left === 0;
  const share = page?.posts ? Math.round((page.read / page.posts) * 100) : 0;

  return (
    <section className="booru" aria-label={`Booru marking on ${board.label}`}>
      <div className="booru-head">
        <span className="booru-tag">Booru</span>
        <span className="booru-site">{board.label}</span>
      </div>

      <>
        {post && (
          <div className="booru-post">
            <span className="booru-post-id">
              Post <strong>{post.id}</strong>
            </span>
            <span className={`booru-pill ${post.read ? 'is-read' : 'is-unread'}`}>
              {post.read ? 'Read' : 'Not read'}
            </span>
          </div>
        )}
        {post && (
          <button
            type="button"
            className={`btn popup-main-action${post.read ? '' : ' btn-primary'}`}
            onClick={async () => {
              await markBoardReads(board.key, [post.id], !post.read);
              setPost({ ...post, read: !post.read });
            }}
          >
            {post.read ? 'Mark post unread' : 'Mark post read'}
          </button>
        )}

        <div className="board-actions">
          {/* Nothing left to mark (6 / 6, bookmarks aside): the same button unmarks the page. */}
          <HoldButton
            key={pageDone ? 'unmark' : 'mark'}
            className="btn"
            holdMs={HOLD_PAGE_MS}
            disabled={!page?.posts}
            title={
              pageDone
                ? 'Press and hold: unmark every read post on this page'
                : page?.kept
                  ? `Press and hold: mark every post on this page read (${page.kept} bookmarked left alone)`
                  : 'Press and hold: mark every post on this page read'
            }
            hintLabel="Hold…"
            doneLabel={pageDone ? 'Unmarked ✓' : 'Marked ✓'}
            onConfirm={async () =>
              setPage(
                await askPage(tabId, { type: BOARD_PAGE_MESSAGE, action: pageDone ? 'unmark-page' : 'mark-page' }),
              )
            }
          >
            {pageDone ? 'Unmark page' : 'Mark page read'}
          </HoldButton>
          <button
            type="button"
            className={`btn${page?.marking ? ' btn-primary' : ''}`}
            disabled={!page}
            title="Clicking thumbnails marks or unmarks them instead of opening them (Esc stops)"
            onClick={async () => {
              const on = !page?.marking;
              const next = await askPage(tabId, {
                type: BOARD_PAGE_MESSAGE,
                action: 'marking',
                on,
              });
              setPage(next);
              // Marking happens on the page: get out of the way.
              if (on && next?.marking) window.close();
            }}
          >
            {page?.marking ? 'Stop marking' : 'Click to mark'}
          </button>
        </div>

        {!page ? (
          <p className="booru-note">Reload the page to mark its posts.</p>
        ) : page.posts === 0 ? (
          <p className="booru-note">No post thumbnails on this page.</p>
        ) : (
          <div className="booru-progress">
            <div
              className="booru-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={page.posts}
              aria-valuenow={page.read}
              aria-label="Read on this page"
            >
              <span style={{ width: `${share}%` }} />
            </div>
            <span className="booru-count">
              {page.read} / {page.posts} read
              {board.bookmarks && page.kept ? ` · ${page.kept} bookmarked` : ''}
            </span>
          </div>
        )}
      </>

    </section>
  );
}
