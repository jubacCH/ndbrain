/**
 * Makes the Mac client's two icons out of the one the PWA already uses.
 *
 * `app/icons/icon.png` is the application icon, in the Dock and in the bundle.
 * `app/icons/tray.rgba` is the menu-bar icon, which is a different thing and
 * not a smaller version of the same thing — see `trayTemplate` below.
 *
 * Tauri's code generator decodes `bundle.icon` at build time and panics with
 * "icon … is not RGBA" on anything else, while `web/scripts/icons.mjs` writes
 * truecolour without an alpha channel. So this adds the channel — it does not
 * draw anything, because a second copy of the mark's geometry would drift from
 * the first and nobody would notice until the two icons disagreed.
 *
 * The source PNG is written by that script with filter 0 on every row, which is
 * why it can be read here with nothing but `zlib`.
 *
 * Run: node desktop/icons.mjs
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'web', 'public', 'icon-512.png');
const TARGET = join(HERE, 'app', 'icons', 'icon.png');
const TRAY = join(HERE, 'app', 'icons', 'tray.rgba');

/**
 * The menu-bar icon's side, in pixels.
 *
 * `tray-icon` draws whatever it is given at 18 pt tall (its macOS backend sets
 * the `NSImage` size to 18 and lets the bitmap scale), so the number that
 * matters is how many pixels back those 18 points. 36 is 18 pt at 2x, which is
 * every Mac this runs on.
 */
const TRAY_SIDE = 36;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

