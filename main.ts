// PNG Squeeze - lossless PNG recompression for make.fun bounty
// Reads from MAKEFUN_INPUT_DIR (default /input), writes to MAKEFUN_OUTPUT_DIR (default /output)
// Each instance is <id>/image.png (1280x720 RGBA 8-bit stored PNG)
// Outputs smallest possible deterministic PNG, whole set in under 60 seconds

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// CRC-32 (ISO 3309 / PNG)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}
function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Build PNG from [type, data] pairs
function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])];
  for (const [type, data] of chunks) {
    const len = new Uint8Array(4);
    len[0] = (data.length >>> 24) & 0xFF;
    len[1] = (data.length >>> 16) & 0xFF;
    len[2] = (data.length >>> 8) & 0xFF;
    len[3] = data.length & 0xFF;
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
    const crc = crc32(new Uint8Array([...typeBytes, ...data]));
    const crcBytes = new Uint8Array([
      (crc >>> 24) & 0xFF, (crc >>> 16) & 0xFF, (crc >>> 8) & 0xFF, crc & 0xFF
    ]);
    parts.push(len, typeBytes, data, crcBytes);
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// IHDR chunk for bit depth 8, non-interlaced
function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const data = new Uint8Array(13);
  data[0] = (width >>> 24) & 0xFF; data[1] = (width >>> 16) & 0xFF;
  data[2] = (width >>> 8) & 0xFF; data[3] = width & 0xFF;
  data[4] = (height >>> 24) & 0xFF; data[5] = (height >>> 16) & 0xFF;
  data[6] = (height >>> 8) & 0xFF; data[7] = height & 0xFF;
  data[8] = 8; // bit depth
  data[9] = colourType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return data;
}

// Paeth predictor
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Apply PNG filter type to row
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  out[0] = type;
  if (type === 0) { // None
    out.set(cur, 1);
    return;
  }
  if (type === 1) { // Sub
    for (let i = 0; i < bpp; i++) out[i + 1] = cur[i];
    for (let i = bpp; i < cur.length; i++) out[i + 1] = (cur[i] - cur[i - bpp]) & 0xFF;
    return;
  }
  if (type === 2) { // Up
    if (!prev) { out.set(cur, 1); return; }
    for (let i = 0; i < cur.length; i++) out[i + 1] = (cur[i] - prev[i]) & 0xFF;
    return;
  }
  if (type === 3) { // Average
    if (!prev) {
      for (let i = 0; i < bpp; i++) out[i + 1] = cur[i];
      for (let i = bpp; i < cur.length; i++) out[i + 1] = (cur[i] - (cur[i - bpp] >> 1)) & 0xFF;
      return;
    }
    for (let i = 0; i < bpp; i++) out[i + 1] = (cur[i] - (prev[i] >> 1)) & 0xFF;
    for (let i = bpp; i < cur.length; i++) {
      const avg = ((cur[i - bpp] + prev[i]) >> 1);
      out[i + 1] = (cur[i] - avg) & 0xFF;
    }
    return;
  }
  if (type === 4) { // Paeth
    if (!prev) {
      for (let i = 0; i < bpp; i++) out[i + 1] = cur[i];
      for (let i = bpp; i < cur.length; i++) out[i + 1] = (cur[i] - cur[i - bpp]) & 0xFF;
      return;
    }
    for (let i = 0; i < bpp; i++) out[i + 1] = (cur[i] - prev[i]) & 0xFF;
    for (let i = bpp; i < cur.length; i++) {
      const p = paeth(cur[i - bpp], prev[i], prev[i - bpp]);
      out[i + 1] = (cur[i] - p) & 0xFF;
    }
    return;
  }
  // fallback
  out.set(cur, 1);
}

// Sum of absolute values of signed bytes (for filter scoring)
function signedSum(row: Uint8Array): number {
  let sum = 0;
  for (let i = 1; i < row.length; i++) {
    const v = row[i];
    sum += v > 127 ? 256 - v : v;
  }
  return sum;
}

