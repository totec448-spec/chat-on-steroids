import { afterAll, describe, expect, it } from 'vitest';
import {
  act,
  findUi,
  listWindows,
  screenshot,
  stopComputerHelper
} from '../src/main/computer/index.js';

const LIVE = process.platform === 'darwin' && process.env['COS_LIVE_MACOS_DESKTOP'] === '1';
const SEMANTIC_PROCESS = process.env['COS_LIVE_MACOS_SEMANTIC_PROCESS'];
const SEMANTIC_WINDOW = process.env['COS_LIVE_MACOS_SEMANTIC_WINDOW'];
const SEMANTIC_QUERY = process.env['COS_LIVE_MACOS_SEMANTIC_QUERY'];

describe.runIf(LIVE)('live macOS Desktop backend', () => {
  afterAll(async () => {
    await stopComputerHelper();
  });

  it('lists native windows and captures a bounded PNG frame', async () => {
    const { windows, screen } = await listWindows();
    expect(screen.width).toBeGreaterThan(0);
    expect(screen.height).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThan(0);

    const shot = await screenshot({ maxWidth: 800 });
    expect(shot.width).toBeLessThanOrEqual(800);
    expect(shot.height).toBeGreaterThan(0);
    expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('returns snapshot-scoped AX controls for a visible window', async (context) => {
    const target = (await listWindows()).windows.find((window) => window.state !== 'minimized');
    if (!target) return context.skip('No visible macOS window is available.');
    const found = await findUi({ window: target.id, maxResults: 8 });
    expect(found.window).toBe(target.id);
    expect(found.snapshotId).toBeGreaterThan(0);
    expect(found.elements.length).toBeGreaterThan(0);
    expect(found.elements[0]?.ref).toMatch(/^g\d+_s\d+_e\d+$/);
  });

  it('sets and clears an explicitly selected semantic text control', async (context) => {
    if (!SEMANTIC_PROCESS || !SEMANTIC_QUERY) {
      return context.skip('Set COS_LIVE_MACOS_SEMANTIC_PROCESS and COS_LIVE_MACOS_SEMANTIC_QUERY to opt in.');
    }
    const target = (await listWindows()).windows.find(
      (window) => window.process === SEMANTIC_PROCESS && (!SEMANTIC_WINDOW || window.title === SEMANTIC_WINDOW)
    );
    if (!target) return context.skip('The selected semantic-probe window is not visible.');
    const field = (await findUi({ window: target.id, query: SEMANTIC_QUERY, maxResults: 3 })).elements[0];
    if (!field) return context.skip('The selected control is not exposed through AX.');

    const marker = 'COS_MAC_DESKTOP_SEMANTIC_PROBE';
    try {
      const set = await act([{ type: 'set_value', ref: field.ref, text: marker }]);
      expect(set.completedCount).toBe(1);
      expect(set.routes).toEqual(['uia']);
      expect((await findUi({ window: target.id, query: marker, maxResults: 1 })).elements).toHaveLength(1);
    } finally {
      await act([{ type: 'set_value', ref: field.ref, text: '' }]);
    }
  });

  it('posts harmless keyboard and pointer events through CGEvent', async (context) => {
    const key = await act([{ type: 'keypress', keys: ['shift'] }]);
    expect(key.completedCount).toBe(1);
    expect(key.routes).toEqual(['sendinput']);
    if (!key.cursor) return context.skip('The current pointer position is unavailable.');

    const frame = await screenshot({ full: true, maxWidth: 800 });
    const x = Math.round((key.cursor.screen.x - frame.region.x) * frame.scale);
    const y = Math.round((key.cursor.screen.y - frame.region.y) * frame.scale);
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      return context.skip('The pointer is outside the retained full-desktop frame.');
    }
    const move = await act([{ type: 'move', x, y }], { frameId: frame.frameId });
    expect(move.completedCount).toBe(1);
    expect(move.routes).toEqual(['sendinput']);
  });
});
