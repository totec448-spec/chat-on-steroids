import { describe, expect, it } from 'vitest';
import { windowLayoutForDisplays, windowLayoutForWorkArea, windowPlacementWasMaximized } from '../src/main/window-layout.js';

describe('main window accessibility', () => {
  it('caps its initial outer bounds to a small Windows work area', () => {
    const layout = windowLayoutForWorkArea({ x: 120, y: 40, width: 900, height: 520 });

    expect(layout).toMatchObject({
      x: 120,
      y: 40,
      width: 900,
      height: 520,
      useContentSize: false
    });
  });

  it('keeps sensible minimums without making them larger than the display', () => {
    expect(windowLayoutForWorkArea({ x: 0, y: 0, width: 1600, height: 900 })).toMatchObject({
      width: 1600,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      resizable: true,
      maximizable: true
    });

    expect(windowLayoutForWorkArea({ x: -500, y: 0, width: 500, height: 360 })).toMatchObject({
      x: -500,
      y: 0,
      width: 500,
      height: 360,
      minWidth: 500,
      minHeight: 360
    });
  });

  it('fills a larger work area from the initial hidden construction bounds', () => {
    expect(windowLayoutForWorkArea({ x: 100, y: 50, width: 1600, height: 900 })).toMatchObject({
      x: 100,
      y: 50,
      width: 1600,
      height: 900
    });
  });

  it('restores an exact saved window on the monitor that still contains it', () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    const secondary = { x: 1920, y: -120, width: 1600, height: 900 };
    const saved = { x: 2110, y: 30, width: 1180, height: 720 };

    expect(windowLayoutForDisplays(primary, [primary, secondary], saved)).toEqual({
      restored: true,
      layout: {
        ...saved,
        minWidth: 640,
        minHeight: 480,
        useContentSize: false,
        resizable: true,
        maximizable: true
      }
    });
  });

  it('restores wrapped normal bounds and remembers whether that window was maximized', () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    const bounds = { x: 180, y: 90, width: 1100, height: 720 };
    const saved = { bounds, maximized: true };

    expect(windowLayoutForDisplays(primary, [primary], saved)).toEqual({
      restored: true,
      layout: {
        ...bounds,
        minWidth: 640,
        minHeight: 480,
        useContentSize: false,
        resizable: true,
        maximizable: true
      }
    });
    expect(windowPlacementWasMaximized(saved)).toBe(true);
    // Existing installs wrote the bare rectangle; it remains a normal-window restore.
    expect(windowPlacementWasMaximized(bounds)).toBe(false);

    const malformed = { bounds, maximized: 'yes' };
    expect(windowPlacementWasMaximized(malformed)).toBe(false);
    expect(windowLayoutForDisplays(primary, [primary], malformed)).toEqual({
      restored: false,
      layout: windowLayoutForWorkArea(primary)
    });
  });

  it('falls back to the primary work area when saved bounds are wholly offscreen', () => {
    const primary = { x: 0, y: 0, width: 1440, height: 860 };

    expect(windowLayoutForDisplays(primary, [primary], {
      x: 2500,
      y: 200,
      width: 900,
      height: 640
    })).toEqual({
      restored: false,
      layout: windowLayoutForWorkArea(primary)
    });
  });

  it('falls back to the primary work area for malformed saved bounds', () => {
    const primary = { x: 0, y: 0, width: 1440, height: 860 };

    expect(windowLayoutForDisplays(primary, [primary], {
      x: 100,
      y: 100,
      width: Number.NaN,
      height: 700
    })).toEqual({
      restored: false,
      layout: windowLayoutForWorkArea(primary)
    });
  });

  it('clamps saved bounds to a monitor whose work area became smaller', () => {
    const primary = { x: 0, y: 0, width: 1440, height: 900 };
    const secondary = { x: -1280, y: 0, width: 1280, height: 720 };

    expect(windowLayoutForDisplays(primary, [primary, secondary], {
      x: -1500,
      y: -80,
      width: 1500,
      height: 900
    })).toEqual({
      restored: true,
      layout: {
        x: -1280,
        y: 0,
        width: 1280,
        height: 720,
        minWidth: 640,
        minHeight: 480,
        useContentSize: false,
        resizable: true,
        maximizable: true
      }
    });
  });
});
