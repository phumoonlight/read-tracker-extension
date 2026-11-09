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
 * A record's cover: the preview of its first image, loaded only when it scrolls near
 * the viewport, with a "+N" badge when it has more images. Without images (or if the
 * image is missing) it shows a site placeholder. The domain is used rather than the
 * title, whose first character may be a combining mark in some scripts (e.g. Thai).
 * With `onOpen`, clicking a cover that has images calls it (to open the viewer).
 */
export function Thumbnail({
  record,
  size = 'large',
  onOpen,
}: {
  record: ReadingRecord;
  size?: 'large' | 'small';
  onOpen?: () => void;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const cover = record.images[0];
  const url = useImageUrl(cover, { enabled: near });
  const extra = record.images.length - 1;

  const content = url ? (
    <>
      <img className="thumb" src={url} alt="" />
      {extra > 0 && <span className="thumb-more">+{extra}</span>}
    </>
  ) : (
    <SitePlaceholder url={record.url} size={size} />
  );

  return (
    <div ref={ref} className="thumb-wrap">
      {onOpen && url ? (
        <button
          type="button"
          className="thumb-button"
          onClick={onOpen}
          aria-label={`View ${record.images.length === 1 ? 'image' : `${record.images.length} images`}`}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </div>
  );
}
