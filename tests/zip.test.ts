import { describe, expect, it } from 'vitest';
import { crc32Update, createZip, looksLikeZip, readZip, readZipEntry } from '@/lib/zip';

const enc = new TextEncoder();
const blob = (s: string, type = '') => new Blob([s], { type });

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32Update(0, enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32Update(crc32Update(0, enc.encode('1234')), enc.encode('56789'))).toBe(0xcbf43926);
  });
});

describe('createZip / readZip', () => {
  it('round-trips entries (UTF-8 names, empty files, binary data)', async () => {
    const bin = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const zip = await createZip([
      { name: 'backup.json', data: blob('{"a":1}') },
      { name: 'images/ภาพ.png', data: new Blob([bin]) },
      { name: 'empty.txt', data: blob('') },
    ]);
    expect(await looksLikeZip(zip)).toBe(true);
    const entries = await readZip(zip);
    expect([...entries.keys()]).toEqual(['backup.json', 'images/ภาพ.png', 'empty.txt']);
    expect(await (await readZipEntry(zip, entries.get('backup.json')!)).text()).toBe('{"a":1}');
    const img = await readZipEntry(zip, entries.get('images/ภาพ.png')!, 'image/png');
    expect(img.type).toBe('image/png');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(bin);
    expect((await readZipEntry(zip, entries.get('empty.txt')!)).size).toBe(0);
    expect(entries.get('backup.json')!.crc).toBe(crc32Update(0, enc.encode('{"a":1}')));
  });

  it('reads an empty archive', async () => {
    const zip = await createZip([]);
    expect(zip.size).toBe(22);
    expect((await readZip(zip)).size).toBe(0);
  });

  it('reads deflated entries (archives re-zipped by other tools)', async () => {
    // Take a stored archive and swap in a deflated copy of its single entry.
    const text = 'hello hello hello hello';
    const zip = await createZip([{ name: 'a.txt', data: blob(text) }]);
    const raw = new Uint8Array(await zip.arrayBuffer());
    const nameLen = 5;
    const comp = new Uint8Array(
      await new Response(blob(text).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    );
    const local = raw.slice(0, 30 + nameLen);
    const lv = new DataView(local.buffer);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, comp.length, true);
    const central = raw.slice(30 + nameLen + text.length, 30 + nameLen + text.length + 46 + nameLen);
    const cv = new DataView(central.buffer);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, comp.length, true);
    const end = raw.slice(raw.length - 22);
    const ev = new DataView(end.buffer);
    ev.setUint32(16, local.length + comp.length, true);
    const rebuilt = new Blob([local, comp, central, end]);
    const entries = await readZip(rebuilt);
    expect(await (await readZipEntry(rebuilt, entries.get('a.txt')!)).text()).toBe(text);
  });

  it('rejects files that are not ZIPs', async () => {
    expect(await looksLikeZip(blob('{"format":"read-tracker-backup"}'))).toBe(false);
    await expect(readZip(blob('not a zip at all, definitely not'))).rejects.toThrow(/ZIP/);
  });
});
