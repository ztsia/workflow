// PNG in and out with Node's standard library only (node:zlib), for the pixel signal of compare.mjs.
// (decodePng, encodePng, comparePixels);
// worstTile is RMS PR #123's frameDiff (replay.mjs) moved off the browser canvas onto decoded pixels.
// The record's open question 2 (2.7's channel delta vs RMS's worst tile) is settled in the pilot:
// compare reports both, and only worstTile flags a pair "pixels changed, send to eyes".
//
// CONTRACT (tests: test/png.test.mjs)
//
//   decodePng(buffer)                  -> { width, height, data: Uint8Array (RGBA) }
//   encodePng({ width, height, data }) -> Buffer (8-bit RGBA, filter 0)
//   comparePixels(a, b, { tolerance = 16, withDiff = false })
//     -> { changed, total, ratio, sameSize, diff? }
//
//   worstTile(a, b, { width = 192, tile = 12 } = {}) -> number in [0, 1]
//     a, b = decodePng results. Different sizes -> 1. Else each image is scaled to `width` columns
//     (height = max(1, round(width * a.height / a.width))) by box-averaging the source pixels that
//     fall in each target pixel, as grey = (0.299 R + 0.587 G + 0.114 B) / 255 (alpha ignored);
//     the grey planes are cut into tile x tile squares (the last row/column of tiles may be
//     smaller), and the result is the largest mean absolute grey difference over any tile.
//     Identical images -> 0. A 24 x 24 black square on a 192 x 192 white image -> 1 (a tile that
//     is wholly inside the square differs by 1.0); the square at (0, 0), so it covers whole tiles.
//   WORST_TILE_THRESHOLD = 0.002   (RMS DEFAULT_THRESHOLD) above it a pair's pixels changed.
//
// Example: worstTile(decodePng(readFileSync('a.png')), decodePng(readFileSync('a.png'))) -> 0

import { inflateSync, deflateSync, constants as Z } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (bad signature)');
  let off = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (!/^[A-Za-z]{4}$/.test(type) || body.length !== len) {
      // Junk after the pixel data (a stray byte before IEND is common) is ignored, as browsers do.
      if (ihdr && idat.length) break;
      throw new Error(`truncated PNG: chunk ${JSON.stringify(type)} wants ${len} bytes`);
    }
    off += 12 + len;
    if (type === 'IHDR') {
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  const { width, height, depth, color, interlace } = ihdr;
  if (interlace) throw new Error('interlaced PNGs are not supported (a browser screenshot never is)');
  const channels = CHANNELS[color];
  if (!channels) throw new Error(`unknown PNG colour type ${color}`);
  if (color === 3 && !palette) throw new Error('palette PNG has no PLTE');
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  // A sync flush keeps what a short stream decoded; the size check below says whether it was enough.
  const raw = inflateSync(Buffer.concat(idat), { finishFlush: Z.Z_SYNC_FLUSH });
  if (raw.length < height * (stride + 1)) throw new Error('PNG pixel data is shorter than its size says');

  // Unfilter row by row into one contiguous buffer.
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unknown PNG row filter ${filter}`);
      row[x] = v & 0xff;
    }
  }

  // One sample, scaled to 8 bits.
  const sample = (y, i) => {
    const rowOff = y * stride;
    if (depth === 8) return px[rowOff + i];
    if (depth === 16) return px[rowOff + i * 2];
    const perByte = 8 / depth, byte = px[rowOff + Math.floor(i / perByte)];
    const shift = 8 - depth * ((i % perByte) + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return color === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const raw16 = (y, i) => (depth === 16 ? px.readUInt16BE(y * stride + i * 2) : null);
  const keyGrey = trns && color === 0 ? trns.readUInt16BE(0) : null;
  const keyRgb = trns && color === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      let r, g, b, a = 255;
      if (color === 3) {
        const idx = sample(y, s);
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (color === 0 || color === 4) {
        r = g = b = sample(y, s);
        if (color === 4) a = sample(y, s + 1);
        else if (keyGrey !== null) {
          const v = depth === 16 ? raw16(y, s) : (depth === 8 ? px[y * stride + s] : null);
          const exact = v ?? Math.round((r * ((1 << depth) - 1)) / 255);
          if (exact === keyGrey) a = 0;
        }
      } else {
        r = sample(y, s); g = sample(y, s + 1); b = sample(y, s + 2);
        if (color === 6) a = sample(y, s + 3);
        else if (keyRgb) {
          const v = depth === 16 ? [raw16(y, s), raw16(y, s + 1), raw16(y, s + 2)] : [r, g, b];
          if (v[0] === keyRgb[0] && v[1] === keyRgb[1] && v[2] === keyRgb[2]) a = 0;
        }
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng({ width, height, data }) {
  if (data.length !== width * height * 4) throw new Error(`encodePng wants ${width}x${height} RGBA (${width * height * 4} bytes), got ${data.length}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// How far two images differ: a pixel is changed when any channel (alpha included) differs by more
// than `tolerance` (0–255), which absorbs anti-aliasing noise. Images of different sizes are wholly
// changed. With `withDiff`, also an RGBA diff image: the branch's pixels faded, changed ones red.
export function comparePixels(a, b, { tolerance = 16, withDiff = false } = {}) {
  const sameSize = a.width === b.width && a.height === b.height;
  if (!sameSize) {
    const total = Math.max(a.width * a.height, b.width * b.height);
    return { changed: total, total, ratio: 1, sameSize };
  }
  const total = a.width * a.height;
  const diff = withDiff ? new Uint8Array(total * 4) : null;
  let changed = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2]), Math.abs(a.data[o + 3] - b.data[o + 3]));
    const hit = d > tolerance;
    if (hit) changed++;
    if (diff) {
      if (hit) { diff[o] = 230; diff[o + 1] = 20; diff[o + 2] = 40; diff[o + 3] = 255; }
      else {
        const grey = Math.round((b.data[o] * 0.3 + b.data[o + 1] * 0.59 + b.data[o + 2] * 0.11) * 0.25 + 191);
        diff[o] = diff[o + 1] = diff[o + 2] = grey; diff[o + 3] = 255;
      }
    }
  }
  return { changed, total, ratio: total ? changed / total : 0, sameSize, ...(diff ? { diff } : {}) };
}

