// Generates the PWA maskable PNG icons (192 + 512) WITHOUT any image dependency —
// a tiny pure-Node PNG encoder (zlib is built in). Re-run after changing the brand:
//   node packages/client/scripts/gen-icons.mjs
//
// Design: full-bleed maroon background (maskable-safe: no transparency, the OS can crop to any
// shape) with a centered gold ♠ SPADE (the brand mark, matching the favicon) + a faint gold ring,
// well inside the 80% safe zone. (The old design was a plain gold coin — "yellow ball".)

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// --- colors (RGB) ---------------------------------------------------------
const BG = [0x16, 0x04, 0x07];       // deep maroon (matches the favicon SVG)
const RING = [0xe6, 0xc5, 0x70];     // faint gold ring
const GOLD_HI = [0xff, 0xf3, 0xcf];  // spade highlight (top)
const GOLD = [0xe8, 0xc8, 0x79];     // spade body
const GOLD_LO = [0xa9, 0x84, 0x2f];  // spade shadow (bottom)

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// A filled ♠ in normalised coords (origin = spade centre, y DOWN). The body is the classic implicit
// "heart" curve — rendered with y pointing DOWN it flips to point-UP/lobes-DOWN (i.e. a spade) — plus
// a small trapezoid stem hanging off the bottom dimple.
function inSpade(nx, ny) {
  const a = nx * nx + ny * ny - 1;
  const body = a * a * a - nx * nx * ny * ny * ny <= 0;
  const stemTop = 0.62, stemBot = 1.5;
  const inStem = ny >= stemTop && ny <= stemBot && Math.abs(nx) <= 0.06 + (ny - stemTop) * 0.32;
  return body || inStem;
}

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size * 0.46;          // spade centre (slightly high → the stem balances it)
  const s = size * 0.255;          // scale → spade spans ~75% (inside the 80% safe zone)
  const ringR = size * 0.40;
  const ringW = size * 0.018;
  const top = cy - 1.35 * s;       // tip; bottom of stem ≈ cy + 1.5 s (for the gradient range)
  const SS = 3;                    // 3×3 supersample → smooth edges with no image lib
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let col = BG;
      // faint gold ring around the spade
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - size / 2);
      const ringCov = Math.max(0, 1 - Math.abs(d - ringR) / ringW) * 0.4;
      if (ringCov > 0) col = mix(BG, RING, ringCov);
      // spade coverage (anti-aliased via supersampling)
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inSpade((x + (sx + 0.5) / SS - cx) / s, (y + (sy + 0.5) / SS - cy) / s)) cov++;
        }
      }
      cov /= SS * SS;
      if (cov > 0) {
        // top→bottom gold gradient for depth
        const t = Math.min(1, Math.max(0, (y - top) / (2.85 * s)));
        const gold = t < 0.5 ? mix(GOLD_HI, GOLD, t / 0.5) : mix(GOLD, GOLD_LO, (t - 0.5) / 0.5);
        col = mix(col, gold, cov);
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
