// Generates the PWA maskable PNG icons (192 + 512) WITHOUT any image dependency —
// a tiny pure-Node PNG encoder (zlib is built in). Re-run after changing the brand:
//   node packages/client/scripts/gen-icons.mjs
//
// Design: full-bleed obsidian background (maskable-safe: no transparency, the OS can
// crop to any shape) with a centered gold "coin" disc well inside the 80% safe zone —
// the same coin motif as the wallet balance.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// --- colors (RGB) ---------------------------------------------------------
const BG = [0x0b, 0x0a, 0x0e];       // obsidian (matches theme_color)
const GOLD_HI = [0xff, 0xf3, 0xcf];  // coin highlight
const GOLD = [0xe8, 0xc8, 0x79];     // coin body
const GOLD_LO = [0xa9, 0x84, 0x2f];  // coin shadow edge

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.30;          // coin radius → 60% diameter, inside the safe zone
  const lightX = cx - r * 0.35;   // off-centre highlight for a 3-D coin look
  const lightY = cy - r * 0.40;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let col = BG;
      if (d <= r + 1) {
        // radial gold gradient from the highlight point out to the edge
        const dl = Math.hypot(x + 0.5 - lightX, y + 0.5 - lightY) / (r * 1.6);
        const t = Math.min(1, Math.max(0, dl));
        const gold = t < 0.5 ? mix(GOLD_HI, GOLD, t / 0.5) : mix(GOLD, GOLD_LO, (t - 0.5) / 0.5);
        // 1px anti-aliased edge against the background
        const edge = Math.min(1, Math.max(0, r + 0.5 - d));
        col = mix(BG, gold, edge);
      }
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 0xff;
    }
  }
  return buf;
}

// --- minimal PNG encoder (truecolor + alpha, filter 0) --------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  // filtered scanlines (filter byte 0 per row)
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = encodePng(size, renderRGBA(size));
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
