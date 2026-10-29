/** Byte cursors remain replayable; a single code point may exceed the page limit by three bytes. */
export function utf8Page(data: Buffer, offset: number, maxBytes: number, complete: boolean): { offset: number; nextOffset: number; data: Buffer } {
  let start = Math.min(offset, data.length);
  // Arbitrary byte/tail offsets inside a code point include that whole code point.
  while (start > 0 && start < data.length && continuation(data[start]!)) start -= 1;
  let end = Math.min(data.length, start + maxBytes);
  if (end < data.length && continuation(data[end]!)) {
    while (end > start && continuation(data[end]!)) end -= 1;
    if (end === start) {
      end = Math.min(data.length, start + width(data[start]!));
    }
  }
  if (!complete && end === data.length && end > start) {
    let lead = end - 1;
    while (lead > start && continuation(data[lead]!)) lead -= 1;
    if (lead + width(data[lead]!) > end) end = lead;
  }
  return { offset: start, nextOffset: end, data: data.subarray(start, end) };
}
function continuation(value: number): boolean { return (value & 0xc0) === 0x80; }
function width(value: number): number { return value >= 0xf0 && value <= 0xf4 ? 4 : value >= 0xe0 && value <= 0xef ? 3 : value >= 0xc2 && value <= 0xdf ? 2 : 1; }
