import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
// @ts-expect-error The build check is a plain Node script without type declarations.
import { buildProblem, needsBuild } from '../scripts/ui-build-state.mjs';

/**
 * UI checks that load the built app (out/) used to wait out their six-minute timeout without a
 * build, and to pass against old code with a stale one. The runner now names the problem at once.
 */
let root: string;
beforeEach(async () => { root = await makeTempDir('cos-ui-build-'); });
afterEach(async () => { await removeTempDir(root); });

const file = (relative: string, at: number) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, 'x');
  utimesSync(target, at, at);
};

it('says the build is missing', () => {
  file('src/renderer/main.ts', 1000);
  expect(buildProblem(root)).toBe('there is no build (out/renderer/index.html); run npm run build first');
});

it('counts empty folders left by an interrupted build as no build', () => {
  file('out/renderer/index.html', 2000); file('out/main/chunks/a.js', 2000); file('out/preload/other.js', 2000);
  file('src/renderer/main.ts', 1000);
  expect(buildProblem(root)).toBe('there is no build (out/main/index.js); run npm run build first');
  file('out/main/index.js', 2000);
  expect(buildProblem(root)).toBe('there is no build (out/preload/index.js); run npm run build first');
});

it('says which source file is newer than the build', () => {
  file('out/renderer/index.html', 2000); file('out/preload/index.js', 2000); file('out/main/index.js', 2000);
  file('src/renderer/main.ts', 1000);
  expect(buildProblem(root)).toBeNull();
  file('src/main/ipc.ts', 3000);
  expect(buildProblem(root)).toBe('the build is older than src/main/ipc.ts; run npm run build first');
});

it('knows which checks load the build', () => {
  expect(needsBuild("const page = path.join(root, 'out/renderer/index.html');")).toBe(true);
  expect(needsBuild("preload: path.join(root, 'out', 'preload', 'index.js')")).toBe(true);
  expect(needsBuild("const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');")).toBe(false);
});
