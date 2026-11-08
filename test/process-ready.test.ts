import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { CHILD_PID_PREFIX, waitForChildPid } from './process-ready.js';

function fixture(exitCode: number | null = null) {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode, signalCode: null }) as unknown as ChildProcess;
}
afterEach(() => vi.useRealTimers());

it('waits for a complete readiness line across chunks and removes listeners and its timer', async () => {
  vi.useFakeTimers();
  const child = fixture();
  const ready = waitForChildPid(child, 15_000);
  child.stdout!.emit('data', `unrelated output\n${CHILD_PID_PREFIX}12`);
  child.stdout!.emit('data', '34\r\n');
  await expect(ready).resolves.toBe(1234);
  expect(child.stdout!.listenerCount('data')).toBe(0);
  expect(child.stderr!.listenerCount('data')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a spawn error immediately instead of waiting for a missing file', async () => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('failed to start: spawn missing-program ENOENT');
  child.emit('error', new Error('spawn missing-program ENOENT'));
  await rejected;
});

it('includes the exit code and captured stderr when the fixture fails before readiness', async () => {
  const child = fixture();
  const ready = waitForChildPid(child, 15_000);
  const rejected = expect(ready).rejects.toThrow(/code=7, signal=null[\s\S]*startup refused/);
  child.stderr!.emit('data', 'startup refused');
  child.emit('exit', 7, null);
  await rejected;
});

it('reports termination by signal before readiness', async () => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('code=null, signal=SIGTERM');
  child.emit('exit', null, 'SIGTERM');
  await rejected;
});

it('reports a fixture that already exited before the waiter was attached', async () => {
  const child = fixture(9);
  await expect(waitForChildPid(child, 15_000)).rejects.toThrow('code=9, signal=null');
});

it('refuses a fixture without diagnostic pipes', async () => {
  const child = fixture();
  child.stdout = null;
  await expect(waitForChildPid(child, 15_000)).rejects.toThrow('requires piped stdout and stderr');
});

it.each(['0', 'not-a-pid', '9007199254740992'])('refuses the invalid PID %s', async pid => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('invalid child PID');
  child.stdout!.emit('data', `${CHILD_PID_PREFIX}${pid}\n`);
  await rejected;
});

it('bounds captured output and reports a distinct timeout without a real sleep', async () => {
  vi.useFakeTimers();
  const child = fixture();
  const ready = waitForChildPid(child, 15_000);
  const rejected = expect(ready).rejects.toThrow(/within 15000 ms[\s\S]*latest failure/);
  child.stderr!.emit('data', `discarded-prefix${'x'.repeat(5000)}latest failure`);
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  await expect(ready).rejects.not.toThrow('discarded-prefix');
  expect(child.stdout!.listenerCount('data')).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
