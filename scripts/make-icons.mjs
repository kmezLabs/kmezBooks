// Draws the app icons (public/icons/icon-192.png, icon-512.png): a white ledger
// page with ruled lines on the theme blue. No image libraries; plain PNG via zlib.
// Run with `npm run icons`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x1f, 0x4e, 0x79];
const WHITE = [0xff, 0xff, 0xff];
const LINE = [0x9d, 0xb8, 0xd3];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pixel(x, y, size) {
  const u = x / size;
  const v = y / size;
  // The page sits inside the central 60% so it survives maskable cropping
  const inPage = u > 0.28 && u < 0.72 && v > 0.22 && v < 0.78;
  if (!inPage) return BLUE;
  const rules = [0.36, 0.46, 0.56, 0.66];
  if (u > 0.34 && u < 0.66 && rules.some((r) => Math.abs(v - r) < 0.012)) return LINE;
  if (u > 0.4 && u < 0.415) return LINE; // margin line
  return WHITE;
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [192, 512]) writeFileSync(`public/icons/icon-${size}.png`, png(size));
console.log('Wrote public/icons/icon-192.png and icon-512.png');
