/**
 * Makes sure Electron's binary is there before any test asks for it.
 *
 * Two test files start Electron, and vitest runs files in parallel. When `dist` is missing or half
 * unpacked — the ordinary state right after `npm ci`, and the guaranteed state when npm declines to
 * run install scripts, as npm 11 now does by default — both files trigger Electron's own installer
 * at the same moment. They then race over the same directory and one of them loses:
 *
 *   failed to create directory '…/electron/dist/Electron.app/Contents/MacOS': File exists
 *   Electron failed to install correctly. Please delete `node_modules/electron` …
 *
 * That has cost a red first run on three fresh checkouts in a row, once needing two corrective
 * runs, and it says nothing about the code. Doing the install once, here, before vitest starts,
 * removes the race by removing the concurrency: there is nothing left to race over.
 *
 * Cheap when it is already there — one `existsSync` and a path read — so it stays in the chain
 * rather than being something to remember on a new machine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDir = path.join(root, 'node_modules', 'electron');

if (!existsSync(electronDir)) {
  // Not a dependency of this checkout, or dependencies are not installed at all. Either way this
  // is not the place to say so: whatever runs next will, with its own context.
  process.exit(0);
}

const pathTxt = path.join(electronDir, 'path.txt');
const binary = existsSync(pathTxt)
  ? path.join(electronDir, 'dist', readFileSync(pathTxt, 'utf8').trim())
  : null;

if (binary && existsSync(binary)) {
  process.exit(0);
}

console.log('Electron binary is missing; installing it once before the tests start.');
try {
  // Its own installer, run in-process and to completion. `npm ci` may have skipped it: npm 11
  // holds install scripts back until they are approved, and Electron's download is one.
  createRequire(import.meta.url)(path.join(electronDir, 'install.js'));
} catch (error) {
  console.error(`Could not install Electron: ${error?.message ?? error}`);
  console.error('Tests that launch it will fail. Run `node node_modules/electron/install.js` by hand.');
  process.exit(1);
}