// Decode PNG (checker-accepted subset)
function decodePng(bytes: Uint8Array): { ok: true; width: number; height: number; rgba: Uint8Array } | { ok: false; why: string } {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47 ||
      bytes[4] !== 0x0D || bytes[5] !== 0x0A || bytes[6] !== 0x1A || bytes[7] !== 0x0A) {
    return { ok: false, why: "bad signature" };
  }
  let off = 8;
  let ihdr: Uint8Array | null = null;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
  let sawIEND = false;
  while (off < bytes.length) {
    if (off + 4 > bytes.length) return { ok: false, why: "truncated length" };
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    off += 4;
    if (off + 4 > bytes.length) return { ok: false, why: "truncated type" };
    const type = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    off += 4;
    if (off + len > bytes.length) return { ok: false, why: `truncated ${type} data` };
    const data = bytes.subarray(off, off + len);
    off += len;
    if (off + 4 > bytes.length) return { ok: false, why: `truncated ${type} crc` };
    const crc = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
    off += 4;
    const crcData = new Uint8Array(4 + len);
    crcData[0] = bytes[off - len - 8];
    crcData[1] = bytes[off - len - 7];
    crcData[2] = bytes[off - len - 6];
    crcData[3] = bytes[off - len - 5];
    crcData.set(data, 4);
    if (crc32(crcData) !== crc) return { ok: false, why: `${type} CRC mismatch` };
    if (type === "IHDR") {
      if (ihdr) return { ok: false, why: "multiple IHDR" };
      ihdr = data;
    } else if (type === "PLTE") {
      if (plte) return { ok: false, why: "multiple PLTE" };
      plte = data;
    } else if (type === "tRNS") {
      if (trns) return { ok: false, why: "multiple tRNS" };
      trns = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      sawIEND = true;
      break;
    }
  }
  if (!sawIEND) return { ok: false, why: "no IEND" };
  if (!ihdr || ihdr.length !== 13) return { ok: false, why: "bad IHDR" };
  const width = (ihdr[0] << 24) | (ihdr[1] << 16) | (ihdr[2] << 8) | ihdr[3];
  const height = (ihdr[4] << 24) | (ihdr[5] << 16) | (ihdr[6] << 8) | ihdr[7];
  const bitDepth = ihdr[8];
  const colourType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];
  if (bitDepth !== 8) return { ok: false, why: "bit depth not 8" };
  if (compression !== 0) return { ok: false, why: "bad compression" };
  if (filterMethod !== 0) return { ok: false, why: "bad filter method" };
  if (interlace !== 0) return { ok: false, why: "interlaced not supported" };
  if (![0, 2, 3, 4, 6].includes(colourType)) return { ok: false, why: `bad colour type ${colourType}` };
  
  // Concatenate IDAT and inflate
  let compressed = new Uint8Array(0);
  for (const chunk of idatChunks) {
    const next = new Uint8Array(compressed.length + chunk.length);
    next.set(compressed);
    next.set(chunk, compressed.length);
    compressed = next;
  }
  let raw: Uint8Array;
  try { raw = zlib.inflateSync(compressed); } catch { return { ok: false, why: "inflate failed" }; }
  
  // Unfilter
  let bpp: number;
  if (colourType === 0) bpp = 1;
  else if (colourType === 2) bpp = 3;
  else if (colourType === 3) bpp = 1;
  else if (colourType === 4) bpp = 2;
  else bpp = 4;
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) return { ok: false, why: "bad IDAT length" };
  
  const scanlines = new Uint8Array(height * stride);
  let prev: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const cur = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = scanlines.subarray(y * stride, (y + 1) * stride);
    if (filter === 0) { out.set(cur); }
    else if (filter === 1) { // Sub
      for (let i = 0; i < bpp; i++) out[i] = cur[i];
      for (let i = bpp; i < stride; i++) out[i] = (cur[i] + out[i - bpp]) & 0xFF;
    }
    else if (filter === 2) { // Up
      if (!prev) out.set(cur);
      else for (let i = 0; i < stride; i++) out[i] = (cur[i] + prev[i]) & 0xFF;
    }
    else if (filter === 3) { // Average
      if (!prev) {
        for (let i = 0; i < bpp; i++) out[i] = cur[i];
        for (let i = bpp; i < stride; i++) out[i] = (cur[i] + (out[i - bpp] >> 1)) & 0xFF;
      } else {
        for (let i = 0; i < bpp; i++) out[i] = (cur[i] + (prev[i] >> 1)) & 0xFF;
        for (let i = bpp; i < stride; i++) out[i] = (cur[i] + ((out[i - bpp] + prev[i]) >> 1)) & 0xFF;
      }
    }
    else if (filter === 4) { // Paeth
      if (!prev) {
        for (let i = 0; i < bpp; i++) out[i] = cur[i];
        for (let i = bpp; i < stride; i++) out[i] = (cur[i] + out[i - bpp]) & 0xFF;
      } else {
        for (let i = 0; i < bpp; i++) out[i] = (cur[i] + prev[i]) & 0xFF;
        for (let i = bpp; i < stride; i++) {
          const p = paeth(out[i - bpp], prev[i], prev[i - bpp]);
          out[i] = (cur[i] + p) & 0xFF;
        }
      }
    }
    else { return { ok: false, why: `unknown filter ${filter}` }; }
    prev = out;
  }
  
  // Convert to RGBA
  const rgba = new Uint8Array(width * height * 4);
  if (colourType === 0) { // Grayscale
    for (let i = 0; i < width * height; i++) {
      const v = scanlines[i];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
    }
    if (trns) { const t = trns[0] | (trns[1] << 8); for (let i = 0; i < width * height; i++) if (scanlines[i] === t) rgba[i * 4 + 3] = 0; }
  } else if (colourType === 2) { // RGB
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = scanlines[i * 3];
      rgba[i * 4 + 1] = scanlines[i * 3 + 1];
      rgba[i * 4 + 2] = scanlines[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    if (trns && trns.length >= 6) {
      const tr = trns[0] | (trns[1] << 8);
      const tg = trns[2] | (trns[3] << 8);
      const tb = trns[4] | (trns[5] << 8);
      for (let i = 0; i < width * height; i++) {
        if (scanlines[i * 3] === tr && scanlines[i * 3 + 1] === tg && scanlines[i * 3 + 2] === tb) rgba[i * 4 + 3] = 0;
      }
    }
  } else if (colourType === 3) { // Palette
    if (!plte || plte.length % 3 !== 0) return { ok: false, why: "bad PLTE" };
    const paletteCount = plte.length / 3;
    const alpha = new Uint8Array(paletteCount).fill(255);
    if (trns) for (let i = 0; i < trns.length && i < paletteCount; i++) alpha[i] = trns[i];
    for (let i = 0; i < width * height; i++) {
      const idx = scanlines[i];
      if (idx >= paletteCount) return { ok: false, why: "palette index out of range" };
      rgba[i * 4] = plte[idx * 3];
      rgba[i * 4 + 1] = plte[idx * 3 + 1];
      rgba[i * 4 + 2] = plte[idx * 3 + 2];
      rgba[i * 4 + 3] = alpha[idx];
    }
  } else if (colourType === 4) { // Grayscale + Alpha
    for (let i = 0; i < width * height; i++) {
      const v = scanlines[i * 2];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = scanlines[i * 2 + 1];
    }
  } else if (colourType === 6) { // RGBA
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = scanlines[i * 4];
      rgba[i * 4 + 1] = scanlines[i * 4 + 1];
      rgba[i * 4 + 2] = scanlines[i * 4 + 2];
      rgba[i * 4 + 3] = scanlines[i * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

// Adler-32
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

function analyse(rgba: Uint8Array) {
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    const c = (r << 24) | (g << 16) | (b << 8) | a;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let colours: [number, number][] | null = null;
  if (counts.size <= 256) {
    colours = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }
  return { opaque, grey, colours };
}

function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key: number | null = null;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[i] : (rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8);
    if (key === null) key = v;
    else if (key !== v) return null;
  }
  if (key === null) return null;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 255) {
      const v = grey ? rgba[i] : (rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8);
      if (v === key) return null;
    }
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length / 4;
  let bpp = 0;
  if (ct === 0) bpp = 1;
  else if (ct === 2) bpp = 3;
  else if (ct === 4) bpp = 2;
  else if (ct === 6) bpp = 4;
  else throw new Error('invalid colour type');
  const out = new Uint8Array(n * bpp);
  let j = 0;
  if (ct === 0) {
    for (let i = 0; i < rgba.length; i += 4) out[j++] = rgba[i];
  } else if (ct === 2) {
    for (let i = 0; i < rgba.length; i += 4) {
      out[j++] = rgba[i];
      out[j++] = rgba[i + 1];
      out[j++] = rgba[i + 2];
    }
  } else if (ct === 4) {
    for (let i = 0; i < rgba.length; i += 4) {
      out[j++] = rgba[i];
      out[j++] = rgba[i + 3];
    }
  } else if (ct === 6) {
    out.set(rgba);
  }
  return out;
}

