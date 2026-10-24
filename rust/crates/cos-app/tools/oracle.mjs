// Records what the TypeScript app computes for appearance tokens, window placement and the tray
// image, by running its own modules, so the Rust ports are tested against the real thing.
// usage (from the repository root): node rust/crates/cos-app/tools/oracle.mjs
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The TypeScript sources import siblings as `.js`; resolve those to the `.ts` file beside them.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) { if (specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context); throw error; }
}`));

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const load = file => import(new URL(`file:///${path.join(repo, file).replaceAll('\\', '/')}`).href);
const appearance = await load('src/shared/appearance.ts');
const layout = await load('src/main/window-layout.ts');
const tray = await load('src/main/tray-image.ts');

const palettes = [
  ['#181818', '#b0cbed', 60],
  ['#f4f4f5', '#486f9d', 45],
  ['#1a2129', '#b0cbed', 60],
  ['#e9edf2', '#486f9d', 45],
  ['#ffffff', '#ff0000', 0],
  ['#000000', '#00ff00', 100],
  ['#336699', '#ffcc00', 30],
  ['#7f7f7f', '#7f7f7f', 50],
  ['#767676', '#123456', 75],
];
const tokens = palettes.map(([background, accent, contrast]) => ({
  background, accent, contrast, tokens: appearance.paletteTokens(background, accent, contrast),
}));
const mixes = [['#1a2129', '#181818', 0.13], ['#e9edf2', '#f4f4f5', 0.13], ['#000000', '#ffffff', 0.5], ['#102030', '#f0e0d0', 0.333]]
  .map(([a, b, amount]) => ({ a, b, amount, mixed: appearance.mixColor(a, b, amount) }));

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: -200, width: 2560, height: 1400 };
const saved = [
  null,
  'garbage',
  { x: 100, y: 120, width: 1000, height: 700 },
  { bounds: { x: 100, y: 120, width: 1000, height: 700 }, maximized: true },
  { bounds: { x: 100, y: 120, width: 1000, height: 700 }, maximized: 'yes' },
  { bounds: { x: 1800, y: 900, width: 1000, height: 700 }, maximized: false },
  { bounds: { x: 5000, y: 5000, width: 800, height: 600 }, maximized: false },
  { bounds: { x: 2000, y: -100, width: 3000, height: 300 }, maximized: false },
  { bounds: { x: 10.4, y: 20.6, width: 300.5, height: 200.2 }, maximized: false },
  { bounds: { x: 0, y: 0, width: -5, height: 200 }, maximized: false },
];
const placements = saved.map(value => ({
  saved: value,
  ...layout.windowLayoutForDisplays(primary, [primary, second], value),
  maximized: layout.windowPlacementWasMaximized(value),
}));

const trayImages = [false, true].flatMap(running => [1, 2].map(scale => {
  const { size, rgba } = tray.trayRgba('win32', running, scale);
  return { running, scale, size, rgba: rgba.toString('base64') };
}));

const custom = { light: { background: '#ffffff', sidebar: '#202020', accent: '#ff0000', contrast: 0 },
  dark: { background: '#336699', sidebar: '#f0f0f0', accent: '#ffcc00', contrast: 100 }, font: 'mono', fontSize: 16, translucentSidebar: false };
const windows = ['dark', 'light'].flatMap(theme => [appearance.defaultAppearance(), custom].map(saved => ({
  theme, appearance: saved,
  captionSymbol: layout.titleBarOverlayForTheme(theme, saved).symbolColor,
  background: layout.windowBackgroundForTheme(theme, saved),
})));

const out = path.join(here, '../tests/oracle.json');
fs.writeFileSync(out, JSON.stringify({ tokens, mixes, windows, displays: { primary, all: [primary, second] }, placements, trayImages }, null, 1) + '\n');
console.log(`wrote ${path.relative(repo, out)}`);
