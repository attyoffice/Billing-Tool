/**
 * Minimal XLSX reader — pure JavaScript, no external dependencies.
 * Reads .xlsx files (Office Open XML / ZIP-based XML) and returns
 * the first worksheet as a 2-D array of strings.
 *
 * Also exposes a toCSV() helper to convert that array to CSV text.
 */
const XLSXReader = (() => {
  /* ── ZIP helpers ──────────────────────────────────────────────── */

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) {
    return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
  }

  /** Parse ZIP central directory → map of filename → {method, compSize, dataStart} */
  function parseZIP(bytes) {
    // Locate End of Central Directory record (signature PK\x05\x06)
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B &&
          bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP/XLSX file (EOCD not found)');

    const numEntries = u16(bytes, eocd + 8);
    const cdOffset   = u32(bytes, eocd + 16);

    const files = {};
    let p = cdOffset;

    for (let i = 0; i < numEntries; i++) {
      if (u32(bytes, p) !== 0x02014B50) break; // Central directory signature

      const method  = u16(bytes, p + 10);
      const cSize   = u32(bytes, p + 20);
      const fnLen   = u16(bytes, p + 28); // central-dir file name length
      const exLen   = u16(bytes, p + 30);
      const cmLen   = u16(bytes, p + 32);
      const lhOff   = u32(bytes, p + 42); // local header offset

      const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + fnLen));

      // Local file header: offset 26 = file name length, 28 = extra field length
      const lFnLen = u16(bytes, lhOff + 26);
      const lExLen = u16(bytes, lhOff + 28);
      const dataStart = lhOff + 30 + lFnLen + lExLen;

      files[name] = { method, compSize: cSize, dataStart };
      p += 46 + fnLen + exLen + cmLen;
    }
    return files;
  }

  /** Decompress a single ZIP entry (stored or deflate-raw) → Uint8Array */
  async function decompress(bytes, entry) {
    const data = bytes.slice(entry.dataStart, entry.dataStart + entry.compSize);
    if (entry.method === 0) return data; // stored — no compression

    if (entry.method !== 8) {
      throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
    }

    // Deflate-raw decompression using the browser's DecompressionStream
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();

    const chunks = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  function decode(bytes) { return new TextDecoder('utf-8').decode(bytes); }

  function unesc(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  }

  /* ── XML parsers ──────────────────────────────────────────────── */

  /**
   * Parse xl/sharedStrings.xml → array of strings.
   * Handles both plain <t> and rich-text <r><t> elements.
   */
  function parseSharedStrings(xml) {
    const arr = [];
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml)) !== null) {
      const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
      let text = '', tm;
      while ((tm = tRe.exec(m[1])) !== null) text += tm[1];
      arr.push(unesc(text));
    }
    return arr;
  }

  /** Convert a column letter string (A, B, … Z, AA, AB, …) to 1-based number */
  function colToNum(col) {
    let n = 0;
    for (const c of col) n = n * 26 + c.charCodeAt(0) - 64;
    return n;
  }

  /**
   * Parse xl/worksheets/sheet1.xml → 2-D array of strings.
   * Rows are in document order; cells within each row left-padded with '' for missing cells.
   */
  function parseSheet(xml, ss) {
    const rowMap = {}; // rowNum → { colNum → value }
    let maxCol = 0;

    const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let rowM;
    while ((rowM = rowRe.exec(xml)) !== null) {
      const rowNum = parseInt(rowM[1]);
      const cells = {};

      // Match each cell: <c r="A1" [t="s"|"str"|"inlineStr"|"b"] [s="N"]> <v>…</v> </c>
      const cellRe = /<c\s+r="([A-Z]+)(\d+)"([^>\/]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rowM[2])) !== null) {
        const colStr = cm[1];
        const attrs  = cm[3] || '';
        const inner  = cm[4] || '';
        const colN   = colToNum(colStr);
        if (colN > maxCol) maxCol = colN;

        const isStr    = /\bt="s"/.test(attrs);
        const isInline = /\bt="(?:inlineStr|str)"/.test(attrs);
        const isBool   = /\bt="b"/.test(attrs);

        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        const tMatch = inner.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/);

        let val = '';
        if (isStr && vMatch) {
          val = ss[parseInt(vMatch[1])] || '';
        } else if (isInline && tMatch) {
          val = unesc(tMatch[1]);
        } else if (isBool && vMatch) {
          val = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
        } else if (vMatch) {
          val = vMatch[1]; // raw number (may be a date serial — handled in parser)
        }

        cells[colN] = val;
      }

      if (Object.keys(cells).length > 0) rowMap[rowNum] = cells;
    }

    if (Object.keys(rowMap).length === 0) return [];

    const rowNums = Object.keys(rowMap).map(Number).sort((a, b) => a - b);
    return rowNums.map(rn => {
      const row = [];
      for (let c = 1; c <= maxCol; c++) {
        row.push(rowMap[rn][c] !== undefined ? rowMap[rn][c] : '');
      }
      return row;
    });
  }

  /* ── Public API ───────────────────────────────────────────────── */

  /**
   * Read an XLSX ArrayBuffer and return a 2-D string array of the first sheet.
   */
  async function read(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const files = parseZIP(bytes);

    const ssEntry = files['xl/sharedStrings.xml'];
    const shEntry = files['xl/worksheets/sheet1.xml'];

    if (!shEntry) throw new Error('No worksheet found in XLSX file');

    const shXML = decode(await decompress(bytes, shEntry));
    const ss = ssEntry
      ? parseSharedStrings(decode(await decompress(bytes, ssEntry)))
      : [];

    return parseSheet(shXML, ss);
  }

  /**
   * Convert a 2-D string array to a CSV string.
   * Cells containing commas, quotes, or newlines are quoted.
   */
  function toCSV(rows) {
    return rows
      .map(row =>
        row.map(cell => {
          const s = String(cell ?? '');
          return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
        }).join(',')
      )
      .join('\n');
  }

  return { read, toCSV };
})();
