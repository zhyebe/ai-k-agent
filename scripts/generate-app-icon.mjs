#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "build");
const publicDir = path.join(root, "public");
const SIZE = 1024;

const FILL = [16, 21, 27, 255];
const GREEN = [111, 219, 138, 255];
const BLUE = [126, 185, 238, 255];
const BORDER = [41, 50, 59, 255];

function mix(a, b, t) {
  const n = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * n),
    Math.round(a[1] + (b[1] - a[1]) * n),
    Math.round(a[2] + (b[2] - a[2]) * n),
    Math.round(a[3] + (b[3] - a[3]) * n),
  ];
}

function coverage(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance));
}

function sdRoundBox(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function rotate(x, y, cx, cy, radians) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function renderMaster() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const plate = SIZE * 0.46;
  const plateRadius = SIZE * 0.21;
  const cell = 168;
  const gap = 36;
  const origin = -cell - gap / 2;
  const cells = [
    { x: origin, y: origin, color: GREEN, alpha: 1 },
    { x: origin + cell + gap, y: origin, color: GREEN, alpha: 0.72 },
    { x: origin, y: origin + cell + gap, color: GREEN, alpha: 0.46 },
    { x: origin + cell + gap, y: origin + cell + gap, color: BLUE, alpha: 0.92 },
  ];
  const tilt = -Math.PI / 4;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let color = [0, 0, 0, 0];
      const plateCover = coverage(sdRoundBox(x, y, cx, cy, plate, plate, plateRadius));
      if (plateCover > 0) {
        color = mix(color, FILL, plateCover);
        const ring = coverage(Math.abs(sdRoundBox(x, y, cx, cy, plate, plate, plateRadius)) - 1.2);
        color = mix(color, BORDER, ring * 0.55 * plateCover);
        const [lx, ly] = rotate(x, y, cx, cy, -tilt);
        for (const cellBox of cells) {
          const cellCover = coverage(sdRoundBox(
            lx,
            ly,
            cx + cellBox.x + cell / 2,
            cy + cellBox.y + cell / 2,
            cell / 2,
            cell / 2,
            22,
          ));
          if (cellCover > 0) color = mix(color, cellBox.color, cellCover * cellBox.alpha);
        }
      }
      pixels.set(color, (y * SIZE + x) * 4);
    }
  }
  return pixels;
}

function pngFromRgba(pixels, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([header, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function scaleRgba(source, sourceSize, targetSize) {
  if (sourceSize === targetSize) return Buffer.from(source);
  const out = Buffer.alloc(targetSize * targetSize * 4);
  const scale = sourceSize / targetSize;
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const x0 = Math.floor(x * scale);
      const y0 = Math.floor(y * scale);
      const x1 = Math.min(sourceSize, Math.ceil((x + 1) * scale));
      const y1 = Math.min(sourceSize, Math.ceil((y + 1) * scale));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * sourceSize + sx) * 4;
          r += source[i];
          g += source[i + 1];
          b += source[i + 2];
          a += source[i + 3];
          count += 1;
        }
      }
      const o = (y * targetSize + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

function writeIco(target, images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  const payloads = [];
  let offset = 6 + count * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.width >= 256 ? 0 : image.width;
    entry[1] = image.height >= 256 ? 0 : image.height;
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(image.png);
    offset += image.png.length;
  }
  fs.writeFileSync(target, Buffer.concat([header, ...entries, ...payloads]));
}

function writeSvg(target) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect x="72" y="72" width="880" height="880" rx="214" fill="#10151b"/>
  <rect x="72" y="72" width="880" height="880" rx="214" fill="none" stroke="#29323b" stroke-width="6"/>
  <g transform="rotate(-45 512 512)">
    <rect x="326" y="326" width="168" height="168" rx="22" fill="#6fdb8a"/>
    <rect x="530" y="326" width="168" height="168" rx="22" fill="#6fdb8a" fill-opacity="0.72"/>
    <rect x="326" y="530" width="168" height="168" rx="22" fill="#6fdb8a" fill-opacity="0.46"/>
    <rect x="530" y="530" width="168" height="168" rx="22" fill="#7eb9ee" fill-opacity="0.92"/>
  </g>
</svg>
`;
  fs.writeFileSync(target, svg);
}

function writeIcns(iconsetDir, icnsPath) {
  const result = spawnSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath], { encoding: "utf8" });
  if (result.status !== 0) {
    console.warn(result.stderr || "iconutil unavailable; electron-builder will use icon.png");
    return false;
  }
  return true;
}

const master = renderMaster();
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
writeSvg(path.join(buildDir, "icon.svg"));
const png1024 = pngFromRgba(master, SIZE, SIZE);
fs.writeFileSync(path.join(buildDir, "icon.png"), png1024);
fs.writeFileSync(path.join(root, "electron", "icon.png"), png1024);

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const pngBySize = new Map();
for (const size of sizes) {
  pngBySize.set(size, pngFromRgba(scaleRgba(master, SIZE, size), size, size));
}
fs.writeFileSync(path.join(publicDir, "icon.png"), pngBySize.get(256));
writeIco(path.join(buildDir, "icon.ico"), [256, 48, 32, 16].map((size) => ({ width: size, height: size, png: pngBySize.get(size) })));
fs.writeFileSync(path.join(publicDir, "favicon.ico"), fs.readFileSync(path.join(buildDir, "icon.ico")));

const iconset = path.join(buildDir, "icon.iconset");
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
const iconsetFiles = {
  "icon_16x16.png": 16,
  "icon_16x16@2x.png": 32,
  "icon_32x32.png": 32,
  "icon_32x32@2x.png": 64,
  "icon_128x128.png": 128,
  "icon_128x128@2x.png": 256,
  "icon_256x256.png": 256,
  "icon_256x256@2x.png": 512,
  "icon_512x512.png": 512,
  "icon_512x512@2x.png": 1024,
};
for (const [name, size] of Object.entries(iconsetFiles)) {
  fs.writeFileSync(path.join(iconset, name), pngBySize.get(size));
}
writeIcns(iconset, path.join(buildDir, "icon.icns"));
fs.rmSync(iconset, { recursive: true, force: true });
console.log("Wrote build/icon.png, build/icon.ico, public/icon.png, electron/icon.png");
