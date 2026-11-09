import { describe, expect, it } from 'vitest';
import { readLines } from '@/lib/lines';

async function all(blob: Blob) {
  const out: [number, string][] = [];
  for await (const { line, lineNo } of readLines(blob)) out.push([lineNo, line]);
  return out;
}

describe('readLines', () => {
  it('yields non-blank lines with 1-based numbers, \n or \r\n, last line without newline', async () => {
    expect(await all(new Blob(['a\r\n\nb\n', '  \nc']))).toEqual([
      [1, 'a'],
      [3, 'b'],
      [5, 'c'],
    ]);
  });
  it('joins lines split across chunks, including multi-byte characters', async () => {
    const bytes = new TextEncoder().encode('{"t":"ภาษาไทย"}\n{"t":"x"}\n');
    // Split inside a Thai character.
    const parts = [bytes.slice(0, 9), bytes.slice(9, 20), bytes.slice(20)];
    expect(await all(new Blob(parts))).toEqual([
      [1, '{"t":"ภาษาไทย"}'],
      [2, '{"t":"x"}'],
    ]);
  });
  it('handles many lines and an empty file', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`);
    const out = await all(new Blob(lines));
    expect(out.length).toBe(5000);
    expect(out[4999]).toEqual([5000, 'line 4999']);
    expect(await all(new Blob([]))).toEqual([]);
  });
});
