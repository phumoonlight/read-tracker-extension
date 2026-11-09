import { useEffect, useState } from 'react';
import { Dialog } from '@/components/Dialog';
import { HoldButton } from '@/components/HoldButton';
import { exportToFile, importFromFile } from '@/lib/backup-io';
import { countRecords, listFolders, onRecordsChanged, wipeAllData } from '@/lib/storage';

/** Erasing everything takes a longer hold than the everyday hold buttons. */
const WIPE_HOLD_MS = 3000;

type Message = { text: string; error?: boolean };

/**
 * Backup page (backup.html, opened from the list page header): export everything to one
 * JSON file, or import one (merged by record id; the newer "updated" time wins).
 */
export function App() {
  const [exportMsg, setExportMsg] = useState<Message>();
  const [importMsg, setImportMsg] = useState<Message>();
  const [wipeMsg, setWipeMsg] = useState<Message>();
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
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
          Saves every record, folder and setting to one JSON file, with the original images included (so the file can
          be large).
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
            Export JSON
          </button>
        </div>
        {exportMsg && <span className={exportMsg.error ? 'error' : 'muted'}>{exportMsg.text}</span>}
      </section>

      <section className="backup-section">
        <h2>Import</h2>
        <p className="muted">
          Adds the records from a backup file. When a record exists both here and in the file, the copy that was edited
          most recently is kept. Nothing is deleted.
        </p>
        <div className="row">
          <label className={`btn${busy ? ' is-disabled' : ''}`} aria-disabled={busy}>
            Import JSON
            <input
              type="file"
              accept="application/json,.json"
              hidden
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setBusy(true);
                setImporting(true);
                setImportMsg(undefined);
                try {
                  const p = await importFromFile(file);
                  setImportMsg({ text: `Imported: ${p.added} added, ${p.updated} updated, ${p.skipped} unchanged.` });
                } catch (err) {
                  setImportMsg({ text: `Import failed: ${err instanceof Error ? err.message : err}`, error: true });
                } finally {
                  setBusy(false);
                  setImporting(false);
                }
              }}
            />
          </label>
        </div>
        {importing && <span className="muted">Working…</span>}
        {importMsg && <span className={importMsg.error ? 'error' : 'muted'}>{importMsg.text}</span>}
      </section>

      <section className="backup-section backup-danger">
        <h2>Erase all data</h2>
        <p className="muted">Deletes every record, image and folder, and resets Home's settings. This can't be undone.</p>
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
            , all their images, and Home's settings. It can't be undone, so export a backup first if you might want
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
