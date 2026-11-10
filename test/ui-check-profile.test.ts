import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
const { createProfile, pruneProfiles } = createRequire(import.meta.url)('../scripts/ui-check-profile.cjs');
const profileSource = readFileSync(new URL('../scripts/ui-check-profile.cjs', import.meta.url), 'utf8');
// Exercise Linux scope checks on every test host, without probing or signalling foreign PIDs.
const isolatedProfiles = ({ host = 'fixture-host', boot = 'fixture-boot', namespace = 'pid:[123]', platform = 'linux', locked = '', realPids = false, groupState = 'gone' } = {}) => {
  const warning = vi.fn();
  const kill = vi.fn((pid: number, signal: number) => {
    if (realPids) {
      if (signal !== 0) throw new Error('Pruning may only probe process liveness');
      return process.kill(pid, 0);
    }
    if (pid < 0 && groupState !== 'gone') {
      if (groupState === 'active') return true;
      throw Object.assign(new Error('fixture group probe failed'), { code: groupState });
    }
    if (pid === process.pid) return true;
    throw Object.assign(new Error('fixture process is gone'), { code: 'ESRCH' });
  });
  const module = { exports: {} as { createProfile: typeof createProfile; pruneProfiles: typeof pruneProfiles } };
  const fileSystem = {
    ...fs,
    readFileSync: (file: fs.PathOrFileDescriptor, ...args: any[]) => file === '/proc/sys/kernel/random/boot_id'
      ? boot : (fs.readFileSync as Function)(file, ...args),
    readlinkSync: () => { if (!namespace) throw new Error('namespace unavailable'); return namespace; },
    rmSync: (file: fs.PathLike, options: fs.RmOptions) => {
      if (String(file) === locked) throw Object.assign(new Error('fixture profile is locked'), { code: 'EBUSY' });
      fs.rmSync(file, options);
    }
  };
  runInNewContext(profileSource, { module, process: { platform, pid: process.pid, kill }, console: { log() {}, warn: warning },
    require: (name: string) => name === 'node:fs' ? fileSystem : name === 'node:os' ? { hostname: () => host } : path });
  return { ...module.exports, warning, kill };
};
let root: string;
beforeEach(async () => { root = await makeTempDir('cos-ui-profile-'); });
afterEach(async () => { await removeTempDir(root); });

