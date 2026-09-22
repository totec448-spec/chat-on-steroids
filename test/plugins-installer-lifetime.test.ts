import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
const terminate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../src/main/exec.js', () => ({ terminateProcessTree: terminate }));
import { runInstaller, stopInstallers } from '../src/main/plugins/installer.js';

let child: EventEmitter & { pid: number };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { pid: 123456 });
  spawn.mockReturnValue(child);
});
afterEach(() => { child.emit('close', 0); vi.useRealTimers(); });

it.each([0, 7])('retains installer custody until all process handles close (exit=%s)', async code => {
  let settled = false;
  const result = runInstaller('fixture-runtime', [], '.').then(() => { settled = true; return null; }, error => { settled = true; return error; });
  child.emit('exit', code);
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  await stopInstallers();
  expect(terminate).toHaveBeenCalledExactlyOnceWith(child.pid, true);
  child.emit('close', code);
  const error = await result;
  if (code === 0) expect(error).toBeNull();
  else expect(error.message).toContain('exit 7');
  terminate.mockClear(); await stopInstallers();
  expect(terminate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the existing bounded deadline when an exited installer has not closed', async () => {
  const result = runInstaller('fixture-runtime', [], '.').catch(error => error);
  child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(180000);
  expect((await result).message).toBe('Installation timed out after three minutes');
  expect(terminate).toHaveBeenCalledExactlyOnceWith(child.pid, true);
});

it('reports spawn failure without requiring a process-close receipt', async () => {
  const result = runInstaller('missing-runtime', [], '.').catch(error => error);
  child.emit('error', new Error('ENOENT'));
  expect((await result).message).toContain('Required runtime missing-runtime is unavailable');
  expect(vi.getTimerCount()).toBe(0);
});
