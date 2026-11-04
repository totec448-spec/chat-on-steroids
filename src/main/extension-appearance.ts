import { defaultAppearance, effectivePalette, paletteTokens } from '../shared/appearance.js';
import { getConfig } from './config.js';

/**
 * The colors the extension's popup paints with, taken from the app's own palette so the two look
 * like one product (2026-11-01). Sent with every status reply, next to the language: both themes'
 * tokens, and which one the app shows ("system" follows the computer, as in the app).
 */
export const POPUP_TOKENS = [
  '--page', '--card', '--ink', '--soft', '--faint', '--line', '--edge', '--hover', '--track',
  '--accent', '--accent-wash', '--accent-fill', '--on-accent', '--knob-off', '--knob-on',
  '--green', '--green-wash', '--red', '--red-wash'
] as const;

export type ExtensionTheme = 'light' | 'dark' | 'system';
export type ExtensionAppearance = { theme: ExtensionTheme; light: Record<string, string>; dark: Record<string, string> };

let cached: { key: string; value: ExtensionAppearance } | null = null;

export function extensionAppearance(): ExtensionAppearance {
  const ui = getConfig().ui;
  const appearance = ui.appearance ?? defaultAppearance();
  const theme: ExtensionTheme = ui.theme ?? 'dark';
  const high = appearance.highContrast === true;
  const key = JSON.stringify([theme, appearance.light, appearance.dark, high]);
  // Status replies come every second or two; the palette changes only in Settings.
  if (cached?.key === key) return cached.value;
  // The palette the app paints with: under high contrast a black or white page, not the chosen one.
  const pick = (which: 'light' | 'dark'): Record<string, string> => {
    const palette = effectivePalette(appearance, which);
    const tokens = paletteTokens(palette.background, palette.accent, palette.contrast, high);
    return Object.fromEntries(POPUP_TOKENS.flatMap(name => tokens[name] ? [[name, tokens[name]]] : []));
  };
  const value = { theme, light: pick('light'), dark: pick('dark') };
  cached = { key, value };
  return value;
}
