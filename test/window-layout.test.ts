import { describe, expect, it } from 'vitest';
import { windowLayoutForWorkArea } from '../src/main/window-layout.js';

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
});
