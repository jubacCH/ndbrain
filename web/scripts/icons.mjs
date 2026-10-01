/**
 * Generates the app icons from the logo geometry.
 *
 * Written by hand rather than pulled from an image library: adding sharp or
 * resvg would mean a native dependency in a project whose whole install story
 * is "no native dependency". The mark is four rounded brackets, which is four
 * rings with one side left open.
 *
 * It draws the same mark as `BrainIcon` in `web/src/icons.tsx` — a brain built
 * out of the double brackets that make a link — set solid rather than as a
 * stroke, because an app icon is read at a glance on a dark ground and a hairline
 * disappears there. The two had silently drifted
 * apart: this file used to produce a rounded square with two bars while claiming
 * in a comment to be "matching the logo in the interface", and the menu-bar icon
 * of the Mac client is derived from the PNG this writes, so it wore the wrong
 * mark entirely. The coordinates below are the SVG's, divided by its 20-unit
 * grid, so a change there is a change here.
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
  // Finer than the SVG's 0.08, and on purpose: the SVG centres its stroke on the
  // path while this draws it inwards from the edge, so the same number reads
  // noticeably heavier. Matched by eye against the drawing at 512.
  const stroke = Math.max(2, Math.round(box * 0.062));

  /** A point of the 20-unit grid the SVG is drawn on, in pixels. */
  const at = (unit) => inset + (unit / 20) * box;

  /**
   * On the ring of a rounded rectangle, with one vertical side left open.
   *
   * That is what a bracket is: top arm, spine, bottom arm, and nothing facing
   * the middle. `opens` names the side that is missing — the corners stay, only
   * the straight run between them goes, which is what keeps `[` from looking
   * like a broken box.
   */
  const onBracket = (x, y, left, top, right, bottom, radius, opens) => {
    if (x < left || x > right || y < top || y > bottom) return false;

    // Rounding on the closed side only. A `[` has no right-hand corners to
    // round — that side is the opening — and rounding both would turn the shape
    // into a capsule, because the radius is wider than half the bracket.
    const roundLeft = opens !== 'left';
    const roundRight = opens !== 'right';
    const cx =
      roundLeft && x < left + radius
        ? left + radius
        : roundRight && x > right - radius
          ? right - radius
          : x;
    const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) return false;

    // The ring itself: inside the outer shape but not inside the inner one.
    const inLeft = left + stroke;
    const inTop = top + stroke;
    const inRight = right - stroke;
    const inBottom = bottom - stroke;
    const onRing = x < inLeft || x > inRight || y < inTop || y > inBottom;
    if (!onRing) return false;

    // The open side, minus its corners.
    const straight = y > top + radius && y < bottom - radius;
    if (opens === 'right' && x > inRight && straight) return false;
    if (opens === 'left' && x < inLeft && straight) return false;
    return true;
  };

  const inMark = (x, y) =>
    // Outer pair: `[` and `]`, rounded until they read as two hemispheres.
    onBracket(x, y, at(3), at(3.4), at(8.8), at(16.6), (3.4 / 20) * box, 'right') ||
    onBracket(x, y, at(11.2), at(3.4), at(17), at(16.6), (3.4 / 20) * box, 'left') ||
    // Inner pair, which is what makes it a double bracket rather than a frame.
    onBracket(x, y, at(6.2), at(6.2), at(8.8), at(13.8), (1.8 / 20) * box, 'right') ||
    onBracket(x, y, at(11.2), at(6.2), at(13.8), at(13.8), (1.8 / 20) * box, 'left');

  const inRoundedFrame = inMark;

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
  // The Mac client's source art. Far more padding than the web icons because a
  // macOS icon is a squircle with its own margin — `desktop/icons.mjs` masks
  // this, and a mark sized for a full square would then crowd the curve.
  //
  // 1024 rather than 512 because an `.icns` holds every size macOS draws, and
  // the largest of them is 512 at 2x. A set built from a 512 source has that
  // one upscaled, which is the size Finder shows in its own preview.
  ['icon-mac-1024.png', 1024, 0.26],
];

for (const [name, size, padding] of icons) {
  writeFileSync(join(OUT, name), render(size, padding));
  process.stdout.write(`${name} (${size}px)\n`);
}
