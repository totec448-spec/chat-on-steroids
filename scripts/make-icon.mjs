/**
 * Generates every icon the project ships, with no image dependencies.
 *
 *   build/icon.ico            the Windows app icon (6 sizes in one file)
 *   build/icon.png            1024px source for macOS/Linux packaging (Retina-ready ICNS input)
 *   build/icon-preview.png    256px preview, for looking at what changed
 *   build/runtime-icon.png    256px Linux BrowserWindow icon, packaged as a real resource
 *   extension/icons/*.png     16/32/48/128 for the Chrome extension
 *
 *   artwork/app-icon-source.png  selected ImageGen concept (the one source image)
 *
 * The selected concept is a single continuous ribbon that folds into both a folder
 * pocket and a conversation tail. It keeps the old product meaning while matching the
 * monochrome, generously rounded app redesign. The source is decoded, reduced to the
 * UI's ink/paper palette, and area-resampled here so every shipped size is reproducible.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const EXTENSION_SIZES = [128, 48, 32, 16];
const SOURCE_PATH = path.join(root, 'artwork', 'app-icon-source.png');
const INK = [12, 12, 14];
const PAPER = [244, 244, 246];

// ------------------------------------------------------------- source png

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

/** Decode the one controlled RGBA source PNG without adding a native image dependency. */
function decodeSourcePng(encoded) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (encoded.length < signature.length || !encoded.subarray(0, 8).equals(signature)) {
    throw new Error('artwork/app-icon-source.png is not a PNG');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];
  for (let offset = 8; offset + 12 <= encoded.length; ) {
    const length = encoded.readUInt32BE(offset);
    const type = encoded.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > encoded.length) throw new Error('truncated app icon PNG');
    if (type === 'IHDR') {
      width = encoded.readUInt32BE(start);
      height = encoded.readUInt32BE(start + 4);
      bitDepth = encoded[start + 8];
      colourType = encoded[start + 9];
      interlace = encoded[start + 12];
    } else if (type === 'IDAT') {
      idat.push(encoded.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (width < 1 || height < 1 || bitDepth !== 8 || colourType !== 6 || interlace !== 0 || idat.length === 0) {
    throw new Error('app icon source must be a non-interlaced 8-bit RGBA PNG');
  }

  const stride = width * 4;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error('unexpected app icon PNG data length');
  const pixels = Buffer.alloc(width * height * 4);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[input++];
    if (filter > 4) throw new Error(`unsupported app icon PNG filter ${filter}`);
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[row + x - 4] : 0;
      const up = y > 0 ? pixels[row + x - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[row + x - stride - 4] : 0;
      let value = inflated[input++];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) value += paeth(left, up, upperLeft);
      pixels[row + x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

const source = decodeSourcePng(readFileSync(SOURCE_PATH));

/**
 * Image generation left a handful of isolated opaque flecks outside the mark. Keep the
 * largest alpha-connected component only; the ribbon, its outline and the local dot are
 * one continuous component, while dust is not. The threshold also discards the model's
 * near-transparent shadow matte before any downsampling can turn it into a grey halo.
 */
function sourceMask() {
  const count = source.width * source.height;
  const labels = new Uint32Array(count);
  const queue = new Int32Array(count);
  let nextLabel = 0;
  let largestLabel = 0;
  let largestSize = 0;
  for (let start = 0; start < count; start++) {
    if (labels[start] !== 0 || source.pixels[start * 4 + 3] < 32) continue;
    const label = ++nextLabel;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const index = queue[head++];
      const x = index % source.width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x + 1 < source.width ? index + 1 : -1,
        index >= source.width ? index - source.width : -1,
        index + source.width < count ? index + source.width : -1
      ];
      for (const neighbour of neighbours) {
        if (
          neighbour < 0 ||
          labels[neighbour] !== 0 ||
          source.pixels[neighbour * 4 + 3] < 32
        ) {
          continue;
        }
        labels[neighbour] = label;
        queue[tail++] = neighbour;
      }
    }
    if (tail > largestSize) {
      largestLabel = label;
      largestSize = tail;
    }
  }
  if (largestLabel === 0) throw new Error('app icon source contains no visible component');
  const mask = new Uint8Array(count);
  for (let index = 0; index < count; index++) if (labels[index] === largestLabel) mask[index] = 1;
  return mask;
}

const visibleSource = sourceMask();

/** Tight square crop with deliberate breathing room, derived from visible source alpha. */
function sourceCrop() {
  let left = source.width;
  let top = source.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (visibleSource[y * source.width + x] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('app icon source contains no visible pixels');
  const visible = Math.max(right - left + 1, bottom - top + 1);
  const side = visible / 0.84; // 8% transparent padding on every side.
  return {
    left: (left + right + 1 - side) / 2,
    top: (top + bottom + 1 - side) / 2,
    side
  };
}

const crop = sourceCrop();

/**
 * Area-resample the generated concept after collapsing its near-monochrome shading to
 * the exact renderer palette. Premultiplied accumulation keeps transparent edges clean.
 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    const y0 = crop.top + (py * crop.side) / size;
    const y1 = crop.top + ((py + 1) * crop.side) / size;
    for (let px = 0; px < size; px++) {
      const x0 = crop.left + (px * crop.side) / size;
      const x1 = crop.left + ((px + 1) * crop.side) / size;
      let alphaWeight = 0;
      let totalWeight = 0;
      const premultiplied = [0, 0, 0];
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        if (sy < 0 || sy >= source.height) continue;
        const yWeight = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          if (sx < 0 || sx >= source.width) continue;
          const xWeight = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const weight = Math.max(0, xWeight) * Math.max(0, yWeight);
          if (weight === 0) continue;
          const sourceIndex = sy * source.width + sx;
          if (visibleSource[sourceIndex] === 0) continue;
          const at = sourceIndex * 4;
          const alpha = source.pixels[at + 3] / 255;
          const luminance =
            source.pixels[at] * 0.2126 + source.pixels[at + 1] * 0.7152 + source.pixels[at + 2] * 0.0722;
          const colour = luminance >= 128 ? PAPER : INK;
          for (let channel = 0; channel < 3; channel++) {
            premultiplied[channel] += colour[channel] * alpha * weight;
          }
          alphaWeight += alpha * weight;
          totalWeight += weight;
        }
      }
      const output = (py * size + px) * 4;
      if (alphaWeight > 0) {
        for (let channel = 0; channel < 3; channel++) {
          pixels[output + channel] = Math.round(premultiplied[channel] / alphaWeight);
        }
      }
      pixels[output + 3] = Math.round((alphaWeight / Math.max(totalWeight, Number.EPSILON)) * 255);
    }
  }
  return pixels;
}

// -------------------------------------------------------------------- png

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// -------------------------------------------------------------------- ico

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// ------------------------------------------------------------------- main

const cache = new Map();
const pngFor = (size) => {
  if (!cache.has(size)) cache.set(size, encodePng(size, render(size)));
  return cache.get(size);
};

mkdirSync(path.join(root, 'build'), { recursive: true });
const icoImages = ICO_SIZES.map((size) => ({ size, png: pngFor(size) }));
writeFileSync(path.join(root, 'build', 'icon.ico'), encodeIco(icoImages));
writeFileSync(path.join(root, 'build', 'icon.png'), pngFor(1024));
writeFileSync(path.join(root, 'build', 'icon-preview.png'), pngFor(256));
writeFileSync(path.join(root, 'build', 'runtime-icon.png'), pngFor(256));
console.log(
  `Wrote build/icon.ico (${ICO_SIZES.join(', ')}), build/icon.png, build/icon-preview.png and build/runtime-icon.png`
);

const iconsDir = path.join(root, 'extension', 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const size of EXTENSION_SIZES) {
  writeFileSync(path.join(iconsDir, `icon${size}.png`), pngFor(size));
}
console.log(`Wrote extension/icons/icon{${EXTENSION_SIZES.join(',')}}.png`);