function paletteOrder(rgba: Uint8Array, colours: [number, number][], grey: boolean): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const n = colours.length;
  const plte = new Uint8Array(n * 3);
  const trns = grey ? null : new Uint8Array(n);
  const map = new Map<number, number>();
  for (let i = 0; i < n; i++) map.set(colours[i][0], i);
  let pi = 0, ti = 0;
  for (const [c, _] of colours) {
    const r = (c >>> 24) & 255;
    const g = (c >>> 16) & 255;
    const b = (c >>> 8) & 255;
    const a = c & 255;
    plte[pi++] = r;
    plte[pi++] = g;
    plte[pi++] = b;
    if (!grey) trns![ti++] = a;
  }
  if (grey && trns) {
    let allOpaque = true;
    for (let i = 0; i < n; i++) if (trns[i] !== 255) { allOpaque = false; break; }
    if (allOpaque) trns = null;
  }
  const indices = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < indices.length; i++) {
    const c = (rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3];
    indices[i] = map.get(c)!;
  }
  return { plte, trns, indices };
}

function paletteForm(rgba: Uint8Array, colours: [number, number][], grey: boolean, order: 'count' | 'luma'): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  if (order === 'count') return paletteOrder(rgba, colours, grey);
  const arr = [...colours].sort((a, b) => {
    const ra = (a[0] >>> 24) & 255, ga = (a[0] >>> 16) & 255, ba = (a[0] >>> 8) & 255;
    const rb = (b[0] >>> 24) & 255, gb = (b[0] >>> 16) & 255, bb = (b[0] >>> 8) & 255;
    const la = (ra * 299 + ga * 587 + ba * 114) / 1000;
    const lb = (rb * 299 + gb * 587 + bb * 114) / 1000;
    return la - lb;
  });
  return paletteOrder(rgba, arr, grey);
}

