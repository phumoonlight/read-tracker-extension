import { useEffect, useState } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { describeIssues } from '@/lib/backup';
import { getMarkingPrefs, onMarkingPrefsChanged, updateMarkingPrefs } from '@/lib/marking-prefs';
import type { MarkingPrefs } from '@/lib/link-marks';
import { boardStats, clearBoard, importBoardReads, onBoardsChanged, type BoardStat } from '@/lib/board-store';
import {
  BOARD_IDS_EXT,
  boardOfIdsFile,
  BOARDS,
  boardPostCount,
  decodeBoardIds,
  boardSitePostCount,
  mergeBoardReads,
  parseBoardFile,
  RANGE_START,
  type Board,
  type BoardKey,
  type ParsedBoardFile,
} from '@/lib/boards';

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
 * Boards page (boards.html, opened from the list page header and from the popup on a
 * board): see whether board marking is paused, see and clear what is stored per board, and import
 * a Booru explorer export.
 */
export function App() {
  const [prefs, setPrefs] = useState<MarkingPrefs>();
  const [stats, setStats] = useState<Record<BoardKey, BoardStat>>();
  const [tableMsg, setTableMsg] = useState<Message>();
  const [importMsg, setImportMsg] = useState<Message>();
  const [issues, setIssues] = useState<string[]>([]);
  const [pending, setPending] = useState<{ file: ParsedBoardFile; issues: string[] }>();
  const [clearing, setClearing] = useState<Board>();
  const [busy, setBusy] = useState(false);

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

      <section className="backup-section">
        <h2>Import</h2>
        <div className="row">
          <label className={`btn${busy ? ' is-disabled' : ''}`} aria-disabled={busy}>
            Import files…
            <input
              type="file"
              accept=".json,.bin,application/json"
              multiple
              hidden
              disabled={busy}
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (!files.length) return;
                setImportMsg(undefined);
                setIssues([]);
                const found: string[] = [];
                const parsed: ParsedBoardFile[] = [];
                for (const file of files) {
                  try {
                    if (!file.name.toLowerCase().endsWith(BOARD_IDS_EXT)) parsed.push(parseBoardFile(await file.text(), found));
                    else {
                      const board = boardOfIdsFile(file.name);
                      if (!board) throw new Error(`name it after its board (${BOARDS.map((b) => b.key + BOARD_IDS_EXT).join(', ')}).`);
                      const ids = decodeBoardIds(new Uint8Array(await file.arrayBuffer()));
                      parsed.push({ exported: '', sites: ids.length ? { [board]: ids } : {}, upTo: {} });
                    }
                  } catch (err) {
                    const why = err instanceof Error ? err.message : String(err);
                    setImportMsg({ text: `Can't import ${files.length > 1 ? `${file.name}: ` : ''}${why}`, error: true });
                    return;
                  }
                }
                // A backup's booru/ folder has one .bin file per board: several can be picked at once.
                const exported = parsed.length === 1 ? parsed[0]!.exported : '';
                setPending({ file: { ...mergeBoardReads(parsed), exported }, issues: found });
              }}
            />
          </label>
          <span className="muted">
            Booru explorer <code>.json</code> or backup <code>.bin</code>. Adds to what's stored.
          </span>
        </div>
        {importMsg && <span className={importMsg.error ? 'error' : 'muted'}>{importMsg.text}</span>}
        <Issues issues={issues} />
      </section>

      <details className="board-help">
        <summary>How to mark posts</summary>
        <ul>
          <li>Open the toolbar popup on a board page: the board controls are on top.</li>
          <li>
            <strong>Mark this post read</strong> on a post's page, or hold <strong>Mark this page read</strong> for the
            whole listing (pixiv bookmarks are skipped).
          </li>
          <li>
            <strong>Start marking</strong>, then click thumbnails to mark or unmark them. Esc stops.
          </li>
          <li>
            The popup's <strong>Dim</strong> switch turns the fading off on every website; marking still works.
          </li>
          <li>The toolbar badge shows ✓ on a read post.</li>
          <li>
            Board history is also in the <a href="/backup.html">ZIP backup</a>.
          </li>
        </ul>
      </details>

      {pending && (
        <Dialog title="Import this file?" onClose={() => !busy && setPending(undefined)}>
          <p style={{ margin: 0 }}>
            {pending.file.exported && !Number.isNaN(Date.parse(pending.file.exported)) && (
              <>Exported {new Date(pending.file.exported).toLocaleString()}. </>
            )}
            It has <strong>{plural(boardPostCount(pending.file), 'read post')}</strong>.
          </p>
          <ul className="board-preview">
            {BOARDS.filter((b) => pending.file.sites[b.key] || pending.file.upTo[b.key]).map((b) => {
              const upTo = pending.file.upTo[b.key];
              return (
                <li key={b.key}>
                  {b.label}: {plural(boardSitePostCount(pending.file, b.key), 'post')}
                  {upTo ? ` (including every post from ${RANGE_START} to ${upTo.toLocaleString()})` : ''}
                </li>
              );
            })}
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
