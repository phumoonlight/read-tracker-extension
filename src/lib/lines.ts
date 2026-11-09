/**
 * Read a text Blob line by line as a stream, so a large file is never held as one string.
 * Yields each non-blank line with its 1-based line number. Accepts "\n" and "\r\n" endings;
 * a UTF-8 BOM is dropped by the decoder.
 */
export async function* readLines(blob: Blob): AsyncGenerator<{ line: string; lineNo: number }> {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let lineNo = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += value;
    let start = 0;
    let nl: number;
    while ((nl = rest.indexOf('\n', start)) >= 0) {
      const line = rest.slice(start, nl).replace(/\r$/, '');
      start = nl + 1;
      lineNo++;
      if (line.trim()) yield { line, lineNo };
    }
    rest = rest.slice(start); // keep only the unfinished line
  }
  lineNo++;
  if (rest.trim()) yield { line: rest.replace(/\r$/, ''), lineNo };
}
