import { isMainText, type MainText } from '../shared/main-texts.js';

/** The renderer's translations of MAIN_TEXTS for the selected interface language. */
let translations = new Map<MainText, string>();
const listeners = new Set<() => void>();

/** A tray or notification text in the interface language, or as written until one arrives. */
export function mainText(source: MainText): string {
  return translations.get(source) ?? source;
}

/** Repaints surfaces that hold a text, such as the tray menu, after the language changed. */
export function onMainTextsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Takes the renderer's translations. Only known source texts are kept, each bounded; the whole set
 * replaces the previous language, so switching back to English restores the source texts.
 */
export function setMainTextTranslations(texts: Readonly<Record<string, string>>): void {
  const next = new Map<MainText, string>();
  for (const [source, text] of Object.entries(texts)) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (isMainText(source) && value && value.length <= 200) next.set(source, value);
  }
  translations = next;
  for (const listener of listeners) {
    try { listener(); } catch { /* One surface cannot keep the others in the old language. */ }
  }
}
