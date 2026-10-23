import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  it('bundles the legible font as local files, upright and italic, with its licence in the notices', () => {
    const css = readFileSync('src/renderer/styles.css', 'utf8');
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map(match => match[1]!)
      .filter(face => face.includes('"CoS Atkinson Hyperlegible Next"'));
    expect(faces.map(face => /font-style: (\w+)/.exec(face)?.[1]).sort()).toEqual(['italic', 'italic', 'normal', 'normal']);
    for (const face of faces) {
      const file = /url\('\.\/([^']+)'\)/.exec(face)?.[1];
      expect(file, face).toMatch(/^fonts\/[\w-]+\.woff2$/);
      expect(readFileSync(path.join('src/renderer', file!)).subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(face).toContain('font-weight: 200 800');
    }
    expect(readFileSync('docs/licenses/atkinson-hyperlegible-next/LICENSE', 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(readFileSync('scripts/generate-third-party-notices.mjs', 'utf8')).toContain('docs/licenses/atkinson-hyperlegible-next/LICENSE');
  });

  it('spaces chat text by the Appearance line spacing', () => {
    const css = readFileSync('src/renderer/styles.css', 'utf8') + readFileSync('src/renderer/settings.css', 'utf8');
    const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule('.msg')).toContain('line-height: calc(1.75 * var(--line-spacing, 1))');
    expect(rule('.msg.rich')).toContain('line-height: calc(1.5 * var(--line-spacing, 1))');
    expect(css).toMatch(/\.pending-message-text \{[^}]*line-height: calc\(1\.75 \* var\(--line-spacing, 1\)\)/);
    expect(rule('.appearance-preview-chat')).toContain('line-height: calc(1.5 * var(--line-spacing, 1))');
  });
});
