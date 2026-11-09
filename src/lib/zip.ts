/**
 * Minimal ZIP writer and reader (no dependency).
 *
 * Writer: entries are "stored" (no compression; images are already compressed). The
 * archive is assembled as a Blob from the entries' own Blobs, so building a multi-GB
 * backup doesn't copy the files into memory; only CRC-32 needs one streaming pass over
 * each. ZIP64 records are added only when sizes, offsets or the entry count need them.
 *
 * Reader: reads the central directory, then each entry on demand as a Blob slice.
 * Handles stored and deflated entries (deflate via the browser's DecompressionStream),
 * so a backup re-zipped by another tool still imports. Encrypted entries are rejected.
 */

export interface ZipInput {
  name: string;
  data: Blob;
}

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  /** Offset of the entry's local header. */
  offset: number;
  flags: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;

// ---------------------------------------------------------------------------
// CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc ^ MAX32;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ MAX32) >>> 0;
}

/** CRC-32 of a Blob, read in chunks (never the whole file in memory). */
export async function crc32OfBlob(blob: Blob): Promise<number> {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32Update(crc, value);
  }
}

// ---------------------------------------------------------------------------
// Writer

/** MS-DOS time and date fields (local time; years before 1980 clamp to 1980). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const encoder = new TextEncoder();

/** Build a ZIP archive of stored entries. Names must be unique. */
export async function createZip(inputs: readonly ZipInput[], modified = new Date()): Promise<Blob> {
  const { time, date } = dosDateTime(modified);
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const input of inputs) {
    const name = encoder.encode(input.name);
    const size = input.data.size;
    const crc = await crc32OfBlob(input.data);
    const bigSize = size >= MAX32;
    const bigOffset = offset >= MAX32;

    // Local header: when the size needs ZIP64, both sizes go in its extra field.
    const localExtra = bigSize ? zip64Extra([size, size]) : new Uint8Array(0);
    const local = new Uint8Array(30 + name.length + localExtra.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, bigSize ? 45 : 20, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, bigSize ? MAX32 : size, true);
    lv.setUint32(22, bigSize ? MAX32 : size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, localExtra.length, true);
    local.set(name, 30);
    local.set(localExtra, 30 + name.length);

    // Central header: ZIP64 extra holds only the fields that overflowed, in this order.
    const big = [...(bigSize ? [size, size] : []), ...(bigOffset ? [offset] : [])];
    const centralExtra = big.length ? zip64Extra(big) : new Uint8Array(0);
    const c = new Uint8Array(46 + name.length + centralExtra.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 45, true); // made by
    cv.setUint16(6, big.length ? 45 : 20, true); // needed
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bigSize ? MAX32 : size, true);
    cv.setUint32(24, bigSize ? MAX32 : size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, centralExtra.length, true);
    // comment length, disk number, internal / external attributes stay 0
    cv.setUint32(42, bigOffset ? MAX32 : offset, true);
    c.set(name, 46);
    c.set(centralExtra, 46 + name.length);
    central.push(c);

    parts.push(local, input.data);
    offset += local.length + size;
  }

  const cdOffset = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  for (const c of central) parts.push(c); // (not a spread: there can be many entries)

  const count = inputs.length;
  const needs64 = count >= MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;
  if (needs64) {
    const rec = new Uint8Array(56);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, SIG_EOCD64, true);
    rv.setBigUint64(4, 44n, true);
    rv.setUint16(12, 45, true);
    rv.setUint16(14, 45, true);
    // disk numbers stay 0
    rv.setBigUint64(24, BigInt(count), true);
    rv.setBigUint64(32, BigInt(count), true);
    rv.setBigUint64(40, BigInt(cdSize), true);
    rv.setBigUint64(48, BigInt(cdOffset), true);
    const loc = new Uint8Array(20);
    const lo = new DataView(loc.buffer);
    lo.setUint32(0, SIG_LOCATOR64, true);
    lo.setBigUint64(8, BigInt(cdOffset + cdSize), true);
    lo.setUint32(16, 1, true);
    parts.push(rec, loc);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, Math.min(count, MAX16), true);
  ev.setUint16(10, Math.min(count, MAX16), true);
  ev.setUint32(12, needs64 ? MAX32 : cdSize, true);
  ev.setUint32(16, needs64 ? MAX32 : cdOffset, true);
  parts.push(end);

  return new Blob(parts, { type: 'application/zip' });
}

/** ZIP64 extended information extra field (tag 0x0001) with the given 8-byte values. */
function zip64Extra(values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4 + values.length * 8);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0x0001, true);
  v.setUint16(2, values.length * 8, true);
  values.forEach((n, i) => v.setBigUint64(4 + i * 8, BigInt(n), true));
  return out;
}

// ---------------------------------------------------------------------------
// Reader

async function bytesAt(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

/** True if the Blob starts with a ZIP local header (or is an empty archive). */
export async function looksLikeZip(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  const sig = (await bytesAt(blob, 0, 4)).getUint32(0, true);
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

/** Read a ZIP's central directory. Throws a user-facing error if it isn't a readable ZIP. */
export async function readZip(blob: Blob): Promise<Map<string, ZipEntry>> {
  const bad = () => new Error('Not a valid ZIP file.');
  // The end record is 22 bytes plus a comment of up to 65535 bytes, at the very end.
  const tailStart = Math.max(0, blob.size - (22 + MAX16));
  const tail = await bytesAt(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  // ZIP64: a locator sits right before the end record and points at the ZIP64 end record.
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === SIG_LOCATOR64) {
    const recOffset = u64(tail, eocd - 20 + 8);
    const rec = await bytesAt(blob, recOffset, recOffset + 56);
    if (rec.byteLength < 56 || rec.getUint32(0, true) !== SIG_EOCD64) throw bad();
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (cdOffset + cdSize > blob.size) throw bad();

  const cd = await bytesAt(blob, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== SIG_CENTRAL) throw bad();
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > cd.byteLength) throw bad();
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));

    // ZIP64 extra: 8-byte values for exactly the fields that are 0xFFFFFFFF, in order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const tag = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (tag === 0x0001) {
        let q = e + 4;
        const next = () => {
          if (q + 8 > e + 4 + len) throw bad();
          const n = u64(cd, q);
          q += 8;
          return n;
        };
        if (size === MAX32) size = next();
        if (compressedSize === MAX32) compressedSize = next();
        if (offset === MAX32) offset = next();
      }
      e += 4 + len;
    }
    entries.set(name, { name, method, compressedSize, size, crc, offset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's contents. Stored entries are a slice of the archive (not copied). */
export async function readZipEntry(blob: Blob, entry: ZipEntry, type = ''): Promise<Blob> {
  if (entry.flags & FLAG_ENCRYPTED) throw new Error(`“${entry.name}” is encrypted.`);
  const local = await bytesAt(blob, entry.offset, entry.offset + 30);
  if (local.byteLength < 30 || local.getUint32(0, true) !== SIG_LOCAL) throw new Error('Not a valid ZIP file.');
  // The local header's extra field can differ from the central one, so use its own lengths.
  const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = blob.slice(start, start + entry.compressedSize);
  if (data.size !== entry.compressedSize) throw new Error('The ZIP file is truncated.');
  if (entry.method === 0) return type ? new Blob([data], { type }) : data;
  if (entry.method === 8) {
    const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const out = await new Response(stream).blob();
    return new Blob([out], { type });
  }
  throw new Error(`“${entry.name}” uses an unsupported compression method.`);
}
