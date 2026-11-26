import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { moveItem, prepareImage, probeWebImage } from '@/lib/images';
import { addImages, removeImage, reorderImages } from '@/lib/storage';
import { captureVisible, downloadImage, findOgImage, NeedsPermissionError, requestOriginAccess } from '@/lib/tab';
import { MAX_IMAGES, type ReadingRecord } from '@/lib/types';
import { webImageUrl } from '@/lib/url';
import { useImageUrl } from './Thumbnail';
import { XIcon } from './XIcon';
import { ConfirmDialog } from './Dialog';

interface Props {
  record: ReadingRecord;
  /** Present in the popup only: enables the screenshot and og:image sources. */
  tab?: { id: number; windowId: number };
  onChange?: (r: ReadingRecord) => void;
  /** Called with the image index when a tile is clicked (open the viewer). */
  onView: (index: number) => void;
}

/**
 * Manage a record's images (up to MAX_IMAGES) in one compact row: click a tile to view it,
 * drag to reorder (the first is the cover; Alt+Left/Right moves a focused tile), × to
 * remove, and a "+" tile to upload. Ctrl+V anywhere adds a copied image (text paste into a
 * field is left alone). An image address can be added as a link (a web image: only the
 * address is stored and the picture loads from the web) or saved as a local copy. In the
 * popup, Screenshot and og:image buttons are added. Local images are stored as the original
 * file; only the tile uses a preview.
 */
export function ImagePicker({ record, tab, onChange, onView }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Origin to ask access to after a blocked download, and what to try again once granted. */
  const [needsOrigin, setNeedsOrigin] = useState<{ origin: string; retry: () => void }>();
  /** Image address typed or pasted in the address field. */
  const [address, setAddress] = useState('');
  /** Order shown while a reorder is being saved, so tiles don't jump back. */
  const [pendingOrder, setPendingOrder] = useState<string[]>();
  const [dragFrom, setDragFrom] = useState<number>();
  const [dragOver, setDragOver] = useState<number>();
  /** Tile moved with Alt+arrow: keep keyboard focus on it after it moves. */
  const [keyMoved, setKeyMoved] = useState<string>();
  /** Image waiting for the user to confirm its removal. */
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const room = MAX_IMAGES - record.images.length;
  const order = pendingOrder ?? record.images;

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= order.length) return;
    const next = moveItem(order, from, to);
    setPendingOrder(next);
    void change(() => reorderImages(record.id, next)).finally(() => setPendingOrder(undefined));
  }

  const endDrag = () => {
    setDragFrom(undefined);
    setDragOver(undefined);
  };

  /** Store the files `task` gives; true once they are stored. */
  async function run(task: () => Promise<Blob[] | null>, retry?: () => void): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    setNeedsOrigin(undefined);
    try {
      const blobs = await task();
      if (!blobs?.length) return false;
      const prepared = [];
      for (const b of blobs) prepared.push(await prepareImage(b));
      const next = await addImages(record.id, prepared);
      if (next) onChange?.(next);
      return true;
    } catch (e) {
      if (e instanceof NeedsPermissionError && retry) setNeedsOrigin({ origin: e.origin, retry });
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function change(task: () => Promise<ReadingRecord | undefined>) {
    setBusy(true);
    setError(undefined);
    setNeedsOrigin(undefined);
    try {
      const next = await task();
      if (next) onChange?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fromOgImage = (t: NonNullable<Props['tab']>): Promise<boolean> =>
    run(
      async () => {
        const src = await findOgImage(t.id);
        if (!src) throw new Error('This page has no og:image.');
        return [await downloadImage(src, t.id)];
      },
      () => void fromOgImage(t),
    );

  /** The address field's URL, or undefined after showing why it isn't one. */
  function addressUrl(): string | undefined {
    const url = webImageUrl(address);
    if (!url) setError('Enter an image address starting with http:// or https://.');
    return url;
  }

  /** Add the address as a web image: only the address is stored. Checked to load here first. */
  function addLink() {
    const url = addressUrl();
    if (!url) return;
    void change(async () => {
      const size = await probeWebImage(url);
      const next = await addImages(record.id, [{ url, ...size }]);
      setAddress('');
      return next;
    });
  }

  /** Download the address and store the file locally, like an upload. */
  async function saveCopy(url = addressUrl()) {
    if (!url) return;
    if (await run(async () => [await downloadImage(url, tab?.id)], () => void saveCopy(url))) setAddress('');
  }

  // Paste an image anywhere (no dedicated paste box). Only image files are taken; a normal
  // text paste into a field is left alone.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (room <= 0) return;
    const onPaste = (e: ClipboardEvent) => {
      // Pasting text into a field (even if the clipboard also holds an image) stays a text paste.
      const t = e.target as HTMLElement | null;
      const inTextField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inTextField && e.clipboardData?.types.includes('text/plain')) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      void runRef.current(async () => files.slice(0, room));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [room]);

  return (
    <div className="field">
      <span>
        Images <span className="muted image-count">{record.images.length}/{MAX_IMAGES}</span>
      </span>

      <div className="image-tiles">
        {order.map((id, i) => (
          <ImageTile
            key={id}
            imageId={id}
            index={i}
            count={order.length}
            busy={busy}
            dragging={dragFrom === i}
            dropTarget={dragOver === i && dragFrom !== undefined && dragFrom !== i}
            onView={() => onView(record.images.indexOf(id))}
            onRemove={() => setConfirmRemove(id)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              // A private type, so dropping onto a text field doesn't paste anything.
              e.dataTransfer.setData('application/x-read-tracker-image', id);
              setDragFrom(i);
            }}
            onDragOver={(e) => {
              if (dragFrom === undefined) return; // not one of our tiles (e.g. a file)
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDragOver(i);
            }}
            onDrop={(e) => {
              if (dragFrom === undefined) return;
              e.preventDefault();
              move(dragFrom, i);
              endDrag();
            }}
            onDragEnd={endDrag}
            onMoveKey={(d) => {
              setKeyMoved(id);
              move(i, i + d);
            }}
            keepFocus={keyMoved === id}
          />
        ))}
        {room > 0 && (
          <button
            type="button"
            className="image-add"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            title="Upload images, or paste one with Ctrl+V"
            aria-label="Add image"
          >
            {busy ? '…' : '+'}
          </button>
        )}
      </div>

      {room > 0 && (
        <div className="row image-url-row">
          <input
            type="url"
            className="image-url-input"
            placeholder="Image address (https://…)"
            value={address}
            disabled={busy}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault(); // don't submit the record form
              addLink();
            }}
            aria-label="Image address"
          />
          <button
            type="button"
            className="btn btn-small"
            disabled={busy || !address.trim()}
            onClick={addLink}
            title="Keep only the address: the image loads from the web and isn't stored here"
          >
            Add link
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={busy || !address.trim()}
            onClick={() => void saveCopy()}
            title="Download the image and store the file here, like an upload"
          >
            Save copy
          </button>
        </div>
      )}

      {tab && room > 0 && (
        <div className="row">
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={busy}
            onClick={() => run(async () => [await captureVisible(tab.windowId)])}
          >
            + Screenshot
          </button>
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => fromOgImage(tab)}>
            + og:image
          </button>
        </div>
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
      {error && <span className="error">{error}</span>}
      {confirmRemove && (
        <ConfirmDialog
          title="Remove image?"
          message={
            <>
              <RemovePreview imageId={confirmRemove} />
              This image will be deleted from the record. This can't be undone (unless you have a backup).
            </>
          }
          confirmLabel="Remove"
          onClose={() => setConfirmRemove(undefined)}
          onConfirm={() => change(() => removeImage(record.id, confirmRemove))}
        />
      )}
      {needsOrigin && (
        <button
          type="button"
          className="btn btn-small"
          onClick={async () => {
            if (await requestOriginAccess(needsOrigin.origin)) needsOrigin.retry();
          }}
        >
          Grant access to {new URL(needsOrigin.origin).host}
        </button>
      )}
    </div>
  );
}

