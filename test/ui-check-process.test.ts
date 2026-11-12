import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Plain Node runner without type declarations.
import { runUiCheck } from '../scripts/ui-check-process.mjs';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(), spawnSync: vi.fn(() => ({ status: 0 }))
}));
const directories: string[] = [];
const profileRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ui-check-test-'));
  directories.push(root);
  return root;
};
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn()
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}
const spawnedProfile = () => vi.mocked(spawn).mock.lastCall?.[2]?.env?.COS_TERMINAL_CHECK_PROFILE as string;
const start = (root?: string) => runUiCheck('fixture', [], { env: {}, timeoutMs: 50, profileRoot: root });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('releases inherited pipes after the close deadline and allows the next check', async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const pending = start(profileRoot());
  const leftBehind = spawnedProfile();
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(50);
  if (process.platform === 'win32') {
    expect(spawnSync).toHaveBeenCalledWith(expect.stringMatching(/taskkill\.exe$/),
      ['/PID', '12345', '/T', '/F'], expect.objectContaining({ timeout: 1_000 }));
  } else {
    expect(spawn).toHaveBeenCalledWith('fixture', [], expect.objectContaining({ detached: true }));
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  }
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await pending).toMatchObject({ code: 'timeout', output: expect.stringMatching(/did not close/) });
  expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
  child.emit('close', null, 'SIGKILL');
  expect(existsSync(leftBehind)).toBe(true);
  const next = fakeChild();
  const subsequent = start(path.dirname(leftBehind));
  expect(spawnedProfile()).not.toBe(leftBehind);
  next.emit('close', 0, null);
  expect(await subsequent).toEqual({ code: 0, output: '' });
  expect(existsSync(leftBehind)).toBe(true);
});

it('removes only this check’s profile after its child closes', async () => {
  const root = profileRoot();
  const before = process.listenerCount('SIGINT');
  for (const code of [0, 7]) {
    const child = fakeChild();
    const pending = start(root);
    const profile = spawnedProfile();
    expect(path.dirname(profile)).toBe(root);
    writeFileSync(path.join(profile, 'fixture-state'), 'temporary');
    expect(existsSync(profile)).toBe(true);
    child.emit('close', code, null);
    expect(await pending).toEqual({ code, output: '' });
    expect(existsSync(profile)).toBe(false);
  }
  expect(process.listenerCount('SIGINT')).toBe(before);
});

it.each([
  { code: null, signal: 'SIGKILL', outcome: 'SIGKILL' },
  { code: 0, signal: null, outcome: 'exit code 0' }
])('keeps the timeout and cleans its profile when the child closes with $outcome', async ({ code, signal }) => {
  vi.useFakeTimers();
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const child = fakeChild();
  const pending = start(profileRoot());
  const profile = spawnedProfile();
  await vi.advanceTimersByTimeAsync(50);
  child.emit('close', code, signal);
  expect((await pending).code).toBe('timeout');
  expect(existsSync(profile)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the check’s unhandled-rejection diagnostic even when it exits zero', async () => {
  const child = fakeChild();
  const pending = start();
  child.stderr.write('UnhandledPromiseRejection: fixture');
  child.emit('close', 0, null);
  expect((await pending).code).toBe('unhandled rejection');
});
