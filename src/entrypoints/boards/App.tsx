import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { describeIssues } from '@/lib/backup';
import { getBoardPrefs, onBoardPrefsChanged, updateBoardPrefs } from '@/lib/board-prefs';
import { boardStats, clearBoard, importBoardReads, onBoardsChanged, type BoardStat } from '@/lib/board-store';
import {
  BOARDS,
  boardPostCount,
  boardSitePostCount,
  parseBoardFile,
  RANGE_START,
  type Board,
  type BoardKey,
  type BoardPrefs,
  type ParsedBoardFile,
} from '@/lib/boards';
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
 * Boards page (boards.html, opened from the list page header and from the popup on a
 * board): turn board marking on or off, see and clear what is stored per board, and import
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
  const [pending, setPending] = useState<{ file: ParsedBoardFile; issues: string[] }>();
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
    setSwitchMsg({ text: 'Board marking is on. Its controls are in the toolbar popup on board pages.' });
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
          On a board page, the toolbar popup shows the board controls on top: mark the open post, hold{' '}
          <strong>Mark this page read</strong> to mark every post in the listing (pixiv bookmarks are left alone), or{' '}
          <strong>Start marking</strong> to mark thumbnails by clicking them. The toolbar badge shows ✓ on a read
          post's page.
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
                Resume (paused from the popup)
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
                    <td className="n">{s.posts.toLocaleString()}</td>
                    <td className="n">{s.posts ? bytes(s.bytes) : '—'}</td>
                    <td className="n">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={!s.posts}
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
          what's stored (nothing is unmarked). A "read up to" number in the file marks every post from {RANGE_START}{' '}
          up to it as read. Board history is also part of the{' '}
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
