import { describe, expect, it } from 'vitest';
import { trayGuidArgsForPlatform, trayGuidForPlatform, trayImageSpec, trayRgba } from '../src/main/tray-image.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function rgbaAt(rgba: Buffer, size: number, x: number, y: number): number[] {
  const offset = (y * size + x) * 4;
  return [...rgba.subarray(offset, offset + 4)];
}

describe('native tray image policy', () => {
  it.each(['win32', 'linux'] as const)('keeps a colored status dot on %s', (platform) => {
    const running = trayRgba(platform, true, 1);
    const stopped = trayRgba(platform, false, 1);

    expect(rgbaAt(running.rgba, running.size, 8, 8)).toEqual([34, 160, 90, 255]);
    expect(rgbaAt(stopped.rgba, stopped.size, 8, 8)).toEqual([130, 130, 138, 255]);
    expect(rgbaAt(running.rgba, running.size, 0, 0)[3]).toBe(0);
  });

  it('uses black-alpha template semantics and shape, not color, for macOS status', () => {
    const running = trayRgba('darwin', true, 1);
    const stopped = trayRgba('darwin', false, 1);

    expect(rgbaAt(running.rgba, running.size, 8, 8)).toEqual([0, 0, 0, 255]);
    expect(rgbaAt(stopped.rgba, stopped.size, 8, 8)).toEqual([0, 0, 0, 0]);
    expect(rgbaAt(stopped.rgba, stopped.size, 8, 3)[3]).toBeGreaterThan(0);
  });

  it.each(['win32', 'darwin', 'linux'] as const)('ships encoded PNG 1x + 2x representations on %s', (platform) => {
    const spec = trayImageSpec(platform, true);
    expect(spec.template).toBe(platform === 'darwin');
    expect(spec.representations.map((representation) => representation.scaleFactor)).toEqual([1, 2]);

    for (const representation of spec.representations) {
      expect(representation.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(representation.png.readUInt32BE(16)).toBe(16 * representation.scaleFactor);
      expect(representation.png.readUInt32BE(20)).toBe(16 * representation.scaleFactor);
    }
  });

  it('gives only macOS a stable menu-bar autosave identity', () => {
    const macGuid = trayGuidForPlatform('darwin');
    expect(macGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(trayGuidForPlatform('win32')).toBeUndefined();
    expect(trayGuidForPlatform('linux')).toBeUndefined();
    expect(trayGuidForPlatform('darwin')).toBe(macGuid);
    expect(trayGuidArgsForPlatform('darwin')).toEqual([macGuid]);
    // Electron 43 distinguishes an omitted optional GUID from an explicitly-present undefined.
    // Windows/Linux must therefore call the one-argument Tray overload.
    expect(trayGuidArgsForPlatform('win32')).toEqual([]);
    expect(trayGuidArgsForPlatform('linux')).toEqual([]);
  });
});
