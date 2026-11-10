import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
// @ts-expect-error Plain Node helper without type declarations.
import { runUiCheck, terminateCheckTree } from '../scripts/ui-check-process.mjs';
const { createProfile } = createRequire(import.meta.url)('../scripts/ui-check-profile.cjs');
const fixture = fileURLToPath(new URL('../scripts/fixtures/ui-check-runner-exit.mjs', import.meta.url));
const runnerSource = readFileSync(new URL('../scripts/ui-check-process.mjs', import.meta.url), 'utf8');
afterEach(() => { vi.useRealTimers(); });
const fakeClock = () => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
const isolatedRunner = (platform: string, pid: number | null = 12345) => {
  let alive = true;
  const child = Object.assign(new EventEmitter(), { pid: pid ?? undefined, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn() });
  const kill = vi.fn((_pid: number, signal: string | number) => {
    if (signal === 0 && !alive) throw Object.assign(new Error('fixture group retired'), { code: 'ESRCH' });
    return true;
  });
  const owner = Object.assign(new EventEmitter(), { platform, env: {}, kill, exit: vi.fn() });
  const warning = vi.fn(), taskkill = vi.fn(() => ({ status: 128 }));
  const api = runInNewContext(runnerSource.replace(/^import .*;\n/gm, '').replace(/export (async )?function /g, '$1function ') + '\n({runUiCheck})', {
    spawn: () => child, spawnSync: taskkill, path, process: owner,
    console: { error: vi.fn(), warn: warning }, Date, performance, setTimeout, clearTimeout
  }) as { runUiCheck: (command: string, args: string[], options: Record<string, unknown>) => Promise<{ code: string | number; output: string }> };
  const profile = { path: '/fixture/profile', markChild: vi.fn(), cleanup: vi.fn() };
  return { ...api, child, owner, profile, kill, taskkill, warning, retired: () => { alive = false; } };
};

it('waits for POSIX ESRCH, not just successful kill dispatch, before profile deletion', async () => {
  fakeClock();
  const h = isolatedRunner('linux');
  const pending = h.runUiCheck('fixture', [], { env: {}, profile: h.profile });
  h.child.emit('close', 7, null);
  expect(h.kill).toHaveBeenCalledWith(-h.child.pid!, 'SIGKILL');
  expect(h.kill).toHaveBeenCalledWith(-h.child.pid!, 0);
  expect(h.profile.cleanup).not.toHaveBeenCalled();
  h.retired();
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).code).toBe(7);
  expect(h.profile.cleanup).toHaveBeenCalledOnce();
});

