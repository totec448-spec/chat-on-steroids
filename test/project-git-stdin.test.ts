import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { runGit } from '../src/main/project-git.js';

it('survives Git exiting before it read its input, instead of crashing on a closed pipe', async () => {
  // `git version` never reads standard input; a write bigger than the pipe buffer then fails with EPIPE.
  const result = await runGit(os.tmpdir(), ['version'], undefined, { input: 'x'.repeat(8 * 1024 * 1024) });
  expect(result.code).toBe(0);
  // A stream error with no listener surfaces as an uncaught exception after the call; give it its turn.
  await new Promise(resolve => setTimeout(resolve, 200));
});

it.skipIf(process.platform === 'win32')('marks an actual failed Git launch as having no started child', async () => {
  const previous = process.env['PATH'];
  process.env['PATH'] = '';
  try {
    await expect(runGit(os.tmpdir(), ['version'])).rejects.toMatchObject({ code: 'ENOENT', gitStopped: true });
  } finally {
    if (previous === undefined) delete process.env['PATH']; else process.env['PATH'] = previous;
  }
});


it.skipIf(process.platform === 'win32')('does not attest that delegated writers stopped when a timed-out Git hook closes its pipes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-git-background-'));
  const gate = path.join(root, 'release'), foreground = path.join(root, 'foreground-release'), late = path.join(root, 'late'), finished = path.join(root, 'finished');
  const exec = promisify(execFile), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (...args: string[]) => exec('git', args, { cwd: root, env });
  const until = async (file: string) => {
    const deadline = Date.now() + 10_000;
    while (!await fs.access(file).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error('synthetic hook did not finish');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid');
    const script = path.join(root, 'writer.cjs'), hooks = path.join(root, '.git', 'hooks');
    await fs.writeFile(script, `const fs = require('node:fs'), [gate, target] = process.argv.slice(2), deadline = Date.now() + 20000;
      const check = () => { if (fs.existsSync(gate)) { fs.writeFileSync(target, 'released'); return; }
      if (Date.now() > deadline) return; setTimeout(check, 10); }; check();`);
    await fs.writeFile(path.join(hooks, 'post-commit'), `#!/bin/sh\n"${process.execPath}" "${script}" "${gate}" "${late}" </dev/null >/dev/null 2>&1 &\n"${process.execPath}" "${script}" "${foreground}" "${finished}"\n`, { mode: 0o755 });
    const result = await runGit(root, ['commit', '--allow-empty', '-m', 'Delegated writer'], undefined, { timeoutMs: 2000 }).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    // Only a rejected runner releases the foreground hook. It cannot win a sleep/timer race.
    await fs.writeFile(foreground, 'release');
    await until(finished); // Foreground hook/pipes end while the redirected child is still gated.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(result.gitStopped).not.toBe(true);
    await fs.writeFile(gate, 'release'); await until(late);
  } finally {
    await fs.writeFile(foreground, 'release');
    await fs.writeFile(gate, 'release');
    await fs.rm(root, { recursive: true, force: true });
  }
});
