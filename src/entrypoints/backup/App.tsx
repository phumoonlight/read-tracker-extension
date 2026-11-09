import { useState } from 'react';
import { exportToFile, importFromFile } from '@/lib/backup-io';

type Message = { text: string; error?: boolean };

/**
 * Backup page (backup.html, opened from the list page header): export everything to one
 * JSON file, or import one (merged by record id; the newer "updated" time wins).
 */
export function App() {
  const [exportMsg, setExportMsg] = useState<Message>();
  const [importMsg, setImportMsg] = useState<Message>();
  const [busy, setBusy] = useState(false);

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
                setImportMsg(undefined);
                try {
                  const p = await importFromFile(file);
                  setImportMsg({ text: `Imported: ${p.added} added, ${p.updated} updated, ${p.skipped} unchanged.` });
                } catch (err) {
                  setImportMsg({ text: `Import failed: ${err instanceof Error ? err.message : err}`, error: true });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
        {busy && <span className="muted">Working…</span>}
        {importMsg && <span className={importMsg.error ? 'error' : 'muted'}>{importMsg.text}</span>}
      </section>
    </div>
  );
}
