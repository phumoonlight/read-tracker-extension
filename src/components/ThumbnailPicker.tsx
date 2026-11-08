import { useRef, useState, type ClipboardEvent } from 'react';
import { deleteThumbnail, putThumbnail, resizeToThumbnail } from '@/lib/thumbnails';
import { updateRecord } from '@/lib/storage';
import {
  captureVisible,
  downloadImage,
  findOgImage,
  NeedsPermissionError,
  requestOriginAccess,
} from '@/lib/tab';
import type { ReadingRecord } from '@/lib/types';

interface Props {
  record: ReadingRecord;
  /** Present in the popup only: enables the screenshot and og:image sources. */
  tab?: { id: number; windowId: number };
  onChange?: (r: ReadingRecord) => void;
}

/** Set or clear a record's thumbnail from a file, the clipboard, a tab screenshot or the page's og:image. */
export function ThumbnailPicker({ record, tab, onChange }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [needsOrigin, setNeedsOrigin] = useState<string>();

  async function run(task: () => Promise<Blob | null>) {
    setBusy(true);
    setError(undefined);
    setNeedsOrigin(undefined);
    try {
      const source = await task();
      if (!source) return;
      await putThumbnail(record.id, await resizeToThumbnail(source));
      const next = await updateRecord(record.id, () => ({ hasThumbnail: true }));
      if (next) onChange?.(next);
    } catch (e) {
      if (e instanceof NeedsPermissionError) setNeedsOrigin(e.origin);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteThumbnail(record.id);
      const next = await updateRecord(record.id, () => ({ hasThumbnail: false }));
      if (next) onChange?.(next);
    } finally {
      setBusy(false);
    }
  }

  const fromOgImage = (t: NonNullable<Props['tab']>) =>
    run(async () => {
      const src = await findOgImage(t.id);
      if (!src) throw new Error('This page has no og:image.');
      return downloadImage(src, t.id);
    });

  function onPaste(e: ClipboardEvent) {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (!file) {
      setError('Clipboard has no image.');
      return;
    }
    e.preventDefault();
    void run(async () => file);
  }

  return (
    <div className="field">
      <span>Thumbnail</span>
      <div className="row">
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => fileInput.current?.click()}>
          Upload
        </button>
        {tab && (
          <>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => run(() => captureVisible(tab.windowId))}
            >
              Screenshot
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => fromOgImage(tab)}>
              og:image
            </button>
          </>
        )}
        {record.hasThumbnail && (
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
      </div>
      <div className="paste-zone" tabIndex={0} onPaste={onPaste} role="textbox" aria-label="Paste an image here">
        Click here and press Ctrl+V to paste an image
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void run(async () => file);
        }}
      />
      {busy && <span className="muted">Working…</span>}
      {error && <span className="error">{error}</span>}
      {needsOrigin && tab && (
        <button
          type="button"
          className="btn btn-small"
          onClick={async () => {
            if (await requestOriginAccess(needsOrigin)) void fromOgImage(tab);
          }}
        >
          Grant access to {new URL(needsOrigin).host}
        </button>
      )}
    </div>
  );
}