/** Every chunk of a PNG, in order, as `[type, data]`. */
function chunks(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${SOURCE} is not a PNG`);
  const out = [];
  let at = 8;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    out.push([type, file.subarray(at + 8, at + 8 + length)]);
    at += 12 + length;
  }
  return out;
}

const source = chunks(readFileSync(SOURCE));

const header = source.find(([type]) => type === 'IHDR')?.[1];
if (header === undefined) throw new Error('no IHDR');
const width = header.readUInt32BE(0);
const height = header.readUInt32BE(4);
const depth = header[8];
const colour = header[9];
if (depth !== 8 || colour !== 2) {
  throw new Error(`expected 8-bit truecolour without alpha, found depth ${depth} colour type ${colour}`);
}

const rgb = inflateSync(
  Buffer.concat(source.filter(([type]) => type === 'IDAT').map(([, data]) => data)),
);

// Filter 0 on every row, which is what the source script writes. Anything else
// would need the filters undone, and silently reading it wrong would give a
// mangled icon rather than an error.
const sourceStride = width * 3 + 1;
for (let y = 0; y < height; y += 1) {
  if (rgb[y * sourceStride] !== 0) throw new Error(`row ${y} is filtered; this only reads filter 0`);
}

const stride = width * 4 + 1;
const rgba = Buffer.alloc(stride * height);
for (let y = 0; y < height; y += 1) {
  const from = y * sourceStride + 1;
  const to = y * stride;
  rgba[to] = 0; // filter: none
  for (let x = 0; x < width; x += 1) {
    const at = to + 1 + x * 4;
    rgba[at] = rgb[from + x * 3];
    rgba[at + 1] = rgb[from + x * 3 + 1];
    rgba[at + 2] = rgb[from + x * 3 + 2];
    rgba[at + 3] = 255; // the mark is a filled square; nothing is transparent
  }
}

const out = Buffer.alloc(13);
out.writeUInt32BE(width, 0);
out.writeUInt32BE(height, 4);
out[8] = 8; // bit depth
out[9] = 6; // truecolour with alpha

writeFileSync(
  TARGET,
  Buffer.concat([
    SIGNATURE,
    chunk('IHDR', out),
    chunk('IDAT', deflateSync(rgba, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);

process.stdout.write(`app/icons/icon.png (${width}px, RGBA)\n`);

/* ---- the menu-bar icon --------------------------------------------------- */

/**
 * The template image macOS draws in the menu bar.
 *
 * A menu-bar icon is not a small app icon. macOS wants a **template**: a shape
 * in the alpha channel and nothing in the colour channels, which it then fills
 * with whatever contrasts against the bar — dark on a light bar, light on a dark
 * one, inverted while the menu is open. Handed a coloured image instead, it
 * draws the picture as it is, and this particular picture is a near-black square
 * (`GROUND` in `web/scripts/icons.mjs`), which is how the icon came to be
 * something the owner had to hunt for.
 *
 * So the mark is turned into coverage: for each pixel of the small icon, how
 * much of the area it covers was the mark rather than the ground. That is the
 * alpha; the colour is black everywhere and never read. Derived from the same
 * PNG as the app icon rather than drawn again, for the reason in the header —
 * a second copy of the geometry would drift and nobody would see it happen.
 *
 * Written as raw RGBA, not PNG, because the app has no PNG decoder: Tauri's
 * `Image::new` takes exactly these bytes and is a `const fn` over them, so the
 * icon is `include_bytes!` and cannot be missing at runtime. The silent case
 * this replaces built a tray with no icon at all and said nothing.
 */
function trayTemplate(side) {
  const mark = (x, y) => {
    const at = y * sourceStride + 1 + x * 3;
    // Nearer to the mark's colour than to the ground's. One comparison rather
    // than a threshold per channel: the two colours are a near-white and a
    // near-black, so the midpoint is not a close call.
    return rgb[at] + rgb[at + 1] + rgb[at + 2] > (GROUND_SUM + MARK_SUM) / 2;
  };

  // The app icon has a margin around the mark, because an icon in the Dock sits
  // in a tile. A menu-bar glyph does not: the bar gives it its own spacing, and
  // a glyph carrying its own margin as well renders as a mark too small to read
  // at 18 pt. So the source is cropped to the mark and the margin is left behind.
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mark(x, y)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) throw new Error(`no mark found in ${SOURCE}`);

  // Square and centred, so the mark is not stretched, plus a hair of margin to
  // keep the antialiased edge off the glyph's own boundary.
  const span = Math.max(right - left + 1, bottom - top + 1) * (1 + 2 / side);
  const originX = (left + right + 1) / 2 - span / 2;
  const originY = (top + bottom + 1) / 2 - span / 2;

  const out = Buffer.alloc(side * side * 4);
  const box = span / side;
  for (let ty = 0; ty < side; ty += 1) {
    for (let tx = 0; tx < side; tx += 1) {
      // Exact area weighting: 512 does not divide by 36, so the boxes do not
      // line up with pixel edges and nearest-neighbour would give a glyph with
      // ragged corners at the one size it is ever seen.
      let covered = 0;
      let total = 0;
      const boxLeft = originX + tx * box;
      const boxRight = boxLeft + box;
      const boxTop = originY + ty * box;
      const boxBottom = boxTop + box;
      for (let y = Math.floor(boxTop); y < Math.ceil(boxBottom); y += 1) {
        const weightY = Math.min(y + 1, boxBottom) - Math.max(y, boxTop);
        for (let x = Math.floor(boxLeft); x < Math.ceil(boxRight); x += 1) {
          const weight = weightY * (Math.min(x + 1, boxRight) - Math.max(x, boxLeft));
          total += weight;
          // Outside the source is margin, which is ground.
          const inside = x >= 0 && x < width && y >= 0 && y < height;
          if (inside && mark(x, y)) covered += weight;
        }
      }
      const at = (ty * side + tx) * 4;
      out[at] = 0;
      out[at + 1] = 0;
      out[at + 2] = 0;
      out[at + 3] = Math.round((covered / total) * 255);
    }
  }
  return out;
}

/** The two colours `web/scripts/icons.mjs` draws the mark with, as sums. */
const GROUND_SUM = 14 + 16 + 19;
const MARK_SUM = 241 + 242 + 244;

const tray = trayTemplate(TRAY_SIDE);
writeFileSync(TRAY, tray);

process.stdout.write(`app/icons/tray.rgba (${TRAY_SIDE}px, template, ${tray.length} bytes)\n`);
