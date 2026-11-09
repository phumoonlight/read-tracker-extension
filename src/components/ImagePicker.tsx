import { useRef, useState, type ClipboardEvent } from 'react';
import { prepareImage } from '@/lib/images';
import { addImages, removeImage, setCoverImage } from '@/lib/storage';
import { captureVisible, downloadImage, findOgImage, NeedsPermissionError, requestOriginAccess } from '@/lib/tab';
import { MAX_IMAGES, type ReadingRecord } from '@/lib/types';
import { useImageUrl } from './Thumbnail';

interface Props {
  record: ReadingRecord;
  /** Present in the popup only: enables the screenshot and og:image sources. */
  tab?: { id: number; windowId: number };
  onChange?: (r: ReadingRecord) => void;
  /** Called with the image index when a tile is clicked (open the viewer). */
  onView: (index: number) => void;
}

/**
 * Manage a record's images (up to MAX_IMAGES): tiles to view, make cover or remove,
 * and sources to add from a file, the clipboard, a tab screenshot or the page's
 * og:image. Images are stored as the original file; only the tile uses a preview.
 */
export function ImagePicker({ record, tab, onChange, onView }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [needsOrigin, setNeedsOrigin] = useState<string>();
  const room = MAX_IMAGES - record.images.length;

  async function run(task: () => Promise<Blob[] | null>) {
    setBusy(true);
    setError(undefined);
    setNeedsOrigin(undefined);
    try {
      const blobs = await task();
      if (!blobs?.length) return;
      const prepared = [];
      for (const b of blobs) prepared.push(await prepareImage(b));
      const next = await addImages(record.id, prepared);
      if (next) onChange?.(next);
    } catch (e) {
      if (e instanceof NeedsPermissionError) setNeedsOrigin(e.origin);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function change(task: () => Promise<ReadingRecord | undefined>) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await task();
      if (next) onChange?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fromOgImage = (t: NonNullable<Props['tab']>) =>
    run(async () => {
      const src = await findOgImage(t.id);
      if (!src) throw new Error('This page has no og:image.');
      return [await downloadImage(src, t.id)];
    });

  function onPaste(e: ClipboardEvent) {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
      setError('Clipboard has no image.');
      return;
    }
    e.preventDefault();
    void run(async () => files.slice(0, Math.max(0, room)));
  }

  return (
    <div className="field">
      <span>
        Images ({record.images.length}/{MAX_IMAGES})
      </span>

      {record.images.length > 0 && (
        <div className="image-tiles">
          {record.images.map((id, i) => (
            <ImageTile
              key={id}
              imageId={id}
              index={i}
              busy={busy}
              onView={() => onView(i)}
              onCover={() => change(() => setCoverImage(record.id, id))}
              onRemove={() => change(() => removeImage(record.id, id))}
            />
          ))}
        </div>
      )}

      {room > 0 ? (
        <>
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
                  onClick={() => run(async () => [await captureVisible(tab.windowId)])}
                >
                  Screenshot
                </button>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => fromOgImage(tab)}>
                  og:image
                </button>
              </>
            )}
          </div>
          <div className="paste-zone" tabIndex={0} onPaste={onPaste} role="textbox" aria-label="Paste an image here">
            Click here and press Ctrl+V to paste an image
          </div>
        </>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>
          Maximum reached. Remove an image to add another.
        </span>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          if (files.length > room) {
            setError(`Only ${room} more image${room === 1 ? '' : 's'} fit; choose fewer files.`);
            return;
          }
          void run(async () => files);
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

function ImageTile({
  imageId,
  index,
  busy,
  onView,
  onCover,
  onRemove,
}: {
  imageId: string;
  index: number;
  busy: boolean;
  onView: () => void;
  onCover: () => void;
  onRemove: () => void;
}) {
  const url = useImageUrl(imageId);
  return (
    <div className="image-tile">
      <button type="button" className="thumb-button" onClick={onView} aria-label={`View image ${index + 1}`}>
        {url ? <img className="thumb" src={url} alt="" /> : <div className="thumb" />}
        {index === 0 && <span className="thumb-more">Cover</span>}
      </button>
      <div className="image-tile-actions">
        {index > 0 && (
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCover}>
            Make cover
          </button>
        )}
        <button
          type="button"
          className="btn btn-small btn-ghost"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove image ${index + 1}`}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
