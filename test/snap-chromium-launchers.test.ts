import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { snapChromiumPaths, isSnapChromiumLauncher } = require('../scripts/fixtures/snap-chromium-launchers.cjs') as {
  snapChromiumPaths: string[];
  isSnapChromiumLauncher: (executable: string, exists?: (path: string) => boolean) => boolean;
};

it.runIf(process.platform === 'linux')('discovers both snapd Chromium launcher directories', () => {
  expect(snapChromiumPaths).toEqual(['/snap/bin/chromium', '/var/lib/snapd/snap/bin/chromium']);
  for (const candidate of snapChromiumPaths) {
    expect(isSnapChromiumLauncher(candidate, () => false)).toBe(true);
  }
});

it.runIf(process.platform === 'linux')('recognizes the Ubuntu Chromium wrapper when either snap launcher exists', () => {
  expect(isSnapChromiumLauncher('/usr/bin/chromium-browser', candidate => candidate === '/snap/bin/chromium')).toBe(true);
  expect(isSnapChromiumLauncher('/usr/bin/chromium-browser', candidate => candidate === '/var/lib/snapd/snap/bin/chromium')).toBe(true);
  expect(isSnapChromiumLauncher('/usr/bin/chromium-browser', () => false)).toBe(false);
  expect(isSnapChromiumLauncher('/usr/bin/google-chrome', () => true)).toBe(false);
});

it.runIf(process.platform === 'linux')('recognizes direct and chained aliases of the Snap Chromium launcher only', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'cos-snap-launcher-test-'));
  try {
    const alias = path.join(temporary, 'alias-chromium');
    const chained = path.join(temporary, 'chained-chromium');
    const unrelated = path.join(temporary, 'unrelated-snap');
    symlinkSync('/snap/bin/chromium', alias);
    symlinkSync('alias-chromium', chained);
    symlinkSync('/snap/bin/firefox', unrelated);
    expect(isSnapChromiumLauncher(alias, () => false)).toBe(true);
    expect(isSnapChromiumLauncher(chained, () => false)).toBe(true);
    expect(isSnapChromiumLauncher(unrelated, () => true)).toBe(false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux')('canonicalizes symlinked parent directories without resolving the Snap launcher itself', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'cos-snap-parent-test-'));
  try {
    const alias = path.join(temporary, 'bin');
    symlinkSync('/usr/bin', alias, 'dir');
    const browser = path.join(alias, 'chromium-browser');
    expect(isSnapChromiumLauncher(browser, candidate => candidate === '/snap/bin/chromium')).toBe(true);
    expect(isSnapChromiumLauncher(browser, () => false)).toBe(false);
    // On merged-usr Ubuntu, /bin itself aliases /usr/bin in exactly the same way.
    if (realpathSync('/bin') === '/usr/bin') {
      expect(isSnapChromiumLauncher('/bin/chromium-browser', candidate => candidate === '/snap/bin/chromium')).toBe(true);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
