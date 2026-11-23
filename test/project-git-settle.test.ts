import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runGit } from '../src/main/project-git.js';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fake.spawn }));
let child: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: PassThrough; stderr: PassThrough; pid?: number };
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { kill: vi.fn(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123 });
  fake.spawn.mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); });

it('waits for hook pipes to close after a writer timeout, not just the parent exit', async () => {
  let settled = false;
  const result = runGit(os.tmpdir(), ['version'], undefined, { timeoutMs: 50, settleOnFailure: true })
    .catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(50);
  expect(child.kill).toHaveBeenCalledWith();
  child.emit('exit', null, 'SIGTERM');
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('close', null, 'SIGTERM');
  expect(await result).toMatchObject({ message: 'Git took too long to respond', gitStopped: true });
});

it('bounds an unconfirmed stop and does not claim it is safe to discard recovery state', async () => {
  const result = runGit(os.tmpdir(), ['version'], undefined, { timeoutMs: 50, settleOnFailure: true }).catch(error => error);
  await vi.advanceTimersByTimeAsync(10_050);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect((await result).gitStopped).not.toBe(true);
});

it('keeps the original immediate timeout contract for callers that did not opt in', async () => {
  const result = runGit(os.tmpdir(), ['version'], undefined, { timeoutMs: 50 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ message: 'Git took too long to respond' });
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it('marks an unspawned writer as stopped', async () => {
  child.pid = undefined;
  const result = runGit(os.tmpdir(), ['version'], undefined, { settleOnFailure: true }).catch(error => error);
  child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
  expect(await result).toMatchObject({ code: 'ENOENT', gitStopped: true });
});
