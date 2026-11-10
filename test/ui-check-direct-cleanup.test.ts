import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../scripts/verify-workspace-terminal.cjs', import.meta.url), 'utf8');
const filename = fileURLToPath(new URL('../scripts/verify-workspace-terminal.cjs', import.meta.url));

const directEntry = (runUiCheck: Function, underElectron: boolean) => {
  const exit = vi.fn(), error = vi.fn();
  const profile = { path: '/fixture/profile', cleanup: vi.fn() };
  const electron = underElectron ? { app: { exit } } : '/fixture/electron';
  // Substitute only module loading; process-level tests also execute the unmodified source.
  runInNewContext(source.replace("import('./ui-check-process.mjs')", 'loadRunner()'), {
    __filename: filename, __dirname: path.dirname(filename), loadRunner: async () => ({ runUiCheck }),
    process: { env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: '/fixture/electron-host', argv: [filename, filename, '--fixture-flag'], exit },
    console: { error },
    require: (name: string) => {
      if (name === 'electron') return electron;
      if (name === 'node:path') return path;
      if (name === './ui-check-profile.cjs') return { createProfile: () => profile };
      throw new Error(`Unexpected fixture dependency: ${name}`);
    }
  });
  return { exit, error, profile };
};

it.each([0, 9, 'signal SIGTERM', 'unhandled rejection'])('delegates direct invocation and preserves shared supervisor result %s', async code => {
  for (const underElectron of [false, true]) {
    const runUiCheck = vi.fn(async (_command: string, _args: string[], _options: Record<string, unknown>) => ({ code, output: '' }));
    const { exit, error, profile } = directEntry(runUiCheck, underElectron);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(typeof code === 'number' ? code : 1);
    expect(error).not.toHaveBeenCalled();
    expect(runUiCheck).toHaveBeenCalledWith(underElectron ? '/fixture/electron-host' : '/fixture/electron', [filename, '--fixture-flag'], {
      env: { COS_TERMINAL_CHECK_PROFILE: profile.path }, profile, inheritStdio: true
    });
    // Cleanup belongs to the shared supervisor, never a second wrapper-side state machine.
    expect(profile.cleanup).not.toHaveBeenCalled();
  }
});

it('reports a supervisor setup failure and exits through either direct entry point', async () => {
  for (const underElectron of [false, true]) {
    const failure = new Error('Synthetic supervisor setup failure');
    const { exit, error } = directEntry(async () => { throw failure; }, underElectron);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith(failure);
    expect(exit).toHaveBeenCalledWith(1);
  }
});

it('shows runner diagnostics that do not come from the inherited child output', async () => {
  const { exit, error } = directEntry(async () => ({ code: 1, output: 'Synthetic child launch failure' }), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(error).toHaveBeenCalledWith('Synthetic child launch failure');
  expect(exit).toHaveBeenCalledWith(1);
});
