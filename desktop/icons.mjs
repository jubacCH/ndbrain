/**
 * Makes the app icon out of the one the PWA already uses.
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