function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | 'minsum' | 'pairs' | 'brute'): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const prev = new Uint8Array(stride);
  let oi = 0;
  for (let y = 0; y < height; y++) {
    const row = samples.subarray(y * stride, (y + 1) * stride);
    let bestFilter = 0;
    let bestRow: Uint8Array | null = null;
    const tryFilter = (f: number) => {
      const buf = new Uint8Array(stride + 1);
      buf[0] = f;
      if (f === 0) {
        buf.set(row, 1);
      } else if (f === 1) {
        for (let x = 0; x < stride; x++) buf[x + 1] = (row[x] - (x >= bpp ? row[x - bpp] : 0)) & 255;
      } else if (f === 2) {
        for (let x = 0; x < stride; x++) buf[x + 1] = (row[x] - prev[x]) & 255;
      } else if (f === 3) {
        for (let x = 0; x < stride; x++) buf[x + 1] = (row[x] - (( (x >= bpp ? row[x - bpp] : 0) + prev[x] ) >> 1)) & 255;
      } else if (f === 4) {
        for (let x = 0; x < stride; x++) {
          const a = x >= bpp ? row[x - bpp] : 0;
          const b = prev[x];
          const c = x >= bpp ? prev[x - bpp] : 0;
          let p = a + b - c;
          let pa = p - a; if (pa < 0) pa = -pa;
          let pb = p - b; if (pb < 0) pb = -pb;
          let pc = p - c; if (pc < 0) pc = -pc;
          let pr = a;
          if (pb < pa) { pa = pb; pr = b; }
          if (pc < pa) pr = c;
          buf[x + 1] = (row[x] - pr) & 255;
        }
      }
      return buf;
    };
    if (typeof choice === 'number') {
      bestRow = tryFilter(choice);
    } else if (choice === 'minsum') {
      let bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const buf = tryFilter(f);
        let sum = 0;
        for (let i = 1; i < buf.length; i++) {
          const v = buf[i];
          sum += v > 127 ? 256 - v : v;
        }
        if (sum < bestSum) { bestSum = sum; bestRow = buf; }
      }
    } else if (choice === 'pairs') {
      let bestPairs = Infinity;
      for (let f = 0; f < 5; f++) {
        const buf = tryFilter(f);
        const seen = new Uint8Array(65536);
        let pairs = 0;
        for (let i = 1; i < buf.length - 1; i++) {
          const k = (buf[i] << 8) | buf[i + 1];
          if (!seen[k]) { seen[k] = 1; pairs++; }
        }
        if (pairs < bestPairs) { bestPairs = pairs; bestRow = buf; }
      }
    } else if (choice === 'brute') {
      let bestLen = Infinity;
      const dictSize = 32768;
      const dict = new Uint8Array(dictSize);
      let dictLen = 0;
      for (let f = 0; f < 5; f++) {
        const buf = tryFilter(f);
        const compressed = zlib.deflateSync(buf, { level: 4, dictionary: dictLen > 0 ? dict.subarray(0, dictLen) : undefined });
        if (compressed.length < bestLen) { bestLen = compressed.length; bestRow = buf; }
      }
      const toAdd = bestRow!.length;
      if (toAdd >= dictSize) {
        dict.set(bestRow!.subarray(toAdd - dictSize));
        dictLen = dictSize;
      } else {
        if (dictLen + toAdd > dictSize) {
          dict.copyWithin(0, dictLen + toAdd - dictSize, dictLen);
          dictLen = dictSize - toAdd;
        }
        dict.set(bestRow!, dictLen);
        dictLen += toAdd;
      }
    }
    out.set(bestRow!, oi);
    oi += bestRow!.length;
    prev.set(row);
  }
  return out;
}

