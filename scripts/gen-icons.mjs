// 生成扩展图标：纯 Node 手写 PNG 编码，避免引入图像处理依赖。
// 图形为靛蓝圆角方块 + 两条白色字幕条。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'src/icons');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([len, payload, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角矩形的有符号距离场：返回值 <= 0 表示点在内部。 */
function roundRectDistance(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const dx = Math.max(cx, 0);
  const dy = Math.max(cy, 0);
  return Math.hypot(dx, dy) + Math.min(Math.max(cx, cy), 0) - r;
}

const BG = [79, 70, 229]; // #4F46E5
const FG = [255, 255, 255];
const SS = 4; // 超采样倍率，用于边缘抗锯齿

/** 归一化坐标 (0..1) 下返回该点的颜色：返回 [r,g,b,a]，a 为 0..1。 */
function sampleColor(u, v) {
  const bgDist = roundRectDistance(u, v, 0.06, 0.06, 0.88, 0.88, 0.2);
  if (bgDist > 0) return [0, 0, 0, 0];
  // 两条字幕条
  const bar1 = roundRectDistance(u, v, 0.24, 0.33, 0.52, 0.13, 0.065);
  if (bar1 <= 0) return [...FG, 1];
  const bar2 = roundRectDistance(u, v, 0.24, 0.54, 0.32, 0.13, 0.065);
  if (bar2 <= 0) return [...FG, 0.74];
  return [...BG, 1];
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = sampleColor(u, v);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const off = (y * size + x) * 4;
      if (alpha > 0) {
        buf[off] = Math.round(r / a);
        buf[off + 1] = Math.round(g / a);
        buf[off + 2] = Math.round(b / a);
        buf[off + 3] = Math.round(alpha * 255);
      }
    }
  }
  return encodePng(size, buf);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = resolve(OUT_DIR, `ic${size}.png`);
  writeFileSync(file, render(size));
  console.log(`icons: ${file}`);
}
