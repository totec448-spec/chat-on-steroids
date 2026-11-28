import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';

const { plainArgument } = createRequire(import.meta.url)('../scripts/ui-check-args.cjs') as {
  plainArgument: (argv: string[], scriptFile: string) => string | undefined;
};
const script = path.resolve('scripts/verify-input-queue.cjs');

// verify-ui starts a check as `electron --no-sandbox --ozone-platform=x11 scripts/<check>.cjs --lang=en-US` on Linux X11,
// and Electron then keeps the script in process.argv ahead of the switches. verify-input-queue took that script path for
// its output folder and failed with EEXIST before it ran (found on the Linux test VM).
it('does not take the check\'s own script for an output folder on Linux X11', () => {
  const argv = ['/usr/bin/electron', '--no-sandbox', '--ozone-platform=x11', 'scripts/verify-input-queue.cjs', '--lang=en-US'];
  expect(plainArgument(argv, script)).toBeUndefined();
});

it('still returns an explicit output folder, wherever it stands among the switches', () => {
  expect(plainArgument(['electron', 'scripts/verify-input-queue.cjs', '.tmp/out', '--lang=en-US'], script)).toBe('.tmp/out');
  expect(plainArgument(['electron', '--no-sandbox', 'scripts/verify-input-queue.cjs', '--lang=en-US', 'shots/new-dir'], script)).toBe('shots/new-dir');
});

it('recognises the script by its path, so a folder that merely looks like it is kept', () => {
  expect(plainArgument(['electron', script, 'scripts/verify-input-queue'], script)).toBe('scripts/verify-input-queue');
  expect(plainArgument(['electron', path.relative(process.cwd(), script)], script)).toBeUndefined();
});
