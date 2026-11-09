import { useEffect, useState } from 'react';
import { getImage } from '@/lib/images';
import { Dialog } from './Dialog';
import { useImageUrl } from './Thumbnail';

/**
 * Full-resolution viewer for a record's images. Shows the original file (never the
 * preview), scaled down only to fit the window; "Open original" opens it in a new
 * tab at 100%. Arrow keys / buttons step through the images.
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
  const [info, setInfo] = useState<{ width?: number; height?: number; size: number; type: string }>();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let stale = false;
    setInfo(undefined);
    setMissing(false);
    if (!id) return;
    void getImage(id).then((img) => {
      if (stale) return;
      if (!img) setMissing(true);
      else setInfo({ width: img.width, height: img.height, size: img.blob.size, type: img.blob.type });
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
        ) : url ? (
          <img className="viewer-img" src={url} alt={`Image ${index + 1} of ${count}`} />
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
              {info.width && info.height ? `${info.width} × ${info.height} · ` : ''}
              {formatBytes(info.size)}
            </span>
          )}
        </div>
        <div className="row">
          {url && (
            <a className="btn btn-small" href={url} target="_blank" rel="noreferrer">
              Open original
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

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
