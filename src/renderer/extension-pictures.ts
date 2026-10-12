import { currentLanguage, type Language } from './i18n.js';
import manifest from './setup-images/extensions/manifest.json';

/**
 * The extensions page of each supported browser, as it really looks in each language: captured from
 * the browser itself (Chrome, Edge, Brave; `scripts/capture-extension-pages.mjs`), with the place to
 * click measured from the page and the browser's own words for it. Edge, for one, puts Developer
 * mode at the bottom of its sidebar and names the button differently from Chrome in German.
 */
export type ExtensionBrowser = 'chrome' | 'edge' | 'brave';
export type ExtensionPictureKind = 'dev' | 'load';
type Capture = { file: string; label: string; box: [number, number, number, number]; size: [number, number] };
type Manifest = Record<ExtensionBrowser, Partial<Record<Language, Record<ExtensionPictureKind, Capture>>>>;

const files = import.meta.glob('./setup-images/extensions/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface ExtensionPicture { src: string; label: string; box: [number, number, number, number]; width: number; height: number }

/** The capture for this browser in the app's language, else in English. */
export function extensionPicture(browser: ExtensionBrowser, kind: ExtensionPictureKind, language: Language = currentLanguage()): ExtensionPicture | null {
  const pages = (manifest as unknown as Manifest)[browser];
  const capture = pages?.[language]?.[kind] ?? pages?.en?.[kind];
  const src = capture ? files[`./setup-images/extensions/${capture.file}`] : undefined;
  if (!capture || !src) return null;
  return { src, label: capture.label, box: capture.box, width: capture.size[0], height: capture.size[1] };
}

/** A label from the browser's page, quoted the way the language quotes. */
export function quoted(label: string, language: Language = currentLanguage()): string {
  switch (language) {
    case 'de': return `„${label}“`;
    case 'fr': return `« ${label} »`;
    case 'ja': case 'zh-TW': return `「${label}」`;
    case 'es': case 'ru': case 'pt-PT': return `«${label}»`;
    case 'ko': return `'${label}'`;
    default: return `“${label}”`;
  }
}

/** The picture with its place to click outlined. Alt text says what the outline marks. */
export function renderExtensionPicture(host: HTMLElement, picture: ExtensionPicture | null, alt: string): void {
  host.replaceChildren();
  host.hidden = !picture;
  if (!picture) return;
  const frame = document.createElement('span');
  frame.className = 'ext-picture';
  const img = document.createElement('img');
  img.src = picture.src;
  img.alt = alt;
  img.width = picture.width;
  img.height = picture.height;
  img.decoding = 'async';
  img.draggable = false;
  const spot = document.createElement('span');
  spot.className = 'ext-spot';
  spot.setAttribute('aria-hidden', 'true');
  const [x, y, width, height] = picture.box;
  Object.assign(spot.style, { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` });
  frame.append(img, spot);
  host.append(frame);
}
