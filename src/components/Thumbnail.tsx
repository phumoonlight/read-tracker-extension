import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getImage, getImagePreview } from '@/lib/images';
import type { ReadingRecord } from '@/lib/types';
import { hueFor, siteLabel } from '@/lib/url';

/**
 * Object URL for an image (its small preview by default, or the original), revoked
 * once replaced or unmounted. Nothing is read from IndexedDB until `enabled` is true.
 */
export function useImageUrl(imageId: string | undefined, { enabled = true, original = false } = {}) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    if (!imageId) {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    (original ? getImage(imageId).then((img) => img?.blob) : getImagePreview(imageId))
      .then((blob) => {
        if (!cancelled) setUrl(blob ? URL.createObjectURL(blob) : undefined);
      })
      .catch(() => {
        if (!cancelled) setUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [imageId, enabled, original]);

  // Revoke each object URL only once it has been replaced (or on unmount), so the
  // old image stays visible while the new one loads instead of flashing broken.
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  return url;
}

/** True once the element has come within `margin` of the viewport (then stays true). */
export function useNearViewport<T extends Element>(margin = '400px') {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

/** Placeholder tinted per site: the domain at "large" size, its first letter at "small". */
export function SitePlaceholder({ url, size }: { url: string; size: 'large' | 'small' }) {
  const site = siteLabel(url);
  return (
    <div
      className={`thumb thumb-empty thumb-${size}`}
      style={{ '--hue': hueFor(site) } as CSSProperties}
      aria-hidden="true"
    >
      {size === 'large' ? <span className="thumb-site">{site || 'No image'}</span> : (site[0] ?? '?').toUpperCase()}
    </div>
  );
}

/**
 * A record's cover: all of its images (up to MAX_IMAGES) as a mosaic in one 16:10 area,
 * so cards keep the same size whatever the count: 1 = full, 2 = side by side,
 * 3 = one large on the left and two stacked on the right (the first image is the
 * large one). Previews load only when the cover scrolls near the viewport.
 * Without images it shows a site placeholder; the domain is used rather than the
 * title, whose first character may be a combining mark in some scripts (e.g. Thai).
 * With `onOpen`, clicking an image calls it with that image's index (open the viewer).
 */
export function Thumbnail({
  record,
  size = 'large',
  onOpen,
  original = false,
}: {
  record: ReadingRecord;
  size?: 'large' | 'small';
  onOpen?: (index: number) => void;
  /** Load the original files instead of the small previews (for large display sizes). */
  original?: boolean;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const count = record.images.length;

  return (
    <div ref={ref} className="thumb-wrap">
      {count === 0 ? (
        <SitePlaceholder url={record.url} size={size} />
      ) : (
        <div className={`thumb mosaic mosaic-${Math.min(count, 3)}`}>
          {record.images.slice(0, 3).map((id, i) => (
            <MosaicCell
              key={id}
              imageId={id}
              enabled={near}
              original={original}
              label={count === 1 ? 'View image' : `View image ${i + 1} of ${count}`}
              onOpen={onOpen && (() => onOpen(i))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A record's images as separate small tiles in a row (list view), each opening the
 * viewer at that image. Previews load only when the row nears the viewport.
 */
export function ImageStrip({
  record,
  onOpen,
  original = false,
}: {
  record: ReadingRecord;
  onOpen?: (index: number) => void;
  /** Load the original files instead of the small previews (for large display sizes). */
  original?: boolean;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const count = record.images.length;
  return (
    <div ref={ref} className="image-strip">
      {record.images.map((id, i) => (
        <MosaicCell
          key={id}
          className="image-strip-cell"
          imageId={id}
          enabled={near}
          original={original}
          label={count === 1 ? 'View image' : `View image ${i + 1} of ${count}`}
          onOpen={onOpen && (() => onOpen(i))}
        />
      ))}
    </div>
  );
}

function MosaicCell({
  imageId,
  enabled,
  label,
  onOpen,
  className = '',
  original = false,
}: {
  imageId: string;
  enabled: boolean;
  label: string;
  onOpen?: () => void;
  className?: string;
  original?: boolean;
}) {
  const url = useImageUrl(imageId, { enabled, original });
  // A missing image leaves an empty (tinted) cell rather than collapsing the layout.
  const img = url ? <img src={url} alt="" decoding="async" /> : null;
  return onOpen && url ? (
    <button type="button" className={`mosaic-cell thumb-button ${className}`} onClick={onOpen} aria-label={label}>
      {img}
    </button>
  ) : (
    <div className={`mosaic-cell ${className}`}>{img}</div>
  );
}
