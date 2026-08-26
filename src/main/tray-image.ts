import { deflateSync } from 'node:zlib';

export interface TrayRepresentation {
  /** Logical-to-physical pixel scale represented by this PNG. */
  scaleFactor: 1 | 2;
  png: Buffer;
}

export interface TrayImageSpec {
  /** macOS menu-bar images must be template images so the OS chooses light/dark contrast. */
  template: boolean;
  representations: readonly [TrayRepresentation, TrayRepresentation];
}

const LOGICAL_SIZE = 16;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Electron uses this as the NSStatusItem autosave identity on macOS. Keep it stable forever:
// changing it is equivalent to creating a brand-new menu-bar item and loses the position a user
// chose with Cmd-drag. Do not pass it on unsigned Windows builds, where Tray GUID persistence has
// different signature/path semantics.
const MACOS_TRAY_GUID = '2b43965a-ecf3-4f6b-9e3a-50a1dc93a85f';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function edgeCoverage(distance: number, radius: number): number {
  return Math.max(0, Math.min(1, radius + 0.5 - distance));
}

/**
 * Pure RGBA raster used by the tray image factory and its tests.
 *
 * Windows keeps the old green/grey status dot. Linux gets the same familiar colored mark but
 * through a portable PNG rather than a platform-dependent raw bitmap. macOS intentionally uses
 * only black + alpha, as required for menu-bar template images; disconnected is a ring so status
 * remains visible even though template images cannot carry semantic color.
 */
export function trayRgba(
  platform: NodeJS.Platform,
  running: boolean,
  scaleFactor: 1 | 2
): { size: number; rgba: Buffer } {
  const size = LOGICAL_SIZE * scaleFactor;
  const rgba = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const outerRadius = 6.2 * scaleFactor;
  const innerRadius = 3.25 * scaleFactor;
  const macTemplate = platform === 'darwin';
  const [r, g, b] = macTemplate ? [0, 0, 0] : running ? [34, 160, 90] : [130, 130, 138];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      let alpha = edgeCoverage(distance, outerRadius);
      if (macTemplate && !running) {
        // A template image has no status color. Use a hollow mark for disconnected instead.
        alpha *= 1 - edgeCoverage(distance, innerRadius);
      }
      const offset = (y * size + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }
  return { size, rgba };
}

/** Encoded, host-aware tray image data with explicit 1x and 2x representations. */
export function trayImageSpec(
  platform: NodeJS.Platform,
  running: boolean
): TrayImageSpec {
  const representations = ([1, 2] as const).map((scaleFactor) => {
    const { size, rgba } = trayRgba(platform, running, scaleFactor);
    return { scaleFactor, png: encodePng(size, rgba) };
  }) as [TrayRepresentation, TrayRepresentation];
  return { template: platform === 'darwin', representations };
}

/** Stable menu-bar identity on macOS; other platforms keep their existing tray semantics. */
export function trayGuidForPlatform(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'darwin' ? MACOS_TRAY_GUID : undefined;
}

/**
 * Optional Tray constructor tail, expressed as a tuple so unsupported platforms omit the
 * argument entirely. Electron 43 validates an explicitly-present undefined GUID and throws
 * before the rest of app startup can run; an empty tuple preserves the one-argument overload.
 */
export function trayGuidArgsForPlatform(platform: NodeJS.Platform = process.platform): [] | [string] {
  const guid = trayGuidForPlatform(platform);
  return guid ? [guid] : [];
}
