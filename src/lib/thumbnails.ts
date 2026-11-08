import { THUMBNAILS, req, withTx } from './db';

/**
 * Thumbnails are WebP Blobs in the "thumbnails" store of the extension's IndexedDB,
 * keyed by record id. Writes go through setThumbnail() in storage.ts, which also
 * updates the record's hasThumbnail flag in the same transaction.
 */
export const getThumbnail = (id: string) =>
  withTx(THUMBNAILS, 'readonly', (tx) => req(tx.objectStore(THUMBNAILS).get(id)) as Promise<Blob | undefined>);

export const THUMB_WIDTH = 300;
const MAX_HEIGHT = 600;
const QUALITY = 0.85;

/**
 * Downscale an image to THUMB_WIDTH wide (never upscales; height capped at MAX_HEIGHT,
 * cropping from the top for very tall images such as full-page screenshots) and
 * encode it as WebP.
 */
export async function resizeToThumbnail(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const fullHeight = Math.max(1, Math.round(bitmap.height * scale));
    const height = Math.min(fullHeight, MAX_HEIGHT);
    const srcHeight = Math.round(height / scale);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, bitmap.width, srcHeight, 0, 0, width, height);
    return await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
  } finally {
    bitmap.close();
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  if (!dataUrl.startsWith('data:image/')) throw new Error('Thumbnail is not an image data URL');
  return (await fetch(dataUrl)).blob();
}
