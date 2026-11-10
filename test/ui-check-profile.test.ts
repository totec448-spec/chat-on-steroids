import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
const { createProfile, pruneProfiles } = createRequire(import.meta.url)('../scripts/ui-check-profile.cjs');
let root: string;
beforeEach(async () => { root = await makeTempDir('cos-ui-profile-'); });
afterEach(async () => { await removeTempDir(root); });

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

it('prunes only marked profiles whose parent and child are both gone', async () => {
  const fixture = path.join(root, 'exit.cjs');
  writeFileSync(fixture, 'process.exit(0)');
  const child = fork(fixture, [], { silent: true });
  await once(child, 'close');
  const dead = child.pid;
  for (const [name, owner] of [
    ['runtime-stale', { kind: 'terminal-ui-check', parent: dead, child: dead }],
    ['runtime-active-parent', { kind: 'terminal-ui-check', parent: process.pid, child: dead }],
    ['runtime-active-child', { kind: 'terminal-ui-check', parent: dead, child: process.pid }],
    ['runtime-invalid', { kind: 'terminal-ui-check', parent: dead, child: null }],
    ['runtime-other', { kind: 'other', parent: dead, child: dead }]
  ] as const) {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, '.ui-check-owner.json'), JSON.stringify(owner));
  }
  mkdirSync(path.join(root, 'runtime-legacy'));
  writeFileSync(path.join(root, 'results.json'), '{}');
  pruneProfiles(root);
  expect(readdirSync(root).sort()).toEqual(['exit.cjs', 'results.json', 'runtime-active-child', 'runtime-active-parent', 'runtime-invalid', 'runtime-legacy', 'runtime-other']);
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
