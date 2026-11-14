import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/Dialog';
import { getMarkingPrefs, onMarkingPrefsChanged, updateMarkingPrefs } from '@/lib/marking-prefs';
import type { MarkingPrefs } from '@/lib/link-marks';
import { boardStats, clearBoard, onBoardsChanged, type BoardStat } from '@/lib/board-store';
import { BOARDS, type Board, type BoardKey } from '@/lib/boards';

type Message = { text: string; error?: boolean };

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Boards page (boards.html, titled "Booru", opened from the list page header): whether dimming
 * is off, and what is stored per board (with Clear). Board history moves between browsers
 * with the ZIP backup.
 */
export function App() {
  const [prefs, setPrefs] = useState<MarkingPrefs>();
  const [stats, setStats] = useState<Record<BoardKey, BoardStat>>();
  const [tableMsg, setTableMsg] = useState<Message>();
  const [clearing, setClearing] = useState<Board>();

  useEffect(() => {
    const loadStats = () => boardStats().then(setStats, () => setStats(undefined));
    void getMarkingPrefs().then(setPrefs);
    void loadStats();
    const offPrefs = onMarkingPrefsChanged(setPrefs);
    const offBoards = onBoardsChanged(() => void loadStats());
    return () => {
      offPrefs();
      offBoards();
    };
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <a className="back-link" href="/options.html">
          ← Reading list
        </a>
        <h1>Booru</h1>
        <p className="muted">Read posts on {BOARDS.map((b) => b.label).join(', ')}. Read thumbnails are faded.</p>
      </header>

      {prefs?.paused && (
        <div className="board-paused" role="status">
          <span>Dimming is off: read posts aren't faded on boards (marking still works).</span>
          <button type="button" className="btn btn-primary" onClick={() => void updateMarkingPrefs({ paused: false })}>
            Turn on
          </button>
        </div>
      )}

      <section className="backup-section">
        <h2>Read posts</h2>
        <div className="board-table-wrap">
          <table className="board-table">
            <thead>
              <tr>
                <th>Board</th>
                <th className="n">Posts</th>
                <th className="n">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {BOARDS.map((b) => {
                const s = stats?.[b.key] ?? { posts: 0, bytes: 0 };
                return (
                  <tr key={b.key}>
                    <td>{b.label}</td>
                    <td className="n">{s.posts ? s.posts.toLocaleString() : '—'}</td>
                    <td className="n muted">{s.posts ? bytes(s.bytes) : ''}</td>
                    <td className="n">
                      {/* Hidden, not removed, so every row keeps the same height. */}
                      <button
                        type="button"
                        className="btn btn-small"
                        style={s.posts ? undefined : { visibility: 'hidden' }}
                        onClick={() => setClearing(b)}
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tableMsg && <span className={tableMsg.error ? 'error' : 'muted'}>{tableMsg.text}</span>}
      </section>

      <details className="board-help">
        <summary>How to mark posts</summary>
        <ul>
          <li>Open the toolbar popup on a board page: the Booru card is on top.</li>
          <li>
            <strong>Mark post read</strong> on a post's page, or hold <strong>Mark page read</strong> for the whole
            listing (pixiv bookmarks are skipped). Once everything is read it becomes <strong>Unmark page</strong>.
          </li>
          <li>
            <strong>Click to mark</strong>, then click thumbnails to mark or unmark them. Esc stops.
          </li>
          <li>
            The popup's <strong>Dim</strong> switch turns the fading off on every website; marking still works.
          </li>
          <li>The toolbar badge shows ✓ on a read post.</li>
          <li>
            Board history is in the <a href="/backup.html">ZIP backup</a>.
          </li>
        </ul>
      </details>

      {clearing && (
        <ConfirmDialog
          title={`Clear ${clearing.label}?`}
          message={`Forgets every read post on ${clearing.label}. This can't be undone.`}
          confirmLabel="Clear"
          onClose={() => setClearing(undefined)}
          onConfirm={async () => {
            try {
              await clearBoard(clearing.key);
              setTableMsg({ text: `${clearing.label} cleared.` });
            } catch (e) {
              setTableMsg({ text: `Failed: ${e instanceof Error ? e.message : e}`, error: true });
            }
          }}
        />
      )}
    </div>
  );
}
