import { IMAGES, req, withTx } from './db';

/**
 * Record images live in the "images" store of the extension's IndexedDB.
 * `blob` is the original file, never re-encoded or resized; the viewer shows it at
 * full resolution. `preview` is a small copy used only for card covers and tiles,
 * so a grid of cards never has to decode full-size files. Writes go through
 * storage.ts (addImages / removeImage / setCoverImage), which keeps the record's
 * `images` list in the same transaction.
 */
export interface StoredImage {
  id: string;
  recordId: string;
  /** Original file. */
  blob: Blob;
  /** Small copy for cards (may be the original itself if it could not be scaled, e.g. SVG). */
  preview: Blob;
  width?: number;
  height?: number;
  /** Epoch ms; 0 for images converted from pre-v3 thumbnails. */
  addedAt: number;
}

/** A prepared image, ready to store. */
export type NewImage = Pick<StoredImage, 'blob' | 'preview' | 'width' | 'height'>;

/** Largest accepted file. Generous, but stops someone saving a 500 MB file by mistake. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const PREVIEW_WIDTH = 480;
const PREVIEW_MAX_HEIGHT = 900;
const PREVIEW_QUALITY = 0.82;

export const getImage = (id: string) =>
  withTx(IMAGES, 'readonly', (tx) => req(tx.objectStore(IMAGES).get(id)) as Promise<StoredImage | undefined>);

export async function getImagePreview(id: string): Promise<Blob | undefined> {
  return (await getImage(id))?.preview;
}

/**
 * Validate an image file and build its preview. The original blob is returned unchanged.
 * Throws a user-facing error for non-images and oversized files.
 */
export async function prepareImage(blob: Blob): Promise<NewImage> {
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB).`);
  }
  // Some servers send images with no type or a generic one (e.g. og:image from a CDN),
  // so a missing / octet-stream type is accepted if the bytes decode as an image.
  const declared = blob.type;
  const untyped = declared === '' || declared === 'application/octet-stream';
  if (!untyped && !declared.startsWith('image/')) throw new Error('That file is not an image.');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    if (untyped) throw new Error('That file is not an image.');
    // A declared image the decoder can't read (e.g. SVG) still displays fine in <img>.
    return { blob, preview: blob };
  }
  try {
    const { width, height } = bitmap;
    // Give untyped originals a real image type (same bytes), so backups export them as
    // data:image/... and "Open original" displays instead of downloading.
    const original = untyped
      ? new Blob([blob], { type: sniffImageType(new Uint8Array(await blob.slice(0, 16).arrayBuffer())) ?? 'image/png' })
      : blob;
    return { blob: original, preview: await scaleForPreview(bitmap), width, height };
  } finally {
    bitmap.close();
  }
}

/** Image MIME type from a file's first bytes, or undefined if not recognised. */
export function sniffImageType(b: Uint8Array): string | undefined {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif';
  if (ascii(0, 'BM')) return 'image/bmp';
  return undefined;
}

/** Preview: PREVIEW_WIDTH wide at most (never upscaled), cropped from the top if very tall, WebP. */
async function scaleForPreview(bitmap: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, PREVIEW_WIDTH / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.min(Math.max(1, Math.round(bitmap.height * scale)), PREVIEW_MAX_HEIGHT);
  const srcHeight = Math.min(bitmap.height, Math.round(height / scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, bitmap.width, srcHeight, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/webp', quality: PREVIEW_QUALITY });
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
  if (!dataUrl.startsWith('data:image/')) throw new Error('Not an image data URL');
  return (await fetch(dataUrl)).blob();
}
