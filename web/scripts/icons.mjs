/**
 * Generates the app icons from the logo geometry.
 *
 * Written by hand rather than pulled from an image library: the mark is a
 * rounded square with two bars, which is a handful of rectangles, and adding
 * sharp or resvg would mean a native dependency in a project whose whole
 * install story is "no native dependency".
 *
 * Run: node scripts/icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Near-black ground and near-white mark: the interface has no brand colour. */
const GROUND = [14, 16, 19];
const MARK = [241, 242, 244];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draws the mark.
 *
 * `padding` exists for the maskable variant: Android crops icons to whatever
 * shape the launcher uses, so the mark has to sit inside the safe circle or it
 * loses its corners.
 */
function render(size, padding) {
  const stride = size * 3 + 1;
  const pixels = Buffer.alloc(stride * size);

  const inset = Math.round(size * padding);
  const box = size - inset * 2;
  const stroke = Math.max(2, Math.round(box * 0.085));
  const radius = Math.round(box * 0.2);
  const barHeight = stroke;
  const barInset = Math.round(box * 0.26);

  const inRoundedFrame = (x, y) => {
    const left = inset;
    const top = inset;
    const right = inset + box - 1;
    const bottom = inset + box - 1;
    if (x < left || x > right || y < top || y > bottom) return false;

    // Corner rounding: reject pixels outside the corner radius.
    const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
    const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) return false;

    const insideLeft = left + stroke;
    const insideTop = top + stroke;
    const insideRight = right - stroke;
    const insideBottom = bottom - stroke;
    const outsideInner =
      x < insideLeft || x > insideRight || y < insideTop || y > insideBottom;

    if (outsideInner) return true;

    // The two bars, matching the logo in the interface.
    const barLeft = left + barInset;
    const barRight = right - barInset;
    if (x < barLeft || x > barRight) return false;

    const firstBarTop = top + Math.round(box * 0.3);
    const secondBarTop = top + Math.round(box * 0.55);
    return (
      (y >= firstBarTop && y < firstBarTop + barHeight) ||
      (y >= secondBarTop && y < secondBarTop + barHeight)
    );
  };

  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    pixels[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const colour = inRoundedFrame(x, y) ? MARK : GROUND;
      const at = row + 1 + x * 3;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
    }
  }

  return png(size, pixels);
}

mkdirSync(OUT, { recursive: true });

const icons = [
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  // Maskable: more padding, because launchers crop to their own shape.
  ['icon-maskable-512.png', 512, 0.24],
  // iOS ignores the manifest and uses this one, always square, never masked.
  ['apple-touch-icon.png', 180, 0.12],
  ['favicon-32.png', 32, 0.1],
];

for (const [name, size, padding] of icons) {
  writeFileSync(join(OUT, name), render(size, padding));
  process.stdout.write(`${name} (${size}px)\n`);
}
