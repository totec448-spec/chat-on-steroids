import { JSDOM } from 'jsdom';
import { afterEach, expect, it } from 'vitest';

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

it('tells its listeners only when the appearance really changed, not on every state push', async () => {
  dom = new JSDOM('<div class="app"></div>', { url: 'https://local.test' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { applyAppearance, onAppearanceChanged } = await import('../src/renderer/appearance.js');
  const { defaultAppearance } = await import('../src/shared/appearance.js');
  let told = 0;
  const stop = onAppearanceChanged(() => { told++; });
  try {
    applyAppearance('dark', defaultAppearance());
    expect(told).toBe(1);
    // The same appearance again, as each state push applies it.
    applyAppearance('dark', defaultAppearance());
    applyAppearance('dark', { ...defaultAppearance() });
    expect(told).toBe(1);
    applyAppearance('light', defaultAppearance());
    expect(told).toBe(2);
    applyAppearance('light', { ...defaultAppearance(), fontSize: 16 });
    expect(told).toBe(3);
    // A newly added listener (a terminal opened later) is told about the next real change.
    let late = 0;
    const stopLate = onAppearanceChanged(() => { late++; });
    applyAppearance('light', { ...defaultAppearance(), fontSize: 16 });
    expect(late).toBe(0);
    applyAppearance('dark', defaultAppearance());
    expect(late).toBe(1);
    stopLate();
  } finally { stop(); }
});
