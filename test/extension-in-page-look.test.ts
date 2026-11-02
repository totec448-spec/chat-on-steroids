import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../extension/app-palette.js', import.meta.url), 'utf8').catch(() => '');
const overlay = await readFile(new URL('../extension/overlay.css', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
let page: JSDOM | undefined;
afterEach(() => { page?.window.close(); });

const appearance = {
  theme: 'dark',
  light: { '--card': '#ffffff', '--ink': '#0c0c0e', '--accent': '#486f9d' },
  dark: { '--card': '#262725', '--ink': '#eceeeb', '--accent': '#d9773a' }
};

async function open(stored: unknown) {
  page = new JSDOM('<!doctype html><html data-clf-theme="dark"><head></head><body></body></html>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  const listeners: Array<(changes: Record<string, any>, area: string) => void> = [];
  Object.assign(page.window, {
    chrome: { storage: {
      local: { get: async () => (stored === undefined ? {} : { appAppearance: stored }) },
      onChanged: { addListener: (listener: (changes: Record<string, any>, area: string) => void) => listeners.push(listener) }
    } }
  });
  page.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 0));
  const change = (value: unknown, area = 'local') => listeners.forEach(listener => listener({ appAppearance: { newValue: value } }, area));
  const css = () => page!.window.document.getElementById('clf-app-palette')?.textContent ?? null;
  return { change, css };
}

it('loads the palette script with the content scripts, before content.js', () => {
  const entry = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes('content.js'));
  expect(entry.js.indexOf('app-palette.js')).toBeGreaterThanOrEqual(0);
  expect(entry.js.indexOf('app-palette.js')).toBeLessThan(entry.js.indexOf('content.js'));
});

it('gives the CoS parts of the page the app palette for the theme ChatGPT shows', async () => {
  const { css } = await open(appearance);
  expect(css()).toContain(":root:root[data-clf-theme='dark'] { --clf-app-card: #262725; --clf-app-ink: #eceeeb; --clf-app-accent: #d9773a; }");
  expect(css()).toContain(":root:root[data-clf-theme='light'] { --clf-app-card: #ffffff;");
});

it('follows a palette change and drops the colors again when the stored value is gone', async () => {
  const { change, css } = await open(undefined);
  expect(css()).toBeNull();
  change(appearance);
  expect(css()).toContain('--clf-app-accent: #d9773a;');
  change({ ...appearance, dark: { '--accent': '#3a8fd9' } });
  expect(css()).toContain('--clf-app-accent: #3a8fd9;');
  expect(css()).not.toContain('#d9773a');
  change(appearance, 'sync');
  expect(css()).not.toContain('#d9773a');
  change(undefined);
  expect(css()).toBeNull();
});

it('writes only well-formed color tokens into the page', async () => {
  const { css } = await open({ theme: 'dark', light: {}, dark: {
    '--card': '#262725', '--ink': 'url(https://example.test/x)', '--line': '#181818; background: red',
    '--x}body{': '#ffffff', '--accent': '#d9773a'
  } });
  expect(css()).toContain('--clf-app-card: #262725;');
  expect(css()).toContain('--clf-app-accent: #d9773a;');
  expect(css()).not.toMatch(/url\(|background|body/);
});

it('ignores a damaged stored value', async () => {
  const { css } = await open({ theme: 'dark', light: null, dark: 'x' });
  expect(css()).toBeNull();
});

it('has a default for every app color the overlay uses, in both themes', () => {
  const used = new Set([...overlay.matchAll(/var\((--clf-app-[a-z-]+)/g)].map(match => match[1]));
  expect(used.size).toBeGreaterThan(5);
  const block = (selector: string) => overlay.slice(overlay.indexOf(selector + ' {')).split('}')[0] ?? '';
  for (const name of used) {
    expect(block(':root'), name).toContain(`${name}:`);
    expect(block(":root[data-clf-theme='light']"), name).toContain(`${name}:`);
  }
});
