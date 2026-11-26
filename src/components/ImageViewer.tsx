import { useEffect, useState } from 'react';
import { getImage } from '@/lib/images';
import { Dialog } from './Dialog';
import { useImageUrl } from './Thumbnail';

/**
 * Full-resolution viewer for a record's images. Shows the original file (never the
 * preview), scaled down only to fit the window; "Open original" opens it in a new
 * tab at 100%. A web image is loaded from its address (its site is shown instead of a
 * file size). Arrow keys / buttons step through the images.
 */
export function ImageViewer({
  title,
  imageIds,
  start = 0,
  onClose,
}: {
  title: string;
  imageIds: string[];
  start?: number;
  onClose: () => void;
}) {
  const [rawIndex, setIndex] = useState(start);
  const count = imageIds.length;
  // Clamp: the list can shrink while the viewer is open (image removed elsewhere).
  const index = Math.min(Math.max(0, rawIndex), Math.max(0, count - 1));
  const id = imageIds[index];
  const url = useImageUrl(id, { original: true });
  const [info, setInfo] = useState<{ width?: number; height?: number; size?: number; host?: string }>();
  const [missing, setMissing] = useState(false);
  /** The web image address that failed to load. */
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let stale = false;
    setInfo(undefined);
    setMissing(false);
    if (!id) return;
    void getImage(id).then((img) => {
      if (stale) return;
      if (!img) setMissing(true);
      else if (img.url !== undefined) setInfo({ width: img.width, height: img.height, host: hostOf(img.url) });
      else setInfo({ width: img.width, height: img.height, size: img.blob.size });
    });
    return () => {
      stale = true;
    };
  }, [id]);

  const step = (d: number) => count > 1 && setIndex(() => (index + d + count) % count);

  return (
    <Dialog
      title={title}
      onClose={onClose}
      className="viewer"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') step(1);
        else if (e.key === 'ArrowLeft') step(-1);
      }}
    >
      <div className="viewer-stage">
        {count === 0 ? (
          <p className="muted">This record has no images.</p>
        ) : missing ? (
          <p className="muted">This image is missing.</p>
        ) : url && failed === url ? (
          <p className="muted">
            This web image didn't load{info?.host ? ` from ${info.host}` : ''}. It may have been removed, or the site may
            not allow showing it here.
          </p>
        ) : url ? (
          <img
            className="viewer-img"
            src={url}
            alt={`Image ${index + 1} of ${count}`}
            referrerPolicy="no-referrer"
            onError={() => setFailed(url)}
          />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
      <div className="viewer-bar">
        <div className="row">
          {count > 1 && (
            <>
              <button type="button" className="btn btn-small" onClick={() => step(-1)} aria-label="Previous image">
                ←
              </button>
              <span className="muted">
                {index + 1} / {count}
              </span>
              <button type="button" className="btn btn-small" onClick={() => step(1)} aria-label="Next image">
                →
              </button>
            </>
          )}
          {info && (
            <span className="muted">
              {[
                info.width && info.height ? `${info.width} × ${info.height}` : '',
                info.size !== undefined ? formatBytes(info.size) : `Web image${info.host ? ` · ${info.host}` : ''}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
        <div className="row">
          {url && (
            <a className="btn btn-small" href={url} target="_blank" rel="noreferrer">
              {info?.size === undefined && info ? 'Open web image' : 'Open original'}
            </a>
          )}
          <button type="button" className="btn btn-small" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
