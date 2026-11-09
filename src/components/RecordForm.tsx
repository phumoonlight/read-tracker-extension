import { useState, type FormEvent } from 'react';
import { computeMatchKey, parseTags } from '@/lib/records';
import { normalizeUrl, suggestPrefix } from '@/lib/url';
import type { Folder, MatchMode, ReadStatus } from '@/lib/types';
import { StatusPicker } from './StatusPicker';

export interface RecordFormValues {
  title: string;
  url: string;
  matchMode: MatchMode;
  prefix: string;
  status: ReadStatus;
  tags: string;
  notes: string;
  /** '' = no folder. */
  folderId: string;
}

export interface RecordFormResult {
  title: string;
  url: string;
  matchMode: MatchMode;
  matchKey: string;
  status: ReadStatus;
  tags: string[];
  notes?: string;
  folderId?: string;
}

export function defaultPrefix(url: string): string {
  const n = normalizeUrl(url);
  return n ? suggestPrefix(n) : '';
}

interface Props {
  initial: RecordFormValues;
  submitLabel: string;
  onSubmit: (values: RecordFormResult) => void | Promise<void>;
  onCancel?: () => void;
  /** Hide tags and notes to keep the popup compact. */
  compact?: boolean;
  /** Folders to choose from; the picker is hidden when there are none. */
  folders: readonly Folder[];
}

export function RecordForm({ initial, submitLabel, onSubmit, onCancel, compact, folders }: Props) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RecordFormValues>(k: K, value: RecordFormValues[K]) => setV((p) => ({ ...p, [k]: value }));

  const matchKey = computeMatchKey(v.url, v.matchMode, v.prefix);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (typeof matchKey !== 'string') {
      setError(matchKey.error);
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        title: v.title.trim() || v.url.trim(),
        url: v.url.trim(),
        matchMode: v.matchMode,
        matchKey,
        status: v.status,
        tags: parseTags(v.tags),
        notes: v.notes.trim() || undefined,
        // A folder deleted while the form was open counts as "no folder".
        folderId: folders.some((f) => f.id === v.folderId) ? v.folderId : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <label className="field">
        <span>Title</span>
        <input type="text" value={v.title} onChange={(e) => set('title', e.target.value)} />
      </label>
      <label className="field">
        <span>URL</span>
        <input type="url" required value={v.url} onChange={(e) => set('url', e.target.value)} />
      </label>

      <div className="field">
        <span>Match</span>
        <div className="segmented" role="group" aria-label="Match mode">
          <button type="button" aria-pressed={v.matchMode === 'exact'} onClick={() => set('matchMode', 'exact')}>
            This page
          </button>
          <button
            type="button"
            aria-pressed={v.matchMode === 'prefix'}
            onClick={() => setV((p) => ({ ...p, matchMode: 'prefix', prefix: p.prefix || defaultPrefix(p.url) }))}
          >
            Series (prefix)
          </button>
        </div>
      </div>
      {v.matchMode === 'prefix' && (
        <label className="field">
          <span>Series prefix: every page under it matches</span>
          <input type="text" value={v.prefix} onChange={(e) => set('prefix', e.target.value)} />
        </label>
      )}
      <small className="muted" style={{ wordBreak: 'break-all' }}>
        Match key: {typeof matchKey === 'string' ? <code>{matchKey}</code> : <span className="error">{matchKey.error}</span>}
      </small>

      <div className="field">
        <span>Status</span>
        <StatusPicker value={v.status} onChange={(s) => set('status', s)} />
      </div>
      {folders.length > 0 && <FolderSelect folders={folders} value={v.folderId} onChange={(id) => set('folderId', id)} />}
      {!compact && (
        <>
          <label className="field">
            <span>Tags (comma-separated)</span>
            <input type="text" value={v.tags} onChange={(e) => set('tags', e.target.value)} />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea value={v.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </>
      )}

      {error && <span className="error">{error}</span>}
      <div className="dialog-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Folder picker; '' = no folder. */
export function FolderSelect({
  folders,
  value,
  onChange,
  label = 'Folder',
}: {
  folders: readonly Folder[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  // An id that is no longer in the list (folder deleted) shows as "No folder".
  const current = folders.some((f) => f.id === value) ? value : '';
  return (
    <label className="field">
      <span>{label}</span>
      <select value={current} onChange={(e) => onChange(e.target.value)}>
        <option value="">No folder</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}
