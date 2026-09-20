import { execFileSync, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const swiftAvailable = spawnSync('swift', ['--version'], { timeout: 5_000, windowsHide: true }).status === 0;

it.skipIf(!swiftAvailable)('executes native window matching against contradictory and missing AX identities', () => {
  const output = execFileSync(process.execPath, ['scripts/verify-macos-window-matching.mjs'], {
    encoding: 'utf8', timeout: 25_000, windowsHide: true
  });
  expect(output.trim().split(/\r?\n/)).toHaveLength(6);
  expect(output).toContain('PASS: contradictory ID cannot borrow matching geometry');
}, 30_000);
