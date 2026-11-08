import { useEffect, useState } from 'react';
import { getThumbnail } from '@/lib/thumbnails';
import type { ReadingRecord } from '@/lib/types';

/** Object URL for a record's thumbnail, refreshed when the record changes. Revoked on cleanup. */
export function useThumbnailUrl(record: Pick<ReadingRecord, 'id' | 'hasThumbnail' | 'updatedAt'>) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
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
  }, [record.id, record.hasThumbnail, record.updatedAt]);

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

export function Thumbnail({ record }: { record: ReadingRecord }) {
  const url = useThumbnailUrl(record);
  if (url) return <img className="thumb" src={url} alt="" loading="lazy" />;
  return (
    <div className="thumb thumb-empty" aria-hidden="true">
      {(record.title.trim()[0] ?? '?').toUpperCase()}
    </div>
  );
}
