import os from 'node:os';
import { expect, it } from 'vitest';
import { runGit } from '../src/main/project-git.js';

it('survives Git exiting before it read its input, instead of crashing on a closed pipe', async () => {
  // `git version` never reads standard input; a write bigger than the pipe buffer then fails with EPIPE.
  const result = await runGit(os.tmpdir(), ['version'], undefined, { input: 'x'.repeat(8 * 1024 * 1024) });
  expect(result.code).toBe(0);
  // A stream error with no listener surfaces as an uncaught exception after the call; give it its turn.
  await new Promise(resolve => setTimeout(resolve, 200));
});
