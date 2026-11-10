import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
// @ts-expect-error Plain Node helper without type declarations.
import { terminateCheckTree } from '../scripts/ui-check-process.mjs';

it.each(['exit', 'SIGINT', 'SIGTERM'] as const)('retires a real active tree when its runner receives %s', async action => {
  const root = await makeTempDir('cos-ui-runner-exit-');
  const owner = path.join(root, 'owner.pid');
  const ready = path.join(root, 'grandchild.pid');
  const script = fileURLToPath(new URL('../scripts/fixtures/ui-check-runner-exit.mjs', import.meta.url));
  const runner = fork(script, ['runner', owner, ready, root], { silent: true });
  const closed = once(runner, 'close');
  let grandchild = 0;
  try {
    await vi.waitFor(() => {
      grandchild = Number(readFileSync(ready, 'utf8'));
      expect(grandchild).toBeGreaterThan(0);
    }, { timeout: 10000, interval: 20 });
    // POSIX sends a real signal; Windows exercises the same handler via IPC because
    // child.kill(SIGTERM) there uses TerminateProcess rather than a JS signal handler.
    if (action === 'exit' || process.platform === 'win32') runner.send(action);
    else runner.kill(action);
    const [code] = await closed;
    expect(code).toBe(action === 'exit' ? 0 : action === 'SIGINT' ? 130 : 143);
    const parentPid = Number(readFileSync(owner, 'utf8'));
    expect(parentPid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      for (const pid of [parentPid, grandchild]) {
        let code: string | undefined;
        try { process.kill(pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
        expect(code).toBe('ESRCH');
      }
    }, { timeout: 5000, interval: 20 });
  } finally {
    // Only the PIDs created by this fixture may be reclaimed if an assertion fails.
    try { terminateCheckTree(Number(readFileSync(owner, 'utf8'))); } catch { /* already gone */ }
    if (grandchild > 0) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } }
    if (runner.exitCode === null && runner.signalCode === null) { runner.kill('SIGKILL'); await closed; }
    await removeTempDir(root);
  }
});