function ImageTile({
  imageId,
  index,
  count,
  busy,
  dragging,
  dropTarget,
  onView,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveKey,
  keepFocus,
}: {
  imageId: string;
  index: number;
  count: number;
  busy: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onView: () => void;
  onRemove: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
  /** Move this tile left (-1) or right (+1). */
  onMoveKey: (delta: -1 | 1) => void;
  /** Re-focus after this tile moves (moving a DOM node can drop focus). */
  keepFocus: boolean;
}) {
  const url = useImageUrl(imageId);
  /** A web image (loaded from its address) rather than a stored file. */
  const web = !!url && !url.startsWith('blob:');
  const [failed, setFailed] = useState<string>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (keepFocus) buttonRef.current?.focus();
  }, [keepFocus, index]);
  const canDrag = count > 1 && !busy;
  return (
    <div
      className={`image-tile${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button
        ref={buttonRef}
        type="button"
        className="thumb-button"
        onClick={onView}
        onKeyDown={(e: KeyboardEvent) => {
          if (!canDrag || !e.altKey) return;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            onMoveKey(e.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
        aria-label={`View ${web ? 'web ' : ''}image ${index + 1} of ${count}${index === 0 ? ' (cover)' : ''}`}
        title={count > 1 ? 'Click to view. Drag to reorder; the first image is the cover.' : 'Click to view'}
        style={canDrag ? { cursor: 'grab' } : undefined}
      >
        {/* draggable=false: drag the tile, not the image file itself. */}
        {url && failed !== url ? (
          <img
            className="thumb"
            src={url}
            alt=""
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setFailed(url)}
          />
        ) : (
          <div className="thumb" />
        )}
      </button>
      {web && (
        <span className="image-web-badge" title={`Web image (not stored here): ${url}`} aria-hidden="true">
          🔗
        </span>
      )}
      <button
        type="button"
        className="image-remove"
        disabled={busy}
        onClick={onRemove}
        aria-label={`Remove image ${index + 1}`}
        title="Remove"
      >
        <XIcon size={10} />
      </button>
    </div>
  );
}

/** Small preview of the image being removed, shown in the confirmation. */
function RemovePreview({ imageId }: { imageId: string }) {
  const url = useImageUrl(imageId);
  return url ? <img className="remove-preview" src={url} alt="" referrerPolicy="no-referrer" /> : null;
}
