import { IMAGES, req, withTx } from './db';

/**
 * Record images live in the "images" store of the extension's IndexedDB, as one of:
 * - a local image (`LocalImage`): `blob` is the original file, never re-encoded or resized;
 *   the viewer shows it at full resolution. `preview` is a small copy used only for card
 *   covers and tiles, so a list of cards never has to decode full-size files.
 * - a web image (`WebImage`): only its http(s) `url` is kept; the picture is loaded from the
 *   web each time it is shown (nothing is stored locally, and it is gone if the site removes it).
 * Writes go through storage.ts (addImages / removeImage / reorderImages), which keeps the
 * record's `images` list in the same transaction.
 */
interface ImageBase {
  id: string;
  recordId: string;
  width?: number;
  height?: number;
  /** Epoch ms; 0 for images converted from pre-v3 thumbnails. */
  addedAt: number;
}

export interface LocalImage extends ImageBase {
  /** Original file. */
  blob: Blob;
  /** Small copy for cards (may be the original itself if it could not be scaled, e.g. SVG). */
  preview: Blob;
  url?: undefined;
}

export interface WebImage extends ImageBase {
  /** http(s) address the image is loaded from. */
  url: string;
  blob?: undefined;
  preview?: undefined;
}

export type StoredImage = LocalImage | WebImage;

/** A prepared image, ready to store. */
export type NewImage =
  | Pick<LocalImage, 'blob' | 'preview' | 'width' | 'height'>
  | Pick<WebImage, 'url' | 'width' | 'height'>;

/** Largest accepted file. Generous, but stops someone saving a 500 MB file by mistake. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const PREVIEW_WIDTH = 480;
const PREVIEW_MAX_HEIGHT = 900;
const PREVIEW_QUALITY = 0.82;

export const getImage = (id: string) =>
  withTx(IMAGES, 'readonly', (tx) => req(tx.objectStore(IMAGES).get(id)) as Promise<StoredImage | undefined>);

/**
 * What to display for an image: a Blob for a local image (its preview, or the original file),
 * the address for a web image (which has no preview), or undefined if it doesn't exist.
 */
export async function getImageSource(id: string, original = false): Promise<Blob | string | undefined> {
  const img = await getImage(id);
  if (!img) return undefined;
  if (img.url !== undefined) return img.url;
  return original ? img.blob : img.preview;
}

/**
 * Check that a web image loads here (an extension page, sending no referrer, as the list
 * will show it) and read its size. Rejects with a user-facing error if it doesn't load.
 */
export function probeWebImage(url: string, timeoutMs = 20_000): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error('The image took too long to load.'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("That address didn't load as an image (it may not be an image, or the site may block showing it elsewhere)."));
    };
    img.src = url;
  });
}

/**
 * Validate an image file and build its preview. The original blob is returned unchanged.
 * Throws a user-facing error for non-images and oversized files.
 */
export async function prepareImage(blob: Blob): Promise<Pick<LocalImage, 'blob' | 'preview' | 'width' | 'height'>> {
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
    // Give untyped originals a real image type (same bytes), so backups name them with the
    // right extension and "Open original" displays instead of downloading.
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

/**
 * Preview: the whole image scaled to fit within PREVIEW_WIDTH × PREVIEW_MAX_HEIGHT (never
 * upscaled, never cropped, so tiles can show the full image), WebP.
 */
async function scaleForPreview(bitmap: ImageBitmap): Promise<Blob> {
  const { width: w, height: h } = previewSize(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/webp', quality: PREVIEW_QUALITY });
}

/** Copy of `list` with the item at `from` moved to index `to` (indexes clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.min(Math.max(0, to), out.length), 0, item as T);
  return out;
}

/** True if `next` is a reordering of exactly the ids in `current` (no additions, removals or duplicates). */
export function isPermutation(current: readonly string[], next: readonly string[]): boolean {
  if (current.length !== next.length || new Set(next).size !== next.length) return false;
  const have = new Set(current);
  return next.every((id) => have.has(id));
}

/** Size of a preview: fits within PREVIEW_WIDTH × PREVIEW_MAX_HEIGHT, keeps the aspect ratio, never upscales. */
export function previewSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_WIDTH / width, PREVIEW_MAX_HEIGHT / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
