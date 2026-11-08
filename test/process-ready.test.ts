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
  expect(child.listenerCount('close')).toBe(0);
  expect(child.stdout!.listenerCount('end')).toBe(0);
  expect(child.stderr!.listenerCount('end')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a spawn error immediately instead of waiting for a missing file', async () => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('failed to start: spawn missing-program ENOENT');
  child.emit('error', new Error('spawn missing-program ENOENT'));
  await rejected;
});

it('keeps stderr arriving after exit and reports it when the diagnostic pipes close', async () => {
  const child = fixture();
  const ready = waitForChildPid(child, 15_000);
  const rejected = expect(ready).rejects.toThrow(/code=7, signal=null[\s\S]*startup refused/);
  child.emit('exit', 7, null);
  child.stderr!.emit('data', 'startup refused');
  child.emit('close', 7, null);
  await rejected;
});

it('reports termination by signal before readiness', async () => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('code=null, signal=SIGTERM');
  child.emit('close', null, 'SIGTERM');
  await rejected;
});

it('does not accept a buffered readiness receipt after the parent exits', async () => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('code=1, signal=null');
  child.emit('exit', 1, null);
  child.stdout!.emit('data', `${CHILD_PID_PREFIX}1234\n`);
  child.emit('close', 1, null);
  await rejected;
});

it('reports a fixture that already exited before the waiter was attached', async () => {
  const child = fixture(9);
  child.stdout!.push(null);
  child.stderr!.push('buffered startup error'); child.stderr!.push(null);
  await expect(waitForChildPid(child, 15_000)).rejects.toThrow(/code=9, signal=null[\s\S]*buffered startup error/);
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

it('rejects an oversized PID line even when its newline arrives in a later chunk', async () => {
  const child = fixture();
  const rejected = expect(waitForChildPid(child, 15_000)).rejects.toThrow('invalid child PID (oversized line)');
  child.stdout!.emit('data', CHILD_PID_PREFIX + '1'.repeat(5000));
  child.stdout!.emit('data', '\n');
  await rejected;
});

it('rejects a complete receipt with an embedded carriage return instead of timing out', async () => {
  vi.useFakeTimers();
  const child = fixture();
  const failure = waitForChildPid(child, 15_000).catch((error: unknown) => error);
  child.stdout!.emit('data', `${CHILD_PID_PREFIX}12\r34\n`);
  await vi.advanceTimersByTimeAsync(15_000);
  const error = await failure;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('invalid child PID');
});

it('does not mistake a truncated diagnostic tail for a real line boundary', async () => {
  const child = fixture();
  const ready = waitForChildPid(child, 15_000);
  child.stdout!.emit('data', 'x'.repeat(5000));
  child.stdout!.emit('data', `${CHILD_PID_PREFIX}1234\n${CHILD_PID_PREFIX}5678\n`);
  await expect(ready).resolves.toBe(5678);
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
  expect(child.listenerCount('close')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds the diagnostic drain when an exited fixture leaves inherited pipes open', async () => {
  vi.useFakeTimers();
  const ready = waitForChildPid(fixture(3), 15_000);
  const rejected = expect(ready).rejects.toThrow(/code=3, signal=null[\s\S]*pipes did not close within 15000 ms/);
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
