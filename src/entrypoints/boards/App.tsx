import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { describeIssues } from '@/lib/backup';
import { getBoardPrefs, onBoardPrefsChanged, updateBoardPrefs } from '@/lib/board-prefs';
import {
  boardStats,
  clearBoard,
  countUnderFloor,
  importBoardReads,
  onBoardsChanged,
  setBoardFloor,
  type BoardStat,
} from '@/lib/board-store';
import { BOARDS, boardPostCount, parseBoardFile, type Board, type BoardFile, type BoardKey, type BoardPrefs } from '@/lib/boards';
import { hasBoardAccess, requestBoardAccess } from '@/lib/tab';

type Message = { text: string; error?: boolean };

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Problems an import reported, collapsed under a summary line. */
function Issues({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  const { shown, more } = describeIssues(issues);
  return (
    <details className="import-issues">
      <summary>{plural(issues.length, 'item')} skipped. Show details</summary>
      <ul>
        {shown.map((text, i) => (
          <li key={i}>{text}</li>
        ))}
        {more > 0 && <li className="muted">…and {more} more.</li>}
      </ul>
    </details>
  );
}

/**
 * "Read up to" box: a post number; applied on Enter or when leaving the box. Raising it
 * deletes stored posts, so `onCommit` may ask first and return false to put the old value back.
 */
function FloorInput({ board, floor, onCommit }: { board: Board; floor: number; onCommit: (next: number) => void }) {
  const shown = floor > 0 ? String(floor) : '';
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const apply = () => {
    const typed = text.trim();
    const next = typed === '' ? 0 : Number(typed);
    if (!Number.isSafeInteger(next) || next < 0) {
      setText(shown);
      return;
    }
    if (next === floor) return;
    // Show the stored value until the change is confirmed and lands.
    setText(shown);
    onCommit(next);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      className="floor-input"
      placeholder="none"
      value={text}
      aria-label={`${board.label}: read up to post`}
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(shown);
      }}
    />
  );
}

/** A raise of the floor waiting for confirmation. */
type FloorChange = { board: Board; floor: number; previous: number; covered: number };

/**
 * Boards page (boards.html, opened from the list page header and from the 📖 dock on a
 * board): turn board marking on or off, see and trim what is stored per board, and import
 * a Booru explorer export.
 */
