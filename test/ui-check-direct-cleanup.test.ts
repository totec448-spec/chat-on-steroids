import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../scripts/verify-workspace-terminal.cjs', import.meta.url), 'utf8');
const filename = fileURLToPath(new URL('../scripts/verify-workspace-terminal.cjs', import.meta.url));

it.each([0, 9, null])('preserves direct invocation child status %s when profile cleanup fails', code => {
  // Both `node script` and `electron script` are supported entry points. No Electron starts here.
  for (const underElectron of [false, true]) {
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    const failure = new Error('EBUSY: disposable fixture profile');
    const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn(() => { throw failure; }) };
    const spawn = vi.fn((_command: string, _args: string[], _options: { env: NodeJS.ProcessEnv; stdio: string }) => child);
    const exit = vi.fn(), warning = vi.fn();
    const electron = underElectron ? { app: { exit } } : '/fixture/electron';
    runInNewContext(source, { __filename: filename, __dirname: path.dirname(filename),
      process: { env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: '/fixture/electron', argv: [filename], exit },
      console: { error: vi.fn(), warn: warning },
      require: (name: string) => {
        if (name === 'electron') return electron;
        if (name === 'node:path') return path;
        if (name === 'node:child_process') return { spawn };
        if (name === './ui-check-profile.cjs') return { createProfile: () => profile };
        throw new Error(`Unexpected fixture dependency: ${name}`);
      }
    });
    child.emit('close', code);
    expect(exit).toHaveBeenCalledWith(code ?? 1);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/profile cleanup/i), failure);
    expect(profile.cleanup).toHaveBeenCalledTimes(1);
    expect(profile.markChild).toHaveBeenCalledWith(child.pid);
    expect(spawn.mock.calls[0]?.[2].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  }
});
