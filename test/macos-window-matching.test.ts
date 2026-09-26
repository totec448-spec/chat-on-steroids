import { execFileSync, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const swiftAvailable = spawnSync('swift', ['--version'], { timeout: 5_000, windowsHide: true }).status === 0;

it.skipIf(!swiftAvailable)('executes native window matching against contradictory and missing AX identities', () => {
  const output = execFileSync(process.execPath, ['scripts/verify-macos-window-matching.mjs'], {
    encoding: 'utf8', timeout: 25_000, windowsHide: true
  });
  expect(output.trim().split(/\r?\n/)).toHaveLength(8);
  expect(output).toContain('PASS: contradictory ID cannot borrow matching geometry');
  // The title tie-break is the only thing that separates two windows of one application at one
  // place on macOS 27, where AXWindowNumber is not an offered attribute at all.
  expect(output).toContain('PASS: the agreeing title separates two windows at one place');
  expect(output).toContain('PASS: two windows sharing a title stay ambiguous');
}, 30_000);
