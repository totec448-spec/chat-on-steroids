import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});
// @ts-expect-error Plain Node helper without type declarations.
import { runUiCheck, terminateCheckTree } from '../scripts/ui-check-process.mjs';

const realProcesses = await vi.importActual<typeof import('node:child_process')>('node:child_process');
beforeEach(() => {
  vi.mocked(spawn).mockReset().mockImplementation(realProcesses.spawn);
  vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 0 } as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const fakeChild = () => Object.assign(new EventEmitter(), {
  pid: 12345, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn()
});

it('bounds timeout recovery even if the child never closes, and keeps its active profile', async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as any);
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn() };
  let result: any;
  runUiCheck('fixture', [], { env: {}, timeoutMs: 50, profile }).then((value: any) => { result = value; });
  await vi.advanceTimersByTimeAsync(2500);
  expect(result?.code).toBe('timeout');
  expect(result?.output).toMatch(/profile.*retain|retain.*profile/i);
  expect(profile.cleanup).not.toHaveBeenCalled();
  expect(child.stdout.destroyed).toBe(true);
  expect(child.unref).toHaveBeenCalled();
});

it('removes a profile only after the timed-out check closes and ignores a late duplicate close', async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as any);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn() };
  const result = runUiCheck('fixture', [], { env: {}, timeoutMs: 50, profile });
  await vi.advanceTimersByTimeAsync(50);
  if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  else expect(spawnSync).toHaveBeenCalledWith(expect.stringMatching(/taskkill\.exe$/), ['/PID', String(child.pid), '/T', '/F'], expect.objectContaining({ timeout: 1000 }));
  expect(profile.cleanup).not.toHaveBeenCalled();
  child.emit('close', null, 'SIGKILL');
  expect((await result).code).toBe('timeout');
  child.emit('close', 0, null);
  expect(profile.cleanup).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 1, 'unhandled'] as const)('keeps the original successful/failing exit contract: %s', async outcome => {
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as any);
  const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn() };
  const result = runUiCheck('fixture', [], { env: {}, timeoutMs: 50, profile });
  if (outcome === 'unhandled') child.stderr.write('UnhandledPromiseRejection: original failure');
  child.emit('close', typeof outcome === 'number' ? outcome : 0, null);
  expect((await result).code).toBe(outcome === 'unhandled' ? 'unhandled rejection' : outcome);
  expect(profile.cleanup).toHaveBeenCalledTimes(1);
});

it('bounds failed tree termination without deleting an uncertain profile', async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as any);
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('termination refused'); });
  vi.mocked(spawnSync).mockReturnValueOnce({ error: new Error('termination refused') } as any);
  const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn() };
  const result = runUiCheck('fixture', [], { env: {}, timeoutMs: 50, profile });
  await vi.advanceTimersByTimeAsync(2500);
  expect((await result).output).toContain('tree termination failed');
  expect(profile.cleanup).not.toHaveBeenCalled();
  expect(profile.markChild).toHaveBeenLastCalledWith(null);
});

it('uses the bounded Windows tree helper rather than killing only the root', () => {
  terminateCheckTree(12345, 'win32');
  expect(spawnSync).toHaveBeenCalledWith(expect.stringMatching(/System32\\taskkill\.exe$/),
    ['/PID', '12345', '/T', '/F'], expect.objectContaining({ timeout: 1000, killSignal: 'SIGKILL', windowsHide: true }));
  vi.mocked(spawnSync).mockReturnValueOnce({ error: new Error('helper timed out') } as any);
  expect(() => terminateCheckTree(12345, 'win32')).toThrow('helper timed out');
});

it('terminates a real child and its pipe-holding grandchild, then runs the next check', async () => {
  vi.mocked(spawnSync).mockImplementation(realProcesses.spawnSync);
  const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn() };
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"console.log('GRANDCHILD_READY:'+process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  let triggerTimeout!: () => void;
  const realSetTimeout = globalThis.setTimeout;
  // Capture only the runner deadline. Real I/O/readiness continues, with a safety bound.
  vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(((callback: () => void) => {
    triggerTimeout = callback;
    return realSetTimeout(callback, 30_000);
  }) as any);
  let ready!: (pid: number) => void;
  const readiness = new Promise<number>(resolve => { ready = resolve; });
  vi.mocked(spawn).mockImplementationOnce((...args: Parameters<typeof spawn>) => {
    const child = realProcesses.spawn(...args);
    let output = '';
    child.stdout?.on('data', chunk => {
      output += String(chunk);
      const pid = output.match(/GRANDCHILD_READY:(\d+)/)?.[1];
      if (pid) ready(Number(pid));
    });
    return child;
  });
  const pending = runUiCheck(process.execPath, ['-e', parent], { env: process.env, timeoutMs: 5000, profile });
  let grandchild = 0;
  try {
    grandchild = await readiness;
    triggerTimeout();
    const result = await pending;
    expect(result.code).toBe('timeout');
    expect(grandchild).toBeGreaterThan(0);
    await vi.waitFor(() => {
      let code: string | undefined;
      try { process.kill(grandchild, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
      expect(code).toBe('ESRCH');
    }, { timeout: 5000, interval: 20 });
    expect(profile.cleanup).toHaveBeenCalledTimes(1);
    const next = await runUiCheck(process.execPath, ['-e', 'console.log("NEXT_CHECK")'], { env: process.env, timeoutMs: 5000 });
    expect(next.code).toBe(0);
    expect(next.output).toContain('NEXT_CHECK');
  } finally {
    const pid = profile.markChild.mock.calls[0]?.[0];
    if (Number.isSafeInteger(pid)) { try { terminateCheckTree(pid); } catch { /* already gone */ } }
    if (Number.isSafeInteger(grandchild) && grandchild > 0) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } }
  }
});

it.each(['exit', 'SIGINT', 'SIGTERM'] as const)('stops only the active check on runner %s and retires its handlers', async event => {
  vi.useFakeTimers();
  const listeners = (name: string): Function[] => EventEmitter.prototype.listeners.call(process, name);
  const previous = Object.fromEntries(['exit', 'SIGINT', 'SIGTERM'].map(name => [name, listeners(name)]));
  const child = fakeChild();
  vi.mocked(spawn).mockReturnValueOnce(child as any);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const pending = runUiCheck('fixture', [], { env: {}, timeoutMs: 5000 });
  const handler = listeners(event).find(fn => !previous[event]!.includes(fn))!;
  expect(handler).toBeTypeOf('function');
  handler();
  if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  else expect(spawnSync).toHaveBeenCalled();
  if (event !== 'exit') expect(exit).toHaveBeenCalledWith(event === 'SIGINT' ? 130 : 143);
  child.emit('close', null, 'SIGKILL');
  await pending;
  for (const name of ['exit', 'SIGINT', 'SIGTERM']) expect(listeners(name)).toEqual(previous[name]);
});
