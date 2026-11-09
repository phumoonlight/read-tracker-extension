import { useState, type FormEvent, type ReactNode } from 'react';
import { matchTag } from '@/lib/match';
import { computeMatchKey, normalizeTags, urlEntries } from '@/lib/records';
import { normalizeUrl, suggestPrefix } from '@/lib/url';
import { MAX_URLS, type Folder, type MatchMode, type ReadingRecord, type ReadStatus, type UrlEntry } from '@/lib/types';
import { StatusPicker } from './StatusPicker';
import { TagInput } from './TagInput';
import { XIcon } from './XIcon';
import { ConfirmDialog } from './Dialog';

/** One editable URL: the link itself, how it matches, and the series prefix (prefix mode). */
export interface UrlRow {
  url: string;
  matchMode: MatchMode;
  prefix: string;
}

export interface RecordFormValues {
  title: string;
  /** The first row is the main URL (listed first on the card). */
  urls: UrlRow[];
  status: ReadStatus;
  tags: string[];
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
  /** Hide the status picker (records in a Revisit place are read with "Update read" instead). */
  hideStatus?: boolean;
  /** Folders to choose from; the picker is hidden when there are none. */
  folders: readonly Folder[];
  /** Extra content shown after the fields, before the buttons (e.g. the image row). */
  children?: ReactNode;
  /** Shown at the left of the button row (e.g. Delete record). */
  footerStart?: ReactNode;
  /** Existing tags with usage counts, suggested while typing a tag. */
  tagSuggestions?: readonly (readonly [string, number])[];
}

export function RecordForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  compact,
  folders,
  hideStatus,
  children,
  footerStart,
  tagSuggestions = [],
}: Props) {
  const [v, setV] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  /** Index of the URL row waiting for the user to confirm its removal. */
  const [confirmUrl, setConfirmUrl] = useState<number>();
  const removeUrl = (i: number) => setV((p) => ({ ...p, urls: p.urls.filter((_, j) => j !== i) }));
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
        tags: normalizeTags(v.tags),
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

  const showFolder = folders.length > 0;
  return (
    <form onSubmit={submit} className="record-form">
      <label className="field">
        <span>Title</span>
        <input type="text" value={v.title} onChange={(e) => set('title', e.target.value)} />
      </label>

      <div className="field">
        <span>{v.urls.length > 1 ? 'URLs (the first is the main one)' : 'URL'}</span>
        {/* One bordered table: a row per URL (with its remove cell), then "+ Add URL". */}
        <div className="url-table">
          {v.urls.map((row, i) => (
            <UrlRowEditor
              key={i}
              index={i}
              row={row}
              onChange={(patch) => setRow(i, patch)}
              onRemove={
                v.urls.length > 1
                  ? // A blank row goes at once; a filled-in URL asks first.
                    () => (row.url.trim() ? setConfirmUrl(i) : removeUrl(i))
                  : undefined
              }
            />
          ))}
          {v.urls.length < MAX_URLS && (
            <button
              type="button"
              className="url-table-add"
              onClick={() => setV((p) => ({ ...p, urls: [...p.urls, newUrlRow()] }))}
            >
              + Add URL
            </button>
          )}
        </div>
      </div>

      {!hideStatus && (
        <div className="field">
          <span>Status</span>
          <StatusPicker value={v.status} onChange={(s) => set('status', s)} />
        </div>
      )}

      {showFolder && <FolderSelect folders={folders} value={v.folderId} onChange={(id) => set('folderId', id)} />}
      {!compact && <TagInput value={v.tags} onChange={(tags) => set('tags', tags)} suggestions={tagSuggestions} />}
      {children}

      {/* Notes last: they're only shown here, not on the list. */}
      {!compact && (
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      )}

      {error && <span className="error">{error}</span>}
      {confirmUrl !== undefined && v.urls[confirmUrl] && (
        <ConfirmDialog
          title="Remove URL?"
          message={
            <>
              <code className="remove-url">{v.urls[confirmUrl].url}</code>
              It's removed from this record when you click Save (Cancel keeps it).
            </>
          }
          confirmLabel="Remove"
          onClose={() => setConfirmUrl(undefined)}
          onConfirm={() => removeUrl(confirmUrl)}
        />
      )}
      <div className="form-footer">
        {footerStart}
        <span className="form-footer-spacer" />
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
    <div className="url-entry">
      <div className="url-input-row">
        <input
          type="url"
          required={main}
          value={row.url}
          placeholder={main ? 'https://' : 'Another URL (mirror, other site)'}
          aria-label={main ? 'Main URL' : `URL ${index + 1}`}
          // The normalized key the badge matches on, for the curious.
          title={typeof matchKey === 'string' ? `Matches: ${matchKey}` : undefined}
          onChange={(e) => onChange({ url: e.target.value })}
        />
        {onRemove && (
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onRemove}
            aria-label={`Remove URL ${index + 1}`}
            title="Remove URL"
          >
            <XIcon />
          </button>
        )}
      </div>
      {/*
        Series (prefix) matching is paused in the UI: new URLs always match their exact page.
        A URL saved earlier as a series keeps working; it can be switched to its exact page.
      */}
      {row.matchMode === 'prefix' && (
        <div className="row">
          <span className="muted">
            Matches every page under <code>{row.prefix}</code> (series).
          </span>
          <button type="button" className="btn btn-small" onClick={() => onChange({ matchMode: 'exact' })}>
            Match this page only
          </button>
        </div>
      )}
      {matchKey !== undefined && typeof matchKey !== 'string' && row.url.trim() && (
        <span className="error">{matchKey.error}</span>
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