it.each(['linux', 'win32'])('retains and marks unknown when %s descendant retirement is unconfirmed', async platform => {
  fakeClock();
  const h = isolatedRunner(platform);
  const pending = h.runUiCheck('fixture', [], { env: {}, profile: h.profile });
  h.child.emit('close', 7, null);
  await vi.advanceTimersByTimeAsync(1000);
  const outcome = await pending;
  expect(outcome.code).toBe(7);
  expect(outcome.output).toContain('UI profile retained');
  expect(h.profile.cleanup).not.toHaveBeenCalled();
  expect(h.profile.markChild).toHaveBeenLastCalledWith(null);
  expect(h.warning).toHaveBeenCalledWith('UI profile retained:', expect.any(String));
  if (platform === 'win32') {
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.taskkill).not.toHaveBeenCalled(); // 128 for a dead root is never retirement proof.
    expect(outcome.output).toContain('Windows');
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('still stops the owned POSIX group if the runner exits during post-close confirmation', async () => {
  fakeClock();
  const h = isolatedRunner('linux');
  const pending = h.runUiCheck('fixture', [], { env: {}, profile: h.profile });
  h.child.emit('close', 7, null);
  h.owner.emit('exit');
  expect(h.kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(2);
  expect(h.profile.markChild).toHaveBeenLastCalledWith(null);
  h.retired();
  await vi.advanceTimersByTimeAsync(20);
  await pending;
});

it('fits post-timeout group confirmation within the existing close deadline', async () => {
  fakeClock();
  const h = isolatedRunner('linux');
  let outcome: any;
  h.runUiCheck('fixture', [], { env: {}, timeoutMs: 50, profile: h.profile }).then((result: any) => { outcome = result; });
  await vi.advanceTimersByTimeAsync(950);
  h.child.emit('close', null, 'SIGKILL');
  await vi.advanceTimersByTimeAsync(99);
  expect(outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(outcome.code).toBe('timeout');
  expect(h.profile.cleanup).not.toHaveBeenCalled();
  expect(h.profile.markChild).toHaveBeenLastCalledWith(null);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('bounds confirmation despite wall-clock rollback (already timed out: %s)', async timedOut => {
  fakeClock();
  vi.setSystemTime(60000);
  const h = isolatedRunner('linux');
  let outcome: any;
  h.runUiCheck('fixture', [], { env: {}, timeoutMs: timedOut ? 50 : undefined, profile: h.profile })
    .then((result: any) => { outcome = result; });
  if (timedOut) await vi.advanceTimersByTimeAsync(50);
  h.child.emit('close', 7, null);
  vi.setSystemTime(Date.now() - 60000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(outcome?.code).toBe(timedOut ? 'timeout' : 7);
  expect(h.profile.cleanup).not.toHaveBeenCalled();
  expect(h.profile.markChild).toHaveBeenLastCalledWith(null);
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans a never-spawned Windows child profile without probing or killing a PID', async () => {
  const h = isolatedRunner('win32', null);
  // An omitted PID is an actual spawn failure, not a dead Windows root.
  const pending = h.runUiCheck('missing', [], { env: {}, profile: h.profile });
  h.child.emit('error', new Error('ENOENT'));
  h.child.emit('close', -2, null);
  expect((await pending).code).toBe(-2);
  expect(h.profile.cleanup).toHaveBeenCalledOnce();
  expect(h.kill).not.toHaveBeenCalled();
  expect(h.taskkill).not.toHaveBeenCalled();
});

it('does not delete a crashed check profile while its ignored-stdio grandchild is alive', async () => {
  const root = await makeTempDir('cos-ui-crash-tree-');
  const ready = path.join(root, 'grandchild.pid');
  const profile = createProfile(path.join(root, 'profiles'));
  let grandchild = 0, child = 0;
  try {
    const outcome = await runUiCheck(process.execPath, [fixture, 'crash-parent', '', ready, root], {
      env: process.env, timeoutMs: 10000, profile
    });
    grandchild = Number(readFileSync(ready, 'utf8'));
    expect(grandchild).toBeGreaterThan(0);
    expect(outcome.code).toBe(7);
    if (process.platform === 'win32') {
      expect(existsSync(profile.path)).toBe(true);
      expect(JSON.parse(readFileSync(path.join(profile.path, '.ui-check-owner.json'), 'utf8')).child).toBeNull();
      expect(outcome.output).toMatch(/retained.*Windows|Windows.*retained/s);
    } else {
      // Cleanup may be deferred if the OS cannot confirm group retirement (e.g. zombies).
      let alive = true;
      try { process.kill(grandchild, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      expect(!alive || existsSync(profile.path), 'a still-live grandchild must keep its profile').toBe(true);
      await vi.waitFor(() => {
        let code;
        try { process.kill(grandchild, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
        expect(code).toBe('ESRCH');
      }, { timeout: 5000, interval: 20 });
    }
  } finally {
    if (existsSync(profile.path)) {
      try { child = JSON.parse(readFileSync(path.join(profile.path, '.ui-check-owner.json'), 'utf8')).child; } catch { /* retained unknown */ }
    }
    if (Number.isSafeInteger(child) && child > 0) { try { terminateCheckTree(child); } catch { /* already gone */ } }
    if (grandchild > 0) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } }
    await removeTempDir(root);
  }
});
