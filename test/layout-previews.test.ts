import { expect, it } from 'vitest';
import { UI_LANGUAGES } from '../src/shared/ui-language.js';
import { layoutPreviewSrc } from '../src/renderer/layout-previews.js';

const pictures = ['projects-light', 'projects-dark', 'inbox-light', 'inbox-dark'];

it('has every Sidebar layout picture in every app language', () => {
  for (const language of UI_LANGUAGES) for (const picture of pictures) {
    expect(layoutPreviewSrc(picture, language), `${picture} ${language}`).toContain(`${picture}-${language}.webp`);
  }
});

it('shows the English picture for a language without its own', () => {
  expect(layoutPreviewSrc('inbox-dark', 'xx')).toContain('inbox-dark-en.webp');
  expect(layoutPreviewSrc('nothing-here', 'de')).toBeNull();
});

it('is drawn by the Appearance cards in index.html', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  for (const picture of pictures) expect(html).toContain(`data-layout-preview="${picture}"`);
});
