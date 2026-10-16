import { execFileSync, spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const swiftAvailable = spawnSync('swift', ['--version'], { timeout: 5_000, windowsHide: true }).status === 0;
// Production direct capture rejects pre-14 macOS before reaching the cursor decision.
const directCaptureAvailable = process.platform !== 'darwin' ||
  Number(execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]) >= 14;

it.skipIf(!swiftAvailable || !directCaptureAvailable)('executes native window capture with off-Space cursor failure and invalid targets', () => {
  const output = execFileSync(process.execPath, ['test/fixtures/verify-macos-window-capture.mjs'], {
    encoding: 'utf8', timeout: 25_000, windowsHide: true
  });
  expect(output.trim().split(/\r?\n/)).toHaveLength(5);
  expect(output).toContain('PASS: off-Space window captures without foreign cursor');
  expect(output).toContain('PASS: STALE_FRAME refuses before capture');
}, 30_000);
