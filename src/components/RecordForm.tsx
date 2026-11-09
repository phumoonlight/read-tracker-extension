import { useState, type FormEvent } from 'react';
import { matchTag } from '@/lib/match';
import { computeMatchKey, parseTags, urlEntries } from '@/lib/records';
import { normalizeUrl, suggestPrefix } from '@/lib/url';
import { MAX_URLS, type Folder, type MatchMode, type ReadingRecord, type ReadStatus, type UrlEntry } from '@/lib/types';
import { StatusPicker } from './StatusPicker';

/** One editable URL: the link itself, how it matches, and the series prefix (prefix mode). */
export interface UrlRow {
  url: string;
  matchMode: MatchMode;
  prefix: string;
}

export interface RecordFormValues {
  title: string;
  /** The first row is the main URL (opened from the title). */
  urls: UrlRow[];
  status: ReadStatus;
  tags: string;
  notes: string;
  /** '' = Home (no folder). */
  folderId: string;
}

export interface RecordFormResult {
  title: string;
  /** Main URL. */
  url: string;
  matchMode: MatchMode;
  matchKey: string;
  /** The other URLs, validated, with match keys. */
  otherUrls: UrlEntry[];
  status: ReadStatus;
  tags: string[];
  notes?: string;
  folderId?: string;
}

export function defaultPrefix(url: string): string {
  const n = normalizeUrl(url);
  return n ? suggestPrefix(n) : '';
}

export const newUrlRow = (url = ''): UrlRow => ({ url, matchMode: 'exact', prefix: defaultPrefix(url) });

/** Form rows for an existing record's URLs. */
export const urlRowsFor = (r: ReadingRecord): UrlRow[] =>
  urlEntries(r).map((e) => ({
    url: e.url,
    matchMode: e.matchMode,
    prefix: e.matchMode === 'prefix' ? e.matchKey : defaultPrefix(e.url),
  }));

/**
 * Validate the URL rows. Blank rows after the first are ignored. Returns the entries (main
 * first) or an error naming the row.
 */
export function validateUrlRows(rows: readonly UrlRow[]): UrlEntry[] | { error: string } {
  const entries: UrlEntry[] = [];
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    if (i > 0 && !row.url.trim()) continue;
    const label = i === 0 ? 'Main URL' : `URL ${i + 1}`;
    const key = computeMatchKey(row.url, row.matchMode, row.prefix);
    if (typeof key !== 'string') return { error: `${label}: ${key.error}` };
    const tag = matchTag(row.matchMode, key);
    if (seen.has(tag)) return { error: `${label} matches the same pages as another URL of this record.` };
    seen.add(tag);
    entries.push({ url: row.url.trim(), matchMode: row.matchMode, matchKey: key });
  }
  return entries;
}

interface Props {
  initial: RecordFormValues;
  submitLabel: string;
  onSubmit: (values: RecordFormResult) => void | Promise<void>;
  onCancel?: () => void;
  /** Hide tags and notes to keep the popup compact. */
  compact?: boolean;
  /** Hide the status picker (records in a Revisit place are read with "Read now" instead). */
  hideStatus?: boolean;
  /** Folders to choose from; the picker is hidden when there are none. */
  folders: readonly Folder[];
}

export function RecordForm({ initial, submitLabel, onSubmit, onCancel, compact, folders, hideStatus }: Props) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RecordFormValues>(k: K, value: RecordFormValues[K]) => setV((p) => ({ ...p, [k]: value }));
  const setRow = (i: number, patch: Partial<UrlRow>) =>
    setV((p) => ({ ...p, urls: p.urls.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const entries = validateUrlRows(v.urls);
    if ('error' in entries) {
      setError(entries.error);
      return;
    }
    const [main, ...others] = entries as [UrlEntry, ...UrlEntry[]];
    setSaving(true);
    try {
      await onSubmit({
        title: v.title.trim() || main.url,
        url: main.url,
        matchMode: main.matchMode,
        matchKey: main.matchKey,
        otherUrls: others,
        status: v.status,
        tags: parseTags(v.tags),
        notes: v.notes.trim() || undefined,
        // A folder deleted while the form was open counts as Home.
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

      {v.urls.map((row, i) => (
        <UrlRowEditor
          key={i}
          index={i}
          row={row}
          onChange={(patch) => setRow(i, patch)}
          onRemove={v.urls.length > 1 ? () => setV((p) => ({ ...p, urls: p.urls.filter((_, j) => j !== i) })) : undefined}
        />
      ))}
      {v.urls.length < MAX_URLS && (
        <div>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => setV((p) => ({ ...p, urls: [...p.urls, newUrlRow()] }))}
          >
            + Add URL
          </button>
        </div>
      )}

      {!hideStatus && (
        <div className="field">
          <span>Status</span>
          <StatusPicker value={v.status} onChange={(s) => set('status', s)} />
        </div>
      )}
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

function UrlRowEditor({
  index,
  row,
  onChange,
  onRemove,
}: {
  index: number;
  row: UrlRow;
  onChange: (patch: Partial<UrlRow>) => void;
  onRemove?: () => void;
}) {
  const main = index === 0;
  // Extra rows may be left blank (ignored on save); the main URL is required.
  const blank = !main && !row.url.trim();
  const matchKey = blank ? undefined : computeMatchKey(row.url, row.matchMode, row.prefix);
  return (
    <div className="url-row">
      <div className="url-row-head">
        <span>{main ? 'Main URL (opened from the title)' : `URL ${index + 1}`}</span>
        {onRemove && (
          <button type="button" className="btn btn-small btn-ghost" onClick={onRemove} aria-label={`Remove URL ${index + 1}`}>
            Remove
          </button>
        )}
      </div>
      <input
        type="url"
        required={main}
        value={row.url}
        placeholder="https://"
        aria-label={main ? 'Main URL' : `URL ${index + 1}`}
        onChange={(e) => onChange({ url: e.target.value })}
      />
      <div className="segmented" role="group" aria-label={`Match mode for URL ${index + 1}`}>
        <button type="button" aria-pressed={row.matchMode === 'exact'} onClick={() => onChange({ matchMode: 'exact' })}>
          This page
        </button>
        <button
          type="button"
          aria-pressed={row.matchMode === 'prefix'}
          onClick={() => onChange({ matchMode: 'prefix', prefix: row.prefix || defaultPrefix(row.url) })}
        >
          Series (prefix)
        </button>
      </div>
      {row.matchMode === 'prefix' && (
        <label className="field">
          <span>Series prefix: every page under it matches</span>
          <input type="text" value={row.prefix} onChange={(e) => onChange({ prefix: e.target.value })} />
        </label>
      )}
      {matchKey !== undefined && (
        <small className="muted" style={{ wordBreak: 'break-all' }}>
          Match key:{' '}
          {typeof matchKey === 'string' ? <code>{matchKey}</code> : <span className="error">{matchKey.error}</span>}
        </small>
      )}
    </div>
  );
}

/** Folder picker; '' = Home (no folder). */
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
  // An id that is no longer in the list (folder deleted) shows as Home.
  const current = folders.some((f) => f.id === value) ? value : '';
  return (
    <label className="field">
      <span>{label}</span>
      <select value={current} onChange={(e) => onChange(e.target.value)}>
        <option value="">Home</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}
