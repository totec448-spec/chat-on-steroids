import { createRequire } from 'node:module';
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
