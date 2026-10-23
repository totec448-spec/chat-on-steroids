import { currentLanguage, onLanguageChange } from './i18n.js';

/**
 * The pictures on the Sidebar layout cards (Settings → Appearance): the real sidebar in each layout
 * and theme, captured once per app language with that language's labels and made-up chat names
 * (`scripts/capture-layout-previews.cjs`). A language without its own set shows the English one.
 */
const files = import.meta.glob('./layout-previews/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export function layoutPreviewSrc(picture: string, language: string = currentLanguage()): string | null {
  return files[`./layout-previews/${picture}-${language}.webp`] ?? files[`./layout-previews/${picture}-en.webp`] ?? null;
}

function paint(): void {
  for (const image of document.querySelectorAll<HTMLImageElement>('img[data-layout-preview]')) {
    const src = layoutPreviewSrc(image.dataset.layoutPreview!);
    if (src && image.getAttribute('src') !== src) image.src = src;
  }
}

export function initLayoutPreviews(): void {
  paint();
  onLanguageChange(paint);
}
