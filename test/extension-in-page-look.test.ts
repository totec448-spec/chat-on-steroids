import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../extension/app-palette.js', import.meta.url), 'utf8').catch(() => '');
const overlay = await readFile(new URL('../extension/overlay.css', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
let page: JSDOM | undefined;
afterEach(() => { page?.window.close(); });

const TOKENS = ['--page', '--card', '--ink', '--soft', '--faint', '--line', '--edge', '--hover', '--track', '--accent',
  '--accent-wash', '--accent-fill', '--on-accent', '--knob-off', '--knob-on', '--green', '--green-wash', '--red', '--red-wash'];
const palette = (overrides: Record<string, string>) => ({ ...Object.fromEntries(TOKENS.map(name => [name, '#808080'])), ...overrides });
const appearance = {
  theme: 'dark',
  light: palette({ '--card': '#ffffff', '--ink': '#0c0c0e', '--accent': '#486f9d' }),
  dark: palette({ '--card': '#262725', '--ink': '#eceeeb', '--accent': '#d9773a' })
};

async function open(stored: unknown, read?: Promise<unknown>) {
  page = new JSDOM('<!doctype html><html data-clf-theme="dark"><head></head><body></body></html>', { url: 'https://chatgpt.com/', runScripts: 'outside-only' });
  const listeners: Array<(changes: Record<string, any>, area: string) => void> = [];
  Object.assign(page.window, {
    chrome: { storage: {
      local: { get: async () => { const value = read ? await read : stored; return value === undefined ? {} : { appAppearance: value }; } },
      onChanged: { addListener: (listener: (changes: Record<string, any>, area: string) => void) => listeners.push(listener) }
    } }
  });
  page.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 0));
  const change = (value: unknown, area = 'local') => listeners.forEach(listener => listener({ appAppearance: { newValue: value } }, area));
  const css = () => page!.window.document.getElementById('clf-app-palette')?.textContent ?? null;
  const again = async () => { page!.window.eval(script); await new Promise(resolve => setTimeout(resolve, 0)); };
  return { change, css, again, listeners };
}

it('loads the palette script with the content scripts, before content.js', () => {
  const entry = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes('content.js'));
  expect(entry.js.indexOf('app-palette.js')).toBeGreaterThanOrEqual(0);
  expect(entry.js.indexOf('app-palette.js')).toBeLessThan(entry.js.indexOf('content.js'));
});

it('gives the CoS parts of the page the app palette for the theme ChatGPT shows', async () => {
  const { css } = await open(appearance);
  expect(css()).toContain('--clf-app-card: #262725; --clf-app-ink: #eceeeb;');
  expect(css()).toMatch(/:root:root\[data-clf-theme='dark'\] \{[^}]*--clf-app-accent: #d9773a;/);
  expect(css()).toMatch(/:root:root\[data-clf-theme='light'\] \{[^}]*--clf-app-card: #ffffff;/);
});

it('follows a palette change and drops the colors again when the stored value is gone', async () => {
  const { change, css } = await open(undefined);
  expect(css()).toBeNull();
  change(appearance);
  expect(css()).toContain('--clf-app-accent: #d9773a;');
  change({ ...appearance, dark: { ...appearance.dark, '--accent': '#3a8fd9' } });
  expect(css()).toContain('--clf-app-accent: #3a8fd9;');
  expect(css()).not.toContain('#d9773a');
  change(appearance, 'sync');
  expect(css()).not.toContain('#d9773a');
  change(undefined);
  expect(css()).toBeNull();
});

it('writes only complete, well-formed palettes into the page', async () => {
  for (const dark of [
    { ...appearance.dark, '--ink': 'url(https://example.test/x)' },
    { ...appearance.dark, '--line': '#181818; background: red' },
    // Incomplete: a missing color would leave the stylesheet's default for the other theme beside it.
    { '--card': '#262725', '--ink': '#eceeeb' }
  ]) {
    const { css } = await open({ ...appearance, dark });
    expect(css()).toBeNull();
  }
  // Names beyond the app's colors are not written, whatever they hold.
  const { css } = await open({ ...appearance, dark: { ...appearance.dark, '--x}body{': '#ffffff' } });
  expect(css()).toContain('--clf-app-accent: #d9773a;');
  expect(css()).not.toMatch(/url\(|background|body/);
});

it('lets a change during the first read win over the older stored value', async () => {
  let release!: (value: unknown) => void;
  const { change, css } = await open(undefined, new Promise(resolve => { release = resolve; }));
  change({ ...appearance, dark: { ...appearance.dark, '--accent': '#3a8fd9' } });
  release(appearance);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(css()).toContain('--clf-app-accent: #3a8fd9;');
});

it('keeps the same list of colors as the popup', async () => {
  const popup = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const list = (source: string, name: string) => JSON.parse((new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(source)?.[1] ?? '[]').replace(/'/g, '"'));
  expect(list(script, 'APP_TOKENS')).toEqual(list(popup, 'APP_TOKENS'));
  expect(list(script, 'APP_TOKENS')).toEqual(TOKENS);
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

// CodeRabbit on #2038: Save and Clear keep the app's colors over the goal buttons' generic button color,
// so their selectors must be more specific than `.clf-menu-goal-buttons button`.
it('gives Save and Clear selectors that outrank the generic goal button rule', async () => {
  const css = await readFile(new URL('../extension/overlay.css', import.meta.url), 'utf8');
  const rule = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? '';
  expect(rule('.clf-menu-goal-buttons button')).toMatch(/color:/);
  expect(rule('.clf-menu-goal-buttons button.clf-menu-goal-save')).toMatch(/color: var\(--clf-app-on-accent\)/);
  expect(rule('.clf-menu-goal-buttons button.clf-menu-goal-clear')).toMatch(/color: var\(--clf-app-red\)/);
});

// CodeRabbit on #2038: the manifest, a recovered tab and a recorder repair can each load the script.
it('registers one storage listener per page however often the script is loaded', async () => {
  const look = await open(appearance);
  await look.again(); await look.again();
  expect(look.listeners).toHaveLength(1);
  expect(page!.window.document.querySelectorAll('#clf-app-palette')).toHaveLength(1);
});