export function App() {
  const [prefs, setPrefs] = useState<BoardPrefs>();
  const [granted, setGranted] = useState<boolean>();
  const [stats, setStats] = useState<Record<BoardKey, BoardStat>>();
  const [switchMsg, setSwitchMsg] = useState<Message>();
  const [tableMsg, setTableMsg] = useState<Message>();
  const [importMsg, setImportMsg] = useState<Message>();
  const [issues, setIssues] = useState<string[]>([]);
  const [pending, setPending] = useState<{ file: BoardFile; issues: string[] }>();
  const [floorChange, setFloorChange] = useState<FloorChange>();
  const [clearing, setClearing] = useState<Board>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const loadStats = () => boardStats().then(setStats, () => setStats(undefined));
    const loadAccess = () => hasBoardAccess().then(setGranted);
    void getBoardPrefs().then(setPrefs);
    void loadStats();
    void loadAccess();
    const offPrefs = onBoardPrefsChanged(setPrefs);
    const offBoards = onBoardsChanged(() => void loadStats());
    browser.permissions.onAdded.addListener(loadAccess);
    browser.permissions.onRemoved.addListener(loadAccess);
    return () => {
      offPrefs();
      offBoards();
      browser.permissions.onAdded.removeListener(loadAccess);
      browser.permissions.onRemoved.removeListener(loadAccess);
    };
  }, []);

  const enabled = !!prefs?.enabled;

  async function turnOn() {
    setSwitchMsg(undefined);
    // permissions.request must be the first await (it needs the click's user gesture).
    const ok = await requestBoardAccess().catch(() => false);
    if (!ok) {
      setSwitchMsg({ text: 'Board marking needs access to the board sites.', error: true });
      return;
    }
    await updateBoardPrefs({ enabled: true });
    setSwitchMsg({ text: 'Board marking is on. Open boards get the 📖 dock now.' });
  }

  async function commitFloor(board: Board, floor: number, previous: number) {
    setTableMsg(undefined);
    const covered = floor ? await countUnderFloor(board.key, floor) : 0;
    setFloorChange({ board, floor, previous, covered });
  }

  return (
    <div className="page">
      <header className="page-header">
        <a className="back-link" href="/options.html">
          ← Reading list
        </a>
        <h1>Boards</h1>
        <p className="muted">
          On {BOARDS.map((b) => b.label).join(', ')}, posts you mark read are faded out of the next listing. Only post
          numbers are stored. They aren't records and don't appear in the reading list.
        </p>
      </header>

      <section className="backup-section">
        <h2>Board marking</h2>
        <p className="muted">
          Adds a 📖 button at the bottom of board pages: hold <strong>Mark this page read</strong> to mark every post
          in the listing (pixiv bookmarks are left alone), mark the open post, or <strong>Start marking</strong> to
          mark thumbnails by clicking them. The toolbar badge shows ✓ on a read post's page.
        </p>
        {prefs && (
          <div className="row">
            <span className={`board-state${enabled ? ' is-on' : ''}`}>{enabled ? 'On' : 'Off'}</span>
            {enabled ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSwitchMsg(undefined);
                  void updateBoardPrefs({ enabled: false });
                }}
              >
                Turn off
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => void turnOn()}>
                Turn on
              </button>
            )}
            {enabled && prefs.paused && (
              <button type="button" className="btn" onClick={() => void updateBoardPrefs({ paused: false })}>
                Resume (paused from the dock)
              </button>
            )}
          </div>
        )}
        {enabled && granted === false && (
          <p className="error">
            Board marking is on, but the extension has no access to the board sites, so nothing is marked.{' '}
            <button type="button" className="btn btn-small" onClick={() => void turnOn()}>
              Allow access
            </button>
          </p>
        )}
        {switchMsg && <span className={switchMsg.error ? 'error' : 'muted'}>{switchMsg.text}</span>}
      </section>

      <section className="backup-section">
        <h2>Read posts</h2>
        <p className="muted">
          <strong>Read up to</strong>: every post at or below this number counts as read without being stored, and the
          stored posts it covers are deleted. Posts under it can't be marked unread.
        </p>
        <div className="board-table-wrap">
          <table className="board-table">
            <thead>
              <tr>
                <th>Board</th>
                <th className="n">Posts</th>
                <th className="n">Size</th>
                <th className="n">Read up to</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {BOARDS.map((b) => {
                const s = stats?.[b.key] ?? { posts: 0, bytes: 0, floor: 0 };
                return (
                  <tr key={b.key}>
                    <td>{b.label}</td>
                    <td className="n">{s.posts.toLocaleString()}</td>
                    <td className="n">{s.posts ? bytes(s.bytes) : '—'}</td>
                    <td className="n">
                      <FloorInput board={b} floor={s.floor} onCommit={(f) => void commitFloor(b, f, s.floor)} />
                    </td>
                    <td className="n">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={!s.posts && !s.floor}
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

      <section className="backup-section">
        <h2>Import from Booru explorer</h2>
        <p className="muted">
          In Booru explorer's settings, export its <code>.json</code> file, then import it here. Read posts are added to
          what's stored (nothing is unmarked), and the higher "read up to" wins. Board history is also part of the{' '}
          <a href="/backup.html">ZIP backup</a>.
        </p>
        <div className="row">
          <label className={`btn${busy ? ' is-disabled' : ''}`} aria-disabled={busy}>
            Import .json
            <input
              type="file"
              accept=".json,application/json"
              hidden
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setImportMsg(undefined);
                setIssues([]);
                try {
                  const found: string[] = [];
                  setPending({ file: parseBoardFile(await file.text(), found), issues: found });
                } catch (err) {
                  setImportMsg({ text: `Can't import: ${err instanceof Error ? err.message : err}`, error: true });
                }
              }}
            />
          </label>
        </div>
        {importMsg && <span className={importMsg.error ? 'error' : 'muted'}>{importMsg.text}</span>}
        <Issues issues={issues} />
      </section>

      {pending && (
        <Dialog title="Import this file?" onClose={() => !busy && setPending(undefined)}>
          <p style={{ margin: 0 }}>
            {pending.file.exported && !Number.isNaN(Date.parse(pending.file.exported)) && (
              <>Exported {new Date(pending.file.exported).toLocaleString()}. </>
            )}
            It has <strong>{plural(boardPostCount(pending.file), 'read post')}</strong>.
          </p>
          <ul className="board-preview">
            {BOARDS.filter((b) => pending.file.sites[b.key] || pending.file.floors[b.key]).map((b) => (
              <li key={b.key}>
                {b.label}: {plural(pending.file.sites[b.key]?.length ?? 0, 'post')}
                {pending.file.floors[b.key] ? `, read up to ${pending.file.floors[b.key]!.toLocaleString()}` : ''}
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setPending(undefined)} autoFocus>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const added = await importBoardReads(pending.file);
                  setIssues(pending.issues);
                  setImportMsg({
                    text: added
                      ? `Imported: ${plural(added, 'post')} marked read.`
                      : 'Nothing new: every post in the file was already read.',
                  });
                } catch (err) {
                  setImportMsg({ text: `Import failed: ${err instanceof Error ? err.message : err}`, error: true });
                } finally {
                  setBusy(false);
                  setPending(undefined);
                }
              }}
            >
              Import
            </button>
          </div>
        </Dialog>
      )}

      {floorChange && (
        <ConfirmDialog
          title={
            floorChange.floor
              ? `${floorChange.board.label}: read up to ${floorChange.floor.toLocaleString()}?`
              : `${floorChange.board.label}: clear "read up to"?`
          }
          message={
            <>
              {floorChange.floor > 0 && <>Every post at or below {floorChange.floor.toLocaleString()} counts as read. </>}
              {floorChange.floor < floorChange.previous && (
                <>
                  Posts {floorChange.floor ? (floorChange.floor + 1).toLocaleString() : 'up'} to{' '}
                  {floorChange.previous.toLocaleString()} count as <strong>unread</strong> again (they weren't
                  stored).{' '}
                </>
              )}
              {floorChange.covered > 0 && (
                <>
                  <strong>{plural(floorChange.covered, 'stored post number')}</strong> inside it will be deleted.{' '}
                </>
              )}
              {floorChange.floor > floorChange.previous && (
                <>This can't be undone: clearing or lowering it later doesn't bring stored posts back.</>
              )}
            </>
          }
          confirmLabel={floorChange.floor ? 'Set' : 'Clear'}
          onClose={() => setFloorChange(undefined)}
          onConfirm={async () => {
            const { board, floor } = floorChange;
            try {
              const removed = await setBoardFloor(board.key, floor);
              setTableMsg({
                text: !floor
                  ? `${board.label}: "read up to" cleared.`
                  : `${board.label} reads up to ${floor.toLocaleString()}` +
                    (removed ? `: ${plural(removed, 'stored post')} deleted.` : '.'),
              });
            } catch (e) {
              setTableMsg({ text: `Failed: ${e instanceof Error ? e.message : e}`, error: true });
            }
          }}
        />
      )}

      {clearing && (
        <ConfirmDialog
          title={`Clear ${clearing.label}?`}
          message={`Forgets every read post on ${clearing.label}, and its "read up to". This can't be undone.`}
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
