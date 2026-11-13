import { useEffect, useState } from 'react';
import { Dialog } from '@/components/Dialog';
import { HoldButton } from '@/components/HoldButton';
import { describeIssues } from '@/lib/backup';
import { exportToFile, openBackup, type ImportResult, type OpenedBackup } from '@/lib/backup-io';
import { formatDateTime } from '@/lib/records';
import { countRecords, listFolders, onRecordsChanged, wipeAllData } from '@/lib/storage';

/** Erasing everything takes a longer hold than the everyday hold buttons. */
const WIPE_HOLD_MS = 3000;

type Message = { text: string; error?: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What an import skipped or changed, collapsed under a summary line. */
function ImportIssues({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  const { shown, more } = describeIssues(issues);
  return (
    <details className="import-issues">
      <summary>{plural(issues.length, 'item')} skipped or changed. Show details</summary>
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
 * Backup page (backup.html, opened from the list page header): export everything to one
 * ZIP file, or import one (merged by record id; the newer "updated" time wins).
 */
export function App() {
  const [exportMsg, setExportMsg] = useState<Message>();
  const [importMsg, setImportMsg] = useState<Message>();
  const [wipeMsg, setWipeMsg] = useState<Message>();
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  /** A backup that was opened and checked, waiting for the user to confirm the import. */
  const [pending, setPending] = useState<OpenedBackup>();
  const [result, setResult] = useState<ImportResult>();
  const [counts, setCounts] = useState<{ records: number; folders: number }>();

  useEffect(() => {
    const load = () =>
      Promise.all([countRecords(), listFolders()]).then(([records, folders]) =>
        setCounts({ records, folders: folders.length }),
      );
    void load();
    return onRecordsChanged(() => void load());
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <a className="back-link" href="/options.html">
          ← Reading list
        </a>
        <h1>Backup</h1>
      </header>

      <section className="backup-section">
        <h2>Export</h2>
        <p className="muted">
          Saves every record, folder and setting, and the board read history, to one ZIP file, with the original
          image files in an{' '}
          <code>images</code> folder that you can open or extract with any unzip tool.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setExportMsg(undefined);
              try {
                const n = await exportToFile();
                setExportMsg({ text: `Exported ${n} record${n === 1 ? '' : 's'}.` });
              } catch (e) {
                setExportMsg({ text: `Export failed: ${e instanceof Error ? e.message : e}`, error: true });
              } finally {
                setBusy(false);
              }
            }}
          >
            Export backup
          </button>
        </div>
        {exportMsg && <span className={exportMsg.error ? 'error' : 'muted'}>{exportMsg.text}</span>}
      </section>

      <section className="backup-section">
        <h2>Import</h2>
        <p className="muted">
          Adds the records from a backup <code>.zip</code>. You'll see what's in it before anything is imported.
        </p>
        <div className="row">
          <label className={`btn${busy ? ' is-disabled' : ''}`} aria-disabled={busy}>
            Import backup
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setBusy(true);
                setImportMsg(undefined);
                setResult(undefined);
                try {
                  setPending(await openBackup(file));
                } catch (err) {
                  setImportMsg({ text: `Can't import: ${err instanceof Error ? err.message : err}`, error: true });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
        {importMsg && <span className={importMsg.error ? 'error' : 'muted'}>{importMsg.text}</span>}
        {result && <ImportIssues issues={result.issues} />}
      </section>

      {pending && (
        <Dialog title="Import this backup?" onClose={() => !busy && setPending(undefined)}>
          <p style={{ margin: 0 }}>
            {pending.exportedAt ? <>Exported {formatDateTime(pending.exportedAt)}. </> : null}
            It has{' '}
            <strong>
              {plural(pending.counts.records, 'record')}, {plural(pending.counts.folders, 'folder')} and{' '}
              {plural(pending.counts.images, 'image')}
            </strong>
            {pending.counts.boardPosts ? <>, plus {plural(pending.counts.boardPosts, 'read board post')}</> : null}.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Records and folders that exist both here and in the backup keep the most recently edited copy. Board read
            history is merged. Nothing is deleted.
          </p>
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
                setImporting(true);
                try {
                  const r = await pending.run();
                  setResult(r);
                  setImportMsg({
                    text:
                      `Imported: ${r.added} added, ${r.updated} updated, ${r.skipped} unchanged.` +
                      (r.boardPosts ? ` ${plural(r.boardPosts, 'board post')} marked read.` : ''),
                  });
                } catch (err) {
                  setImportMsg({ text: `Import failed: ${err instanceof Error ? err.message : err}`, error: true });
                } finally {
                  setBusy(false);
                  setImporting(false);
                  setPending(undefined);
                }
              }}
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
          </div>
        </Dialog>
      )}

      <section className="backup-section backup-danger">
        <h2>Erase all data</h2>
        <p className="muted">
          Deletes every record, image and folder and the board read history, and resets Home's settings. This can't be
          undone.
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              setWipeMsg(undefined);
              setConfirmWipe(true);
            }}
          >
            Erase all data…
          </button>
        </div>
        {wipeMsg && <span className={wipeMsg.error ? 'error' : 'muted'}>{wipeMsg.text}</span>}
      </section>

      {confirmWipe && (
        <Dialog title="Erase all data?" onClose={() => !busy && setConfirmWipe(false)}>
          <p style={{ margin: 0 }}>
            This deletes{' '}
            {counts ? (
              <strong>
                {counts.records} record{counts.records === 1 ? '' : 's'} and {counts.folders} folder
                {counts.folders === 1 ? '' : 's'}
              </strong>
            ) : (
              'every record and folder'
            )}
            , all their images, the board read history and Home's settings. It can't be undone, so export a backup first if you might want
            them back.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmWipe(false)} autoFocus>
              Cancel
            </button>
            <HoldButton
              className="btn btn-danger"
              holdMs={WIPE_HOLD_MS}
              disabled={busy}
              title="Press and hold for 3 seconds to erase everything"
              hintLabel="Hold for 3 s"
              doneLabel="Erasing…"
              onConfirm={async () => {
                setBusy(true);
                try {
                  await wipeAllData();
                  setWipeMsg({ text: 'All data erased.' });
                } catch (e) {
                  setWipeMsg({ text: `Erase failed: ${e instanceof Error ? e.message : e}`, error: true });
                } finally {
                  setBusy(false);
                  setConfirmWipe(false);
                }
              }}
            >
              Hold to erase
            </HoldButton>
          </div>
        </Dialog>
      )}
    </div>
  );
}
