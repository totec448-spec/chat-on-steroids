import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
// @ts-expect-error Plain Node helper without type declarations.
import { runSupervisedUiCheck } from '../scripts/ui-check-supervisor.mjs';
const realProcesses = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const fixture = fileURLToPath(new URL('../scripts/fixtures/ui-check-runner-exit.mjs', import.meta.url));
let root: string;
beforeEach(async () => {
  root = await makeTempDir('cos-ui-supervisor-');
  vi.mocked(fork).mockReset().mockImplementation(realProcesses.fork);
});
afterEach(async () => { vi.restoreAllMocks(); await removeTempDir(root); });
const gone = (pid: number) => {
  let code;
  try { process.kill(pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code).toBe('ESRCH');
};

it.each([0, 7])('preserves result %s, cleans the profile and retires the supervisor on normal completion', async code => {
  const evidence = path.join(root, 'env.json');
  const profileRoot = path.join(root, 'profiles');
  const outcome = await runSupervisedUiCheck(process.execPath, [fixture, 'complete', path.join(root, 'child.pid'), evidence, root, String(code)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, profileRoot
  });
  expect(outcome.code).toBe(code);
  expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual({ runAsNode: null });
  expect(vi.mocked(fork).mock.calls[0]?.[2]).toMatchObject({ env: { ELECTRON_RUN_AS_NODE: '1' } });
  expect(readdirSync(profileRoot)).toEqual([]);
  gone(Number(readFileSync(path.join(root, 'supervisor.pid'), 'utf8')));
});

it.each(['profile setup', 'child spawn'])('reports %s failure and leaves no supervisor running', async stage => {
  const profileRoot = path.join(root, 'profiles');
  if (stage === 'profile setup') writeFileSync(profileRoot, 'not a directory');
  const outcome = await runSupervisedUiCheck(stage === 'child spawn' ? path.join(root, 'missing-executable') : process.execPath, [], {
    env: process.env, profileRoot
  });
  expect(outcome.code).not.toBe(0);
  expect(outcome.output).toMatch(stage === 'profile setup' ? /EEXIST|ENOTDIR/ : /ENOENT/);
  const supervisor = vi.mocked(fork).mock.results[0]?.value;
  expect(supervisor.pid).toBeGreaterThan(0);
  gone(supervisor.pid);
});

it.each(['spawn', 'IPC send'])('retires parent handlers and disconnects its owned supervisor after %s failure', async stage => {
  const failure = new Error(`Synthetic ${stage} failure`);
  const supervisor = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn((_message: unknown, callback: (error: Error) => void) => callback(failure)),
    disconnect(this: EventEmitter & { connected: boolean }) { this.connected = false; this.emit('close', 1, null); }
  });
  vi.mocked(fork).mockReturnValueOnce(supervisor as any);
  const before = ['exit', 'SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
  const pending = runSupervisedUiCheck('fixture', [], { env: {}, profileRoot: root });
  const checked = expect(pending).rejects.toBe(failure);
  if (stage === 'spawn') supervisor.emit('error', failure);
  else supervisor.emit('message', { type: 'ready' });
  await checked;
  expect(supervisor.connected).toBe(false);
  expect(['exit', 'SIGINT', 'SIGTERM'].map(name => process.listenerCount(name))).toEqual(before);
});

it('retires a ready supervisor if its wrapper is force-killed before any launch request', async () => {
  const owner = path.join(root, 'supervisor.pid');
  const wrapper = realProcesses.fork(fixture, ['prelaunch', owner, path.join(root, 'unused'), root], { silent: true });
  const exited = once(wrapper, 'exit');
  const closed = once(wrapper, 'close');
  let supervisor = 0;
  try {
    await vi.waitFor(() => { supervisor = Number(readFileSync(owner, 'utf8')); expect(supervisor).toBeGreaterThan(0); });
    wrapper.kill('SIGKILL'); // Not an IPC-simulated signal on Windows.
    await exited;
    await vi.waitFor(() => gone(supervisor), { timeout: 5000 });
    expect(existsSync(path.join(root, 'outputs'))).toBe(false);
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
    if (supervisor > 0) { try { process.kill(supervisor, 'SIGKILL'); } catch { /* already gone */ } }
    await closed;
  }
});

it('retires without launching if its IPC channel closes before readiness', async () => {
  const supervisor = realProcesses.fork(fileURLToPath(new URL('../scripts/ui-check-supervisor.mjs', import.meta.url)), [], {
    execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, silent: true
  });
  const exited = once(supervisor, 'exit');
  supervisor.disconnect();
  await exited;
  expect(supervisor.pid).toBeGreaterThan(0);
  gone(supervisor.pid!);
  expect(readdirSync(root)).toEqual([]);
});