it.runIf(process.platform !== 'win32')('retains a force-killed runner profile until its actual owned group retires', async () => {
  const owner = path.join(root, 'profile.path'), ready = path.join(root, 'grandchild.pid');
  const profiles = path.join(root, 'profiles');
  const fixture = fileURLToPath(new URL('../scripts/fixtures/ui-check-runner-exit.mjs', import.meta.url));
  const runner = fork(fixture, ['prune-runner', owner, ready, profiles], { silent: true });
  const exited = once(runner, 'exit'), closed = once(runner, 'close');
  let child = 0, grandchild = 0;
  try {
    await vi.waitFor(() => {
      grandchild = Number(readFileSync(ready, 'utf8'));
      expect(grandchild).toBeGreaterThan(0);
    }, { timeout: 10000, interval: 20 });
    const profilePath = readFileSync(owner, 'utf8'), marker = path.join(profilePath, '.ui-check-owner.json');
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    child = saved.child;
    runner.kill('SIGKILL');
    await exited;
    await vi.waitFor(() => {
      let code;
      try { process.kill(child, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
      expect(code).toBe('ESRCH');
    }, { timeout: 5000, interval: 20 });
    expect(process.kill(grandchild, 0)).toBe(true);
    // Native Linux uses its actual scope; macOS substitutes only the Linux scope
    // identity while retaining real PID/group probes and real fixture processes.
    const helpers = process.platform === 'linux' ? { createProfile, pruneProfiles } : isolatedProfiles({ realPids: true });
    const seed = helpers.createProfile(profiles);
    const scope = JSON.parse(readFileSync(path.join(seed.path, '.ui-check-owner.json'), 'utf8'));
    seed.cleanup();
    writeFileSync(marker, JSON.stringify({ ...saved, host: scope.host, processScope: scope.processScope }));
    helpers.pruneProfiles(profiles);
    expect(existsSync(profilePath), 'a live grandchild must prevent stale-profile deletion').toBe(true);
    process.kill(-child, 'SIGKILL'); // Only the group established by this fixture.
    await vi.waitFor(() => {
      let code;
      try { process.kill(-child, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
      expect(code).toBe('ESRCH');
    }, { timeout: 5000, interval: 20 });
    helpers.pruneProfiles(profiles);
    expect(existsSync(profilePath)).toBe(false);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    if (child > 0) { try { process.kill(-child, 'SIGKILL'); } catch { /* retired */ } }
    if (grandchild > 0) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* retired */ } }
    await closed;
  }
});

it.each([0, 1, 'SIGKILL'] as const)('removes its profile after a child exits with %s', async outcome => {
  const fixture = path.join(root, 'child.cjs');
  writeFileSync(fixture, "process.send('ready');process.on('message',code=>process.exit(code));");
  const profile = createProfile(root);
  const child = fork(fixture, [], { silent: true });
  profile.markChild(child.pid);
  try {
    await once(child, 'message');
    pruneProfiles(root);
    expect(existsSync(profile.path)).toBe(true);
    const closed = once(child, 'close');
    if (typeof outcome === 'string') child.kill(outcome); else child.send(outcome);
    await closed;
    profile.cleanup();
    expect(existsSync(profile.path)).toBe(false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

it('prunes only marked profiles whose parent, child and proven group are all gone', async () => {
  const fixture = path.join(root, 'exit.cjs');
  writeFileSync(fixture, 'process.exit(0)');
  const child = fork(fixture, [], { silent: true });
  await once(child, 'close');
  const dead = child.pid;
  const helpers = isolatedProfiles();
  const seed = helpers.createProfile(root);
  const scope = JSON.parse(readFileSync(path.join(seed.path, '.ui-check-owner.json'), 'utf8'));
  seed.cleanup();
  for (const [name, owner] of [
    ['runtime-stale', { kind: 'terminal-ui-check', parent: dead, child: dead }],
    ['runtime-active-parent', { kind: 'terminal-ui-check', parent: process.pid, child: dead }],
    ['runtime-active-child', { kind: 'terminal-ui-check', parent: dead, child: process.pid }],
    ['runtime-invalid', { kind: 'terminal-ui-check', parent: dead, child: null }],
    ['runtime-other', { kind: 'other', parent: dead, child: dead }]
  ] as const) {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, '.ui-check-owner.json'), JSON.stringify({ ...scope, ...owner,
      processGroup: { kind: 'detached-posix', id: owner.child } }));
  }
  mkdirSync(path.join(root, 'runtime-legacy'));
  writeFileSync(path.join(root, 'results.json'), '{}');
  helpers.pruneProfiles(root);
  expect(readdirSync(root).sort()).toEqual(['exit.cjs', 'results.json', 'runtime-active-child', 'runtime-active-parent', 'runtime-invalid', 'runtime-legacy', 'runtime-other']);
});

it.each(['foreign host', 'foreign namespace', 'previous boot', 'legacy', 'unknown scope'] as const)('retains %s profiles without consulting their numeric PIDs', kind => {
  const ownerHelpers = isolatedProfiles();
  const profile = ownerHelpers.createProfile(root);
  profile.markChild(12345, 12345);
  const marker = path.join(profile.path, '.ui-check-owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  owner.parent = 12344;
  if (kind === 'legacy') { delete owner.host; delete owner.processScope; }
  if (kind === 'unknown scope') owner.processScope = null;
  writeFileSync(marker, JSON.stringify(owner));
  const helpers = isolatedProfiles({ host: kind === 'foreign host' ? 'other-host' : 'fixture-host',
    namespace: kind === 'foreign namespace' ? 'pid:[456]' : 'pid:[123]',
    boot: kind === 'previous boot' ? 'new-boot' : 'fixture-boot' });
  helpers.pruneProfiles(root);
  expect(existsSync(profile.path)).toBe(true);
  expect(helpers.kill).not.toHaveBeenCalled();
});

it.each([{ platform: 'darwin' }, { platform: 'win32' }, { namespace: '' }, { boot: '' }])('retains interrupted profiles when local process scope is ambiguous: %j', scope => {
  const seed = isolatedProfiles().createProfile(root);
  const marker = path.join(seed.path, '.ui-check-owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({ ...owner, parent: 12344, child: 12345,
    processGroup: { kind: 'detached-posix', id: 12345 } }));
  const helpers = isolatedProfiles(scope);
  const fresh = helpers.createProfile(root);
  try {
    expect(existsSync(seed.path)).toBe(true);
    expect(helpers.kill).not.toHaveBeenCalled();
    expect(existsSync(fresh.path)).toBe(true);
  } finally { fresh.cleanup(); }
  expect(existsSync(fresh.path)).toBe(false);
});

it('warns and creates a fresh profile when removing a stale profile fails', () => {
  const helpers = isolatedProfiles();
  const stale = helpers.createProfile(root);
  const marker = path.join(stale.path, '.ui-check-owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({ ...owner, parent: 12344, child: 12345,
    processGroup: { kind: 'detached-posix', id: 12345 } }));
  const lockedHelpers = isolatedProfiles({ locked: stale.path });
  const fresh = lockedHelpers.createProfile(root);
  try {
    expect(lockedHelpers.warning).toHaveBeenCalledWith(expect.stringMatching(/profile cleanup/i), expect.objectContaining({ code: 'EBUSY' }));
    expect(existsSync(stale.path)).toBe(true);
    expect(existsSync(fresh.path)).toBe(true);
    expect(fresh.path).not.toBe(stale.path);
  } finally { fresh.cleanup(); }
});

it.each([
  undefined, null, {}, [], { kind: 'other', id: 12345 }, { kind: 'detached-posix' },
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12345', 54321].map(id => ({ kind: 'detached-posix', id }))
])('retains missing, malformed or mismatched group proof %j without probing a group', processGroup => {
  const helpers = isolatedProfiles();
  const profile = helpers.createProfile(root);
  const marker = path.join(profile.path, '.ui-check-owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({ ...owner, parent: 12344, child: 12345, processGroup }));
  helpers.pruneProfiles(root);
  expect(existsSync(profile.path)).toBe(true);
  expect(helpers.kill).not.toHaveBeenCalled();
});

it.each(['active', 'EPERM', 'EIO'])('retains an owned interrupted profile when group probe is %s', groupState => {
  const helpers = isolatedProfiles({ groupState });
  const profile = helpers.createProfile(root);
  profile.markChild(12345, 12345);
  const marker = path.join(profile.path, '.ui-check-owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({ ...owner, parent: 12344 }));
  helpers.pruneProfiles(root);
  expect(existsSync(profile.path)).toBe(true);
  expect(helpers.kill).toHaveBeenCalledWith(-12345, 0);
  expect(helpers.kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it('records only explicit matching group proof and clears it when the child becomes unknown', () => {
  const helpers = isolatedProfiles();
  const profile = helpers.createProfile(root);
  const marker = path.join(profile.path, '.ui-check-owner.json');
  const owner = () => JSON.parse(readFileSync(marker, 'utf8'));
  profile.markChild(12345);
  expect(owner().processGroup).toBeNull(); // Existing one-argument usage remains usable, not pruning authority.
  profile.markChild(12345, 54321);
  expect(owner().processGroup).toBeNull();
  profile.markChild(12345, 12345);
  expect(owner().processGroup).toEqual({ kind: 'detached-posix', id: 12345 });
  profile.markChild(null);
  expect(owner()).toMatchObject({ child: null, processGroup: null });
  helpers.pruneProfiles(root);
  expect(existsSync(profile.path)).toBe(true);
  expect(helpers.kill).not.toHaveBeenCalled();
});

it.each(['null', 'false', '42', '"unknown"', '[]', '{broken'])('retains invalid owner metadata %s while permitting a fresh profile', metadata => {
  const unknown = path.join(root, 'runtime-unknown');
  mkdirSync(unknown);
  writeFileSync(path.join(unknown, '.ui-check-owner.json'), metadata);
  const profile = createProfile(root);
  try {
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(profile.path)).toBe(true);
    expect(profile.path).not.toBe(unknown);
  } finally { profile.cleanup(); }
  expect(existsSync(unknown)).toBe(true);
});
