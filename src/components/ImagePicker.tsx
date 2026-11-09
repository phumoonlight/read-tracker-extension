import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { moveItem, prepareImage } from '@/lib/images';
import { addImages, removeImage, reorderImages } from '@/lib/storage';
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
 * Manage a record's images (up to MAX_IMAGES): tiles to view, drag to reorder (the first
 * is the cover; Alt+Left/Right moves a focused tile) or remove, and sources to add from a
 * file, the clipboard, a tab screenshot or the page's og:image. Images are stored as the
 * original file; only the tile uses a preview.
 */
export function ImagePicker({ record, tab, onChange, onView }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [needsOrigin, setNeedsOrigin] = useState<string>();
  /** Order shown while a reorder is being saved, so tiles don't jump back. */
  const [pendingOrder, setPendingOrder] = useState<string[]>();
  const [dragFrom, setDragFrom] = useState<number>();
  const [dragOver, setDragOver] = useState<number>();
  /** Tile moved with Alt+arrow: keep keyboard focus on it after it moves. */
  const [keyMoved, setKeyMoved] = useState<string>();
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

      {order.length > 0 && (
        <>
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
                onRemove={() => change(() => removeImage(record.id, id))}
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
          </div>
          {order.length > 1 && (
            <span className="muted" style={{ fontSize: 12 }}>
              Drag to reorder (or Alt+←/→). The first image is the cover.
            </span>
          )}
        </>
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
        aria-label={`View image ${index + 1} of ${count}${index === 0 ? ' (cover)' : ''}`}
        style={canDrag ? { cursor: 'grab' } : undefined}
      >
        {/* draggable=false: drag the tile, not the image file itself. */}
        {url ? <img className="thumb" src={url} alt="" draggable={false} /> : <div className="thumb" />}
      </button>
      <div className="image-tile-actions">
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