export const WORST_TILE_THRESHOLD = 0.002;

// Box-averages an image's grey plane down (or up) to `width` columns. Target pixel (tx, ty) covers
// source x in [floor(tx*W/width), max(that+1, floor((tx+1)*W/width))) and y likewise. One pass over
// the source rows, accumulating each target row's sums; result is a Float64Array of w x h greys.
function scaledGrey(img, width) {
  const W = img.width;
  const H = img.height;
  const h = Math.max(1, Math.round((width * H) / W));
  const xs = new Int32Array(width);
  const xe = new Int32Array(width);
  for (let tx = 0; tx < width; tx++) {
    xs[tx] = Math.floor((tx * W) / width);
    xe[tx] = Math.max(xs[tx] + 1, Math.floor(((tx + 1) * W) / width));
  }
  const out = new Float64Array(width * h);
  const { data } = img;
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * H) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * H) / h));
    const row = ty * width;
    for (let y = y0; y < y1; y++) {
      const rowBase = y * W * 4;
      for (let tx = 0; tx < width; tx++) {
        let s = 0;
        for (let x = xs[tx]; x < xe[tx]; x++) {
          const o = rowBase + x * 4;
          s += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        }
        out[row + tx] += s;
      }
    }
    const rows = y1 - y0;
    for (let tx = 0; tx < width; tx++) {
      out[row + tx] /= (xe[tx] - xs[tx]) * rows * 255;
    }
  }
  return { w: width, h, grey: out };
}

// The largest mean absolute grey difference over any tile of the two scaled images (see the contract
// above). Tiles are cut in target pixels; the last row and column of tiles may be smaller.
export function worstTile(a, b, { width = 192, tile = 12 } = {}) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const sa = scaledGrey(a, width);
  const sb = scaledGrey(b, width);
  const { w, h } = sa;
  let worst = 0;
  for (let ty0 = 0; ty0 < h; ty0 += tile) {
    const ty1 = Math.min(h, ty0 + tile);
    for (let tx0 = 0; tx0 < w; tx0 += tile) {
      const tx1 = Math.min(w, tx0 + tile);
      let sum = 0;
      for (let ty = ty0; ty < ty1; ty++) {
        for (let tx = tx0; tx < tx1; tx++) {
          const k = ty * w + tx;
          sum += Math.abs(sa.grey[k] - sb.grey[k]);
        }
      }
      const mean = sum / ((ty1 - ty0) * (tx1 - tx0));
      if (mean > worst) worst = mean;
    }
  }
  return worst;
}