function formsOf(rgba: Uint8Array): Array<{ colourType: number; bpp: number; samples: Uint8Array; plte?: Uint8Array; trns?: Uint8Array; filters: (number | 'minsum' | 'pairs' | 'brute')[] }> {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Array<{ colourType: number; bpp: number; samples: Uint8Array; plte?: Uint8Array; trns?: Uint8Array; filters: (number | 'minsum' | 'pairs' | 'brute')[] }> = [];
  if (colours) {
    const countForm = paletteForm(rgba, colours, grey, 'count');
    forms.push({ colourType: 3, bpp: 1, samples: countForm.indices, plte: countForm.plte, trns: countForm.trns ?? undefined, filters: [0] });
    const lumaForm = paletteForm(rgba, colours, grey, 'luma');
    forms.push({ colourType: 3, bpp: 1, samples: lumaForm.indices, plte: lumaForm.plte, trns: lumaForm.trns ?? undefined, filters: [0, 'minsum', 'brute'] });
  }
  if (grey) {
    const key = opaque ? null : transparentKey(rgba, true);
    if (opaque) {
      forms.push({ colourType: 0, bpp: 1, samples: samplesOf(rgba, 0), filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
    } else if (key !== null) {
      const samples = samplesOf(rgba, 0);
      forms.push({ colourType: 0, bpp: 1, samples, trns: new Uint8Array([0, key]), filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
    } else {
      forms.push({ colourType: 4, bpp: 2, samples: samplesOf(rgba, 4), filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
    }
  } else {
    const key = opaque ? null : transparentKey(rgba, false);
    if (opaque) {
      forms.push({ colourType: 2, bpp: 3, samples: samplesOf(rgba, 2), filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
    } else if (key !== null) {
      const samples = samplesOf(rgba, 2);
      forms.push({ colourType: 2, bpp: 3, samples, trns: new Uint8Array([0, (key >>> 24) & 255, 0, (key >>> 16) & 255, 0, (key >>> 8) & 255]), filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
    } else {
      forms.push({ colourType: 6, bpp: 4, samples: samplesOf(rgba, 6), filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
    }
  }
  return forms;
}

function screen(rgba: Uint8Array, width: number, height: number): { form: any; choice: any; data: Uint8Array; zlib: Uint8Array; bytes: number } {
  const forms = formsOf(rgba);
  let best: { form: any; choice: any; data: Uint8Array; zlib: Uint8Array; bytes: number } | null = null;
  for (const form of forms) {
    for (const choice of form.filters) {
      const filteredData = filtered(form.samples, width, height, form.bpp, choice);
      const zlibData = zlib.deflateSync(filteredData, { level: 6 });
      let chunkBytes = zlibData.length;
      if (form.plte) chunkBytes += 12 + form.plte.length + 12;
      if (form.trns) chunkBytes += 12 + form.trns.length + 12;
      if (!best || chunkBytes < best.bytes) {
        best = { form, choice, data: filteredData, zlib: zlibData, bytes: chunkBytes };
      }
    }
  }
  return best!;
}

function pngOfForm(width: number, height: number, form: any, idat: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width, false);
  new DataView(ihdr.buffer).setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = form.colourType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  if (form.plte) chunks.push(chunk('PLTE', form.plte));
  if (form.trns) chunks.push(chunk('tRNS', form.trns));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', new Uint8Array(0)));
  const out = new Uint8Array(8 + chunks.reduce((a, b) => a + b.length, 0));
  out[0] = 0x89; out[1] = 0x50; out[2] = 0x4E; out[3] = 0x47;
  out[4] = 0x0D; out[5] = 0x0A; out[6] = 0x1A; out[7] = 0x0A;
  let off = 8;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  new DataView(out.buffer).setUint32(8 + data.length, crc, false);
  return out;
}

// (duplicate CRC helpers removed: chunk A already defines CRC_TABLE and crc32)

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

function lenSymbol(len: number): number {
  if (len < 3 || len > 258) return -1
  let i = 0
  while (i < LEN_BASE.length - 1 && LEN_BASE[i + 1] <= len) i++
  return 257 + i
}

function distSymbol(d: number): number {
  if (d < 1 || d > 32768) return -1
  let i = 0
  while (i < DIST_BASE.length - 1 && DIST_BASE[i + 1] <= d) i++
  return i
}

function huffmanLengths(freq: number[], maxBits: number): number[] | null {
  const n = freq.length
  const heap: number[] = []
  for (let i = 0; i < n; i++) {
    if (freq[i] > 0) heap.push(i)
  }
  if (heap.length === 0) return new Array(n).fill(0)
  if (heap.length === 1) {
    const lens = new Array(n).fill(0)
    lens[heap[0]] = 1
    return lens
  }
  heap.sort((a, b) => freq[a] - freq[b] || a - b)
  const parent = new Array(2 * n).fill(-1)
  const weight = new Array(2 * n).fill(0)
  for (let i = 0; i < heap.length; i++) weight[heap[i]] = freq[heap[i]]
  let nextNode = n
  const q = [...heap]
  while (q.length > 1) {
    q.sort((a, b) => weight[a] - weight[b] || a - b)
    const a = q.shift()!
    const b = q.shift()!
    parent[a] = nextNode
    parent[b] = nextNode
    weight[nextNode] = weight[a] + weight[b]
    q.push(nextNode)
    nextNode++
  }
  const root = q[0]
  const lens = new Array(n).fill(0)
  const stack: number[] = [root]
  const depth: number[] = [0]
  while (stack.length) {
    const node = stack.pop()!
    const d = depth.pop()!
    if (node < n) {
      lens[node] = d || 1
    } else {
      for (let i = 0; i < 2 * n; i++) {
        if (parent[i] === node) {
          stack.push(i)
          depth.push(d + 1)
        }
      }
    }
  }
  let maxLen = 0
  for (const l of lens) if (l > maxLen) maxLen = l
  if (maxLen <= maxBits) return lens
  for (let i = 0; i < n; i++) {
    if (lens[i] > maxBits) lens[i] = maxBits
  }
  const target = 1 << maxBits
  let sum = 0
  for (const l of lens) sum += 1 << (maxBits - l)
  if (sum === target) return lens
  let i = 0
  while (sum > target && i < n) {
    if (lens[i] < maxBits) {
      const delta = 1 << (maxBits - lens[i] - 1)
      if (sum - delta >= target) {
        lens[i]++
        sum -= delta
      }
    }
    i++
  }
  i = n - 1
  while (sum < target && i >= 0) {
    if (lens[i] > 1) {
      const delta = 1 << (maxBits - lens[i])
      if (sum + delta <= target) {
        lens[i]--
        sum += delta
      }
    }
    i--
  }
  return sum === target ? lens : null
}

function codesFromLengths(len: number[]): number[] {
  const maxLen = Math.max(...len)
  const blCount = new Array(maxLen + 1).fill(0)
  for (const l of len) if (l > 0) blCount[l]++
  const nextCode = new Array(maxLen + 1).fill(0)
  let code = 0
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1
    nextCode[bits] = code
  }
  const codes = new Array(len.length).fill(0)
  for (let i = 0; i < len.length; i++) {
    const l = len[i]
    if (l > 0) codes[i] = nextCode[l]++
  }
  return codes
}

// (unused BitWriter removed: the emit code uses the BitWriter defined later, with writeBits/flush/getData)

function tokenize(data: Uint8Array, start: number, end: number, chainLimit: number): {lit: Uint8Array; lens: Uint16Array; dists: Uint16Array} {
  const n = end - start;
  if (n <= 0) return {lit: new Uint8Array(0), lens: new Uint16Array(0), dists: new Uint16Array(0)};
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const HASH_MASK = HASH_SIZE - 1;
  const MAX_MATCH = 258;
  const MIN_MATCH = 3;
  const MAX_DIST = 32768;
  const SHORT_CHAIN = 1024;
  const LONG_MATCH_THRESHOLD = 200;

  const head = new Int32Array(HASH_SIZE);
  head.fill(-1);
  const prev = new Int32Array(n);

  const lit: number[] = [];
  const lens: number[] = [];
  const dists: number[] = [];

  let pos = 0;
  while (pos < n) {
    let bestLen = 0;
    let bestDist = 0;
    const maxMatch = Math.min(MAX_MATCH, n - pos);
    if (maxMatch >= MIN_MATCH) {
      const h = ((data[start + pos] << 16) | (data[start + pos + 1] << 8) | data[start + pos + 2]) & HASH_MASK;
      let cur = head[h];
      let chain = 0;
      while (cur !== -1 && chain < chainLimit) {
        const dist = pos - cur;
        if (dist > MAX_DIST) break;
        if (data[start + cur + bestLen] !== data[start + pos + bestLen]) {
          cur = prev[cur];
          chain++;
          continue;
        }
        let len = 0;
        while (len < maxMatch && data[start + cur + len] === data[start + pos + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= maxMatch) break;
        }
        cur = prev[cur];
        chain++;
      }
    }
    if (bestLen >= MIN_MATCH) {
      let lazyLen = 0;
      let lazyDist = 0;
      if (pos + 1 < n) {
        const maxMatch2 = Math.min(MAX_MATCH, n - pos - 1);
        if (maxMatch2 >= MIN_MATCH) {
          const h2 = ((data[start + pos + 1] << 16) | (data[start + pos + 2] << 8) | data[start + pos + 3]) & HASH_MASK;
          let cur2 = head[h2];
          let chain2 = 0;
          while (cur2 !== -1 && chain2 < chainLimit) {
            const dist2 = pos + 1 - cur2;
            if (dist2 > MAX_DIST) break;
            if (data[start + cur2 + lazyLen] !== data[start + pos + 1 + lazyLen]) {
              cur2 = prev[cur2];
              chain2++;
              continue;
            }
            let len2 = 0;
            while (len2 < maxMatch2 && data[start + cur2 + len2] === data[start + pos + 1 + len2]) len2++;
            if (len2 > lazyLen) {
              lazyLen = len2;
              lazyDist = dist2;
              if (len2 >= maxMatch2) break;
            }
            cur2 = prev[cur2];
            chain2++;
          }
        }
      }
      if (lazyLen > bestLen) {
        lit.push(data[start + pos]);
        lens.push(0);
        dists.push(0);
        const h = ((data[start + pos] << 16) | (data[start + pos + 1] << 8) | data[start + pos + 2]) & HASH_MASK;
        prev[pos] = head[h];
        head[h] = pos;
        pos++;
        continue;
      }
      lens.push(bestLen);
      dists.push(bestDist);
      lit.push(0);
      for (let i = 0; i < bestLen; i++) {
        const h = ((data[start + pos + i] << 16) | (data[start + pos + i + 1] << 8) | data[start + pos + i + 2]) & HASH_MASK;
        prev[pos + i] = head[h];
        head[h] = pos + i;
      }
      if (bestLen >= LONG_MATCH_THRESHOLD && chainLimit > SHORT_CHAIN) {
        chainLimit = SHORT_CHAIN;
      }
      pos += bestLen;
    } else {
      lit.push(data[start + pos]);
      lens.push(0);
      dists.push(0);
      const h = ((data[start + pos] << 16) | (data[start + pos + 1] << 8) | data[start + pos + 2]) & HASH_MASK;
      prev[pos] = head[h];
      head[h] = pos;
      pos++;
    }
  }
  return {lit: new Uint8Array(lit), lens: new Uint16Array(lens), dists: new Uint16Array(dists)};
}

// (duplicate Huffman tables removed: the plain-array tables above are the ones used)

function buildDynamicTables(tokens: {lit: Uint8Array; lens: Uint16Array; dists: Uint16Array}): {
  litLen: Uint16Array; distLen: Uint16Array; clLen: Uint16Array;
  clItems: Uint16Array; hlit: number; hdist: number; hclen: number;
  litCode: Uint16Array; distCode: Uint16Array; clCode: Uint16Array
} | null {
  const {lit, lens, dists} = tokens;
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let i = 0; i < lit.length; i++) {
    if (lens[i] === 0) {
      litFreq[lit[i]]++;
    } else {
      let len = lens[i];
      let code = 257;
      while (code < 285 && LEN_BASE[code - 257 + 1] <= len) code++;
      litFreq[code]++;
      let dist = dists[i];
      let dcode = 0;
      while (dcode < 29 && DIST_BASE[dcode + 1] <= dist) dcode++;
      distFreq[dcode]++;
    }
  }
  litFreq[256] = 1;

  function buildLengths(freq: Uint32Array, maxBits: number): Uint16Array | null {
    const n = freq.length;
    const heap: number[] = [];
    const weight = new Uint32Array(2 * n);
    const parent = new Uint32Array(2 * n);
    let heapLen = 0;
    for (let i = 0; i < n; i++) {
      if (freq[i] > 0) {
        weight[i] = freq[i];
        heap.push(i);
      }
    }
    if (heap.length === 0) return null;
    if (heap.length === 1) {
      const len = new Uint16Array(n);
      len[heap[0]] = 1;
      return len;
    }
    heap.sort((a, b) => weight[a] - weight[b] || a - b);
    let node = n;
    while (heap.length > 1) {
      const a = heap.shift()!;
      const b = heap.shift()!;
      weight[node] = weight[a] + weight[b];
      parent[a] = node;
      parent[b] = node;
      let insertPos = heap.length;
      while (insertPos > 0 && (weight[heap[insertPos - 1]] > weight[node] || (weight[heap[insertPos - 1]] === weight[node] && heap[insertPos - 1] > node))) insertPos--;
      heap.splice(insertPos, 0, node);
      node++;
    }
    const root = heap[0];
    const depth = new Uint16Array(node);
    function setDepth(idx: number, d: number) {
      if (idx < n) {
        depth[idx] = d;
      } else {
        for (let i = 0; i < node; i++) {
          if (parent[i] === idx) setDepth(i, d + 1);
        }
      }
    }
    setDepth(root, 0);
    const maxDepth = Math.max(...depth.slice(0, n));
    if (maxDepth <= maxBits) return depth.slice(0, n);
    const blCount = new Uint32Array(maxBits + 1);
    for (let i = 0; i < n; i++) if (depth[i] > 0) blCount[depth[i]]++;
    let excess = 0;
    for (let bits = maxBits; bits >= 1; bits--) {
      excess = (excess + blCount[bits]) << 1;
      if (bits === maxBits) excess -= 1 << maxBits;
      else excess -= blCount[bits] << (maxBits - bits);
    }
    for (let bits = maxBits; bits >= 1 && excess > 0; bits--) {
      while (blCount[bits] > 0 && excess > 0) {
        blCount[bits]--;
        blCount[bits - 1] += 2;
        excess -= 1 << (maxBits - bits);
      }
    }
    const newDepth = new Uint16Array(n);
    let ptr = 0;
    for (let bits = 1; bits <= maxBits; bits++) {
      for (let i = 0; i < n; i++) {
        if (depth[i] === bits) newDepth[i] = bits;
      }
    }
    let sum = 0;
    for (let i = 0; i < n; i++) if (newDepth[i] > 0) sum += 1 << (maxBits - newDepth[i]);
    if (sum !== (1 << maxBits)) return null;
    return newDepth;
  }

  const litLen = buildLengths(litFreq, 15);
  if (!litLen) return null;
  const distLen = buildLengths(distFreq, 15);
  if (!distLen) return null;

  function makeCodes(lengths: Uint16Array): Uint16Array {
    const maxLen = Math.max(...lengths);
    const blCount = new Uint32Array(maxLen + 1);
    for (const l of lengths) if (l > 0) blCount[l]++;
    const nextCode = new Uint32Array(maxLen + 1);
    let code = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    const codes = new Uint16Array(lengths.length);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0) codes[i] = nextCode[lengths[i]]++;
    }
    return codes;
  }

  const litCode = makeCodes(litLen);
  const distCode = makeCodes(distLen);

  const clFreq = new Uint32Array(19);
  const clItems: number[] = [];
  function encodeLengths(lengths: Uint16Array) {
    let i = 0;
    while (i < lengths.length) {
      const len = lengths[i];
      if (len === 0) {
        let z = 0;
        while (i < lengths.length && lengths[i] === 0) { z++; i++; }
        while (z > 0) {
          if (z >= 11) { clItems.push(18); clFreq[18]++; z -= Math.min(z, 138); }
          else if (z >= 3) { clItems.push(17); clFreq[17]++; z -= Math.min(z, 10); }
          else { clItems.push(0); clFreq[0]++; z--; }
        }
      } else {
        let prev = -1;
        let rep = 0;
        while (i < lengths.length && lengths[i] === len) { rep++; i++; }
        while (rep > 0) {
          if (rep >= 3 && len === prev) { clItems.push(16); clFreq[16]++; rep -= Math.min(rep, 6); }
          else { clItems.push(len); clFreq[len]++; rep--; prev = len; }
        }
      }
    }
  }
  encodeLengths(litLen);
  encodeLengths(distLen);
  const clLen = buildLengths(clFreq, 7);
  if (!clLen) return null;
  const clCode = makeCodes(clLen);

  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;

  return {litLen, distLen, clLen, clItems: new Uint16Array(clItems), hlit, hdist, hclen, litCode, distCode, clCode};
}

function dynBitLength(tables: ReturnType<typeof buildDynamicTables>): number {
  if (!tables) return Infinity;
  let bits = 3 + 5 + 5 + 4;
  for (let i = 0; i < tables.hclen; i++) bits += 3 + tables.clLen[CL_ORDER[i]];
  for (const len of tables.litLen) if (len) bits += len;
  for (const len of tables.distLen) if (len) bits += len;
  return bits;
}

function fixBitLength(tokens: {lit: Uint8Array; lens: Uint16Array; dists: Uint16Array}): number {
  let bits = 3;
  for (let i = 0; i < tokens.lit.length; i++) {
    if (tokens.lens[i] === 0) {
      const v = tokens.lit[i];
      if (v <= 143) bits += 8;
      else if (v <= 255) bits += 9;
      else if (v <= 279) bits += 7;
      else bits += 8;
    } else {
      bits += 7;
      const len = tokens.lens[i];
      let code = 257;
      while (code < 285 && LEN_BASE[code - 257 + 1] <= len) code++;
      bits += LEN_EXTRA[code - 257];
      const dist = tokens.dists[i];
      let dcode = 0;
      while (dcode < 29 && DIST_BASE[dcode + 1] <= dist) dcode++;
      bits += 5 + DIST_EXTRA[dcode];
    }
  }
  bits += 7;
  return bits;
}

class BitWriter {
  private buf = new Uint8Array(1 << 20);
  private len = 0;
  private bitBuf = 0;
  private bitLen = 0;
  private ensure(cap: number) {
    if (this.len + ((this.bitLen + cap + 7) >> 3) >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
  }
  writeBits(val: number, len: number) {
    this.ensure(len);
    this.bitBuf |= val << this.bitLen;
    this.bitLen += len;
    while (this.bitLen >= 8) {
      this.buf[this.len++] = this.bitBuf & 0xff;
      this.bitBuf >>= 8;
      this.bitLen -= 8;
    }
  }
  flush() {
    while (this.bitLen > 0) {
      this.buf[this.len++] = this.bitBuf & 0xff;
      this.bitBuf >>= 8;
      this.bitLen -= 8;
    }
  }
  align() {
    if (this.bitLen > 0) {
      this.buf[this.len++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitLen = 0;
    }
  }
  getData(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

function emitFixed(w: BitWriter, tokens: {lit: Uint8Array; lens: Uint16Array; dists: Uint16Array}, last: boolean) {
  w.writeBits(last ? 1 : 0, 1);
  w.writeBits(1, 2);
  for (let i = 0; i < tokens.lit.length; i++) {
    if (tokens.lens[i] === 0) {
      const v = tokens.lit[i];
      let code: number, len: number;
      if (v <= 143) { code = v + 0x30; len = 8; }
      else if (v <= 255) { code = v - 144 + 0x190; len = 9; }
      else if (v <= 279) { code = v - 256 + 0x00; len = 7; }
      else { code = v - 280 + 0x1c0; len = 8; }
      w.writeBits(reverseBits(code, len), len);
    } else {
      const len = tokens.lens[i];
      let code = 257;
      while (code < 285 && LEN_BASE[code - 257 + 1] <= len) code++;
      const extra = LEN_EXTRA[code - 257];
      const base = LEN_BASE[code - 257];
      if (code <= 279) w.writeBits(reverseBits(code - 256 + 0x00, 7), 7);
      else w.writeBits(reverseBits(code - 280 + 0x1c0, 8), 8);
      if (extra) w.writeBits(len - base, extra);
      const dist = tokens.dists[i];
      let dcode = 0;
      while (dcode < 29 && DIST_BASE[dcode + 1] <= dist) dcode++;
      const dextra = DIST_EXTRA[dcode];
      const dbase = DIST_BASE[dcode];
      w.writeBits(reverseBits(dcode, 5), 5);
      if (dextra) w.writeBits(dist - dbase, dextra);
    }
  }
  w.writeBits(0, 7);
}

function reverseBits(x: number, n: number): number {
  let r = 0;
  for (let i = 0; i < n; i++) r = (r << 1) | (x >> i & 1);
  return r;
}

function emitDynamic(w: BitWriter, tables: NonNullable<ReturnType<typeof buildDynamicTables>>, tokens: {lit: Uint8Array; lens: Uint16Array; dists: Uint16Array}, last: boolean) {
  w.writeBits(last ? 1 : 0, 1);
  w.writeBits(2, 2);
  w.writeBits(tables.hlit - 257, 5);
  w.writeBits(tables.hdist - 1, 5);
  w.writeBits(tables.hclen - 4, 4);
  for (let i = 0; i < tables.hclen; i++) w.writeBits(tables.clLen[CL_ORDER[i]], 3);
  let idx = 0;
  for (const item of tables.clItems) {
    if (item === 16) {
      w.writeBits(tables.clCode[16], tables.clLen[16]);
      w.writeBits(0, 2);
    } else if (item === 17) {
      w.writeBits(tables.clCode[17], tables.clLen[17]);
      w.writeBits(0, 3);
    } else if (item === 18) {
      w.writeBits(tables.clCode[18], tables.clLen[18]);
      w.writeBits(0, 7);
    } else {
      w.writeBits(tables.clCode[item], tables.clLen[item]);
    }
  }
  for (let i = 0; i < tokens.lit.length; i++) {
    if (tokens.lens[i] === 0) {
      w.writeBits(tables.litCode[tokens.lit[i]], tables.litLen[tokens.lit[i]]);
    } else {
      const len = tokens.lens[i];
      let code = 257;
      while (code < 285 && LEN_BASE[code - 257 + 1] <= len) code++;
      w.writeBits(tables.litCode[code], tables.litLen[code]);
      const extra = LEN_EXTRA[code - 257];
      if (extra) w.writeBits(len - LEN_BASE[code - 257], extra);
      const dist = tokens.dists[i];
      let dcode = 0;
      while (dcode < 29 && DIST_BASE[dcode + 1] <= dist) dcode++;
      w.writeBits(tables.distCode[dcode], tables.distLen[dcode]);
      const dextra = DIST_EXTRA[dcode];
      if (dextra) w.writeBits(dist - DIST_BASE[dcode], dextra);
    }
  }
  w.writeBits(tables.litCode[256], tables.litLen[256]);
}

function customDeflate(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  const tokens = tokenize(data, 0, data.length, 4096);
  emitFixed(w, tokens, true);
  w.flush();
  return w.getData();
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR || '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const START_TIME = Date.now();
const TIME_LIMIT_MS = 45_000;

const ids = fs.readdirSync(INPUT_DIR).sort();
for (const id of ids) {
  const inputPath = path.join(INPUT_DIR, id, 'image.png');
  const inputData = fs.readFileSync(inputPath);
  
  const dec = decodePng(inputData);
  if (!dec.ok) throw new Error(`Failed to decode ${id}: ${dec.why}`);
  
  const winner = screen(dec.rgba, dec.width, dec.height);
  const filtered = winner.data;
  
  const elapsed = Date.now() - START_TIME;
  const useCustom = elapsed < TIME_LIMIT_MS;
  
  const zlibDefault = zlib.deflateSync(filtered, { level: 9 });
  const zlibFiltered = zlib.deflateSync(filtered, { level: 9, strategy: 1 });
  
  let smallest = zlibDefault;
  if (zlibFiltered.length < smallest.length) smallest = zlibFiltered;
  
  if (useCustom) {
    const raw = customDeflate(filtered);
    let a = 1, b = 0;
    for (const byte of filtered) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    const adler = (b << 16) | a;
    const wrapped = new Uint8Array(2 + raw.length + 4);
    wrapped[0] = 0x78;
    wrapped[1] = 0xda;
    wrapped.set(raw, 2);
    wrapped[wrapped.length - 4] = (adler >>> 24) & 0xff;
    wrapped[wrapped.length - 3] = (adler >>> 16) & 0xff;
    wrapped[wrapped.length - 2] = (adler >>> 8) & 0xff;
    wrapped[wrapped.length - 1] = adler & 0xff;
    if (wrapped.length < smallest.length) smallest = wrapped;
  }
  
  const outPNG = pngOfForm(dec.width, dec.height, winner.form, smallest);
  
  fs.mkdirSync(path.join(OUTPUT_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, id, 'image.png'), outPNG);
}