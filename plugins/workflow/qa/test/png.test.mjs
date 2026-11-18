// decodePng, encodePng and comparePixels (lifted, sanity only) and worstTile (the step 3 stub).
// The CONTRACT comment in scripts/lib/png.mjs (lines 1-30) is the spec.
import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePixels, decodePng, encodePng, worstTile } from '../scripts/lib/png.mjs';

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

// An in-memory RGBA image, every pixel one colour, fully opaque.
function solid(width, height, rgb = WHITE) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { width, height, data };
}

// Paints a w x h rectangle of rgb into img (in place) with its top-left corner at (x, y).
function paint(img, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) img.data.set([...rgb, 255], (yy * img.width + xx) * 4);
  }
  return img;
}

function copyOf(img) {
  return { width: img.width, height: img.height, data: Uint8Array.from(img.data) };
}

test('encodePng then decodePng round-trips the width, the height and every RGBA byte', () => {
  const img = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) % 256) };
  const buf = encodePng(img);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const back = decodePng(buf);
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual(Array.from(back.data), Array.from(img.data));
});

test('comparePixels: identical images change nothing; a channel moved by more than the tolerance counts', () => {
  const a = solid(2, 2);
  assert.deepEqual(comparePixels(a, copyOf(a)), { changed: 0, total: 4, ratio: 0, sameSize: true });

  const within = copyOf(a);
  within.data[0] = 255 - 16;
  assert.equal(comparePixels(a, within).changed, 0, 'a difference equal to the tolerance (16) is not a change');

  const beyond = copyOf(a);
  beyond.data[0] = 255 - 17;
  const r = comparePixels(a, beyond);
  assert.equal(r.changed, 1);
  assert.equal(r.total, 4);
  assert.equal(r.ratio, 0.25);
});

test('comparePixels: images of different sizes are wholly changed', () => {
  const r = comparePixels(solid(2, 2), solid(3, 1));
  assert.equal(r.sameSize, false);
  assert.equal(r.ratio, 1);
  assert.equal(r.changed, 4);
  assert.equal(r.total, 4);
});

test('worstTile: an image against itself is 0', () => {
  const a = paint(solid(192, 192), 50, 50, 30, 20, BLACK);
  assert.equal(worstTile(a, copyOf(a)), 0);
});

test('worstTile: images of different sizes are 1', () => {
  assert.equal(worstTile(solid(192, 192), solid(96, 96)), 1);
});

test('worstTile: a 24 x 24 black square at (0, 0) on a 192 x 192 white image is 1 against the plain white image', () => {
  const squared = paint(solid(192, 192), 0, 0, 24, 24, BLACK);
  assert.equal(worstTile(squared, solid(192, 192)), 1);
});

test('worstTile: one changed pixel in a 192 x 192 image is above 0 and below 0.01', () => {
  const dotted = paint(solid(192, 192), 100, 100, 1, 1, BLACK);
  const v = worstTile(dotted, solid(192, 192));
  assert.ok(v > 0 && v < 0.01, `worstTile was ${v}`);
});

test('worstTile: a 384 x 384 image is scaled to 192 by box-averaging, so a 24 x 24 square at (0, 0) still scores above 0.9', () => {
  const squared = paint(solid(384, 384), 0, 0, 24, 24, BLACK);
  const v = worstTile(squared, solid(384, 384));
  assert.ok(v > 0.9, `worstTile was ${v}`);
});

test('worstTile: is symmetric, and a partly black tile scores its mean difference', () => {
  const a = paint(solid(192, 192), 0, 0, 6, 6, BLACK);
  const b = solid(192, 192);
  const ab = worstTile(a, b);
  assert.equal(worstTile(b, a), ab);
  // The tile at (0, 0) is 12 x 12 with 36 black pixels: a mean grey difference of 36 / 144.
  assert.ok(Math.abs(ab - 0.25) < 1e-6, `worstTile was ${ab}`);
});

test('worstTile: every result is between 0 and 1', () => {
  const pairs = [
    [paint(solid(192, 192), 0, 0, 24, 24, BLACK), solid(192, 192)],
    [paint(solid(192, 192), 100, 100, 1, 1, BLACK), solid(192, 192)],
    [paint(solid(384, 384), 0, 0, 24, 24, BLACK), solid(384, 384)],
    [solid(192, 192), solid(96, 96)],
  ];
  for (const [a, b] of pairs) {
    const v = worstTile(a, b);
    assert.ok(v >= 0 && v <= 1, `worstTile was ${v}`);
  }
});

test('worstTile: a decodePng(encodePng(img)) round-trip scores 0 against img', () => {
  const img = paint(solid(192, 192), 5, 5, 40, 9, [10, 200, 30]);
  assert.equal(worstTile(decodePng(encodePng(img)), img), 0);
});
