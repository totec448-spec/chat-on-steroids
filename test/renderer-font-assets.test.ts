import { describe, expect, it } from 'vitest';
import { rendererAssetsInlineLimit } from '../electron.vite.config';

// The renderer's policy is font-src 'self': an inlined data: font is blocked (KaTeX, 2026-10-09).
describe('renderer font assets', () => {
  it('never inlines a font file, and leaves other assets to Vite', () => {
    for (const file of ['katex/dist/fonts/KaTeX_Size4-Regular.woff2', 'a.woff', 'b.TTF', 'c.otf', 'd.eot']) {
      expect(rendererAssetsInlineLimit(file)).toBe(false);
    }
    expect(rendererAssetsInlineLimit('icon.svg')).toBeUndefined();
    expect(rendererAssetsInlineLimit('woff2.png')).toBeUndefined();
  });
});
