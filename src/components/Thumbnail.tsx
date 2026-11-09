import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getThumbnail } from '@/lib/thumbnails';
import { hueFor, siteLabel } from '@/lib/url';
import type { ReadingRecord } from '@/lib/types';

/**
 * Object URL for a record's thumbnail, refreshed when the record changes. Nothing is
 * read from IndexedDB until `enabled` is true.
 */
export function useThumbnailUrl(
  record: Pick<ReadingRecord, 'id' | 'hasThumbnail' | 'updatedAt'>,
  enabled = true,
) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    if (!record.hasThumbnail) {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    getThumbnail(record.id)
      .then((blob) => {
        if (!cancelled) setUrl(blob ? URL.createObjectURL(blob) : undefined);
      })
      .catch(() => {
        if (!cancelled) setUrl(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, record.hasThumbnail, record.updatedAt, enabled]);

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
function useNearViewport<T extends Element>(margin = '400px') {
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

/**
 * Record thumbnail; the image is loaded only when it scrolls near the viewport.
 * Without an image it shows a placeholder tinted per site: the domain name at
 * "large" size, the domain's first letter at "small" size (popup, list rows).
 * The domain is used rather than the title, whose first character may be a
 * combining mark in some scripts (e.g. Thai).
 */
export function Thumbnail({ record, size = 'large' }: { record: ReadingRecord; size?: 'large' | 'small' }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const url = useThumbnailUrl(record, near);
  const site = siteLabel(record.url);
  return (
    <div ref={ref}>
      {url ? (
        <img className="thumb" src={url} alt="" />
      ) : (
        <div
          className={`thumb thumb-empty thumb-${size}`}
          style={{ '--hue': hueFor(site) } as CSSProperties}
          aria-hidden="true"
        >
          {size === 'large' ? <span className="thumb-site">{site || 'No image'}</span> : (site[0] ?? '?').toUpperCase()}
        </div>
      )}
    </div>
  );
}
