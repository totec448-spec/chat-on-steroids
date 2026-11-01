import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAppearance, paletteTokens } from '../src/shared/appearance.js';

// 2026-11-01: the extension's popup looks like the app — its palette, switches and theme. The app sends
// both themes' colors with every status; the worker stores them; the popup paints with them.

let ui: Record<string, unknown> = {};
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui }) }));

describe('the colors the app sends', () => {
  it('sends both themes from the default palette and the app\'s theme, dark when none is saved', async () => {
    ui = {};
    const { extensionAppearance } = await import('../src/main/extension-appearance.js');
    const sent = extensionAppearance();
    const palette = defaultAppearance();
    expect(sent.theme).toBe('dark');
    expect(sent.dark['--page']).toBe(palette.dark.background);
    expect(sent.light['--page']).toBe(palette.light.background);
    expect(sent.dark['--card']).toBe(paletteTokens(palette.dark.background, palette.dark.accent, palette.dark.contrast)['--card']);
    for (const tokens of [sent.light, sent.dark]) {
      expect(Object.keys(tokens)).toHaveLength(19);
      for (const value of Object.values(tokens)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('follows a custom accent, the system theme and high contrast', async () => {
    const { extensionAppearance } = await import('../src/main/extension-appearance.js');
    const appearance = { ...defaultAppearance(), dark: { ...defaultAppearance().dark, accent: '#e0a040' } };
    ui = { theme: 'system', appearance };
    const custom = extensionAppearance();
    expect(custom.theme).toBe('system');
    expect(custom.dark['--accent-fill']).toBe('#e0a040');
    ui = { theme: 'system', appearance: { ...appearance, highContrast: true } };
    const high = extensionAppearance();
    expect(high.dark['--line']).not.toBe(custom.dark['--line']);
  });
});

const background = readFileSync(path.join(process.cwd(), 'extension/background.js'), 'utf8');
const followCode = background.slice(background.indexOf('const APP_LANGUAGE_KEY'), background.indexOf('let extensionReloadPending = false;'));

function appearanceFollower() {
  const writes: Array<Record<string, unknown>> = [];
  const context = vm.createContext({
    RENDER_STREAM_KEY: 'renderStreamEnabled', SHOW_TIMES_KEY: 'showStreamTimes', setTimeout, clearTimeout,
    chrome: { storage: { local: { get: async () => ({}), set: async (value: Record<string, unknown>) => { writes.push(value); } } } }
  });
  vm.runInContext(`${followCode}\nglobalThis.followAppearance = followAppearance;`, context);
  const follow = async (value: unknown) => { (context.followAppearance as (value: unknown) => void)(value); await new Promise(resolve => setTimeout(resolve, 0)); };
  return Object.assign(follow, { writes });
}

const valid = { theme: 'dark', light: { '--page': '#f4f4f5', '--ink': '#000000' }, dark: { '--page': '#181818', '--ink': '#ffffff' } };

describe('the worker stores them', () => {
  it('writes the app\'s colors once, and again when they change', async () => {
    const follow = appearanceFollower();
    await follow(valid);
    await follow(valid);
    expect(follow.writes).toEqual([{ appAppearance: valid }]);
    const light = { ...valid, theme: 'light' };
    await follow(light);
    expect(follow.writes).toEqual([{ appAppearance: valid }, { appAppearance: light }]);
  });

  it('stores nothing that is not a theme and colors', async () => {
    const follow = appearanceFollower();
    for (const value of [null, 'dark', { ...valid, theme: 'blue' }, { ...valid, dark: { '--page': 'red' } }, { ...valid, light: { page: '#ffffff' } },
      // More than 40 colors, each name valid: refused as a whole.
      { ...valid, dark: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`--${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`, '#000000'])) },
      { ...valid, dark: { '--page': '#181818; background: url(x)' } }]) await follow(value);
    expect(follow.writes).toEqual([]);
  });
});

const popupHtml = readFileSync(path.join(process.cwd(), 'extension/popup.html'), 'utf8');
const i18nScript = readFileSync(path.join(process.cwd(), 'extension/i18n.js'), 'utf8');
const popupScript = readFileSync(path.join(process.cwd(), 'extension/popup.js'), 'utf8');
let popup: JSDOM | null = null;
afterEach(() => { popup?.window.close(); popup = null; });

async function openPopup(stored: unknown, systemDark = false) {
  popup = new JSDOM(popupHtml, { url: 'https://extension-popup.test/', runScripts: 'outside-only' });
  const listeners: Array<(changes: Record<string, { newValue: unknown }>, area: string) => void> = [];
  const schemeListeners: Array<() => void> = [];
  const scheme = { matches: systemDark, addEventListener: (_: string, listener: () => void) => schemeListeners.push(listener) };
  Object.assign(popup.window, {
    chrome: {
      i18n: { getMessage: () => '', getUILanguage: () => 'en' },
      runtime: { sendMessage: () => new Promise(() => undefined) },
      storage: {
        local: { get: async (key: unknown) => key === 'appAppearance' ? { appAppearance: stored } : {} },
        onChanged: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
      }
    },
    matchMedia: () => scheme,
    setInterval: () => 0
  });
  popup.window.eval(i18nScript);
  popup.window.eval(popupScript);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const root = popup.window.document.documentElement;
  const change = (value: unknown) => { for (const listener of listeners) listener({ appAppearance: { newValue: value } }, 'local'); };
  const flipSystem = (dark: boolean) => { scheme.matches = dark; for (const listener of schemeListeners) listener(); };
  return { root, change, flipSystem };
}

describe('the popup paints with them', () => {
  it('takes the app\'s theme and colors, and keeps the stylesheet\'s defaults without them', async () => {
    const dark = await openPopup(valid);
    expect(dark.root.dataset.theme).toBe('dark');
    expect(dark.root.style.getPropertyValue('--page')).toBe('#181818');
    dark.change({ ...valid, theme: 'light' });
    expect(dark.root.dataset.theme).toBe('light');
    expect(dark.root.style.getPropertyValue('--page')).toBe('#f4f4f5');
    // Never paired yet: no theme attribute and no inline colors, so the stylesheet follows the computer.
    const none = await openPopup(undefined);
    expect(none.root.dataset.theme).toBeUndefined();
    expect(none.root.style.getPropertyValue('--page')).toBe('');
  });

  it('follows the computer when the app is set to system', async () => {
    const page = await openPopup({ ...valid, theme: 'system' }, false);
    expect(page.root.dataset.theme).toBe('light');
    page.flipSystem(true);
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.root.style.getPropertyValue('--page')).toBe('#181818');
  });

  it('ignores a damaged stored value and anything that is not a color', async () => {
    const page = await openPopup({ theme: 'dark', light: {}, dark: { '--page': 'url(x)', '--ink': '#ffffff', page: '#000000' } });
    expect(page.root.style.getPropertyValue('--page')).toBe('');
    expect(page.root.style.getPropertyValue('--ink')).toBe('#ffffff');
    page.change('nonsense');
    expect(page.root.dataset.theme).toBeUndefined();
    expect(page.root.style.getPropertyValue('--ink')).toBe('');
  });
});
