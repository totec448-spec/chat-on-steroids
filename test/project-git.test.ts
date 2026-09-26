import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { ProjectGitWatchSet, readProjectGitDiff, readProjectGitSnapshot } from '../src/main/project-git.js';
import { addProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

const exec = promisify(execFile);
let directory: string;
let approved: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd, windowsHide: true });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-git-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(approved, { recursive: true });
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory);
  initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
});

afterEach(async () => {
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

async function committedProject(): Promise<{ root: string; id: string }> {
  const root = path.join(approved, 'project');
  await fs.mkdir(root, { recursive: true });
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'deleted.txt'), 'delete me\n');
  await fs.writeFile(path.join(root, 'old-name.ts'), 'export const renamed = 1;\n');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, 'large.txt'), 'a\n'.repeat(300_000));
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'baseline');
  const project = await addProject(root);
  return { root, id: project.id };
}

it('reconciles modified, untracked, deleted, renamed, binary and large changes from real Git', async () => {
  const { root, id } = await committedProject();
  await fs.writeFile(path.join(root, 'modified.ts'), 'export const value = 2;\nexport const next = true;\n');
  await fs.writeFile(path.join(root, 'added.ts'), 'export const added = true;\n');
  await fs.writeFile(path.join(root, 'staged.ts'), 'export const staged = true;\n');
  await git(root, 'add', 'staged.ts');
  await fs.rm(path.join(root, 'deleted.txt'));
  await git(root, 'mv', 'old-name.ts', 'new-name.ts');
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 9, 8, 7]));
  await fs.appendFile(path.join(root, 'large.txt'), 'changed\n');

  const snapshot = await readProjectGitSnapshot(id);
  expect(snapshot.state).toBe('ready');
  const byPath = new Map(snapshot.changes.map(change => [change.path, change]));
  expect(byPath.get('modified.ts')).toMatchObject({ status: 'M', additions: 2, deletions: 1, binary: false });
  expect(byPath.get('added.ts')).toMatchObject({ status: 'U', additions: 1, deletions: 0, binary: false });
  expect(byPath.get('staged.ts')).toMatchObject({ status: 'A', additions: 1, deletions: 0, binary: false });
  expect(byPath.get('deleted.txt')).toMatchObject({ status: 'D', additions: 0, deletions: 1 });
  expect(byPath.get('new-name.ts')).toMatchObject({ status: 'R', previousPath: 'old-name.ts' });
  expect(byPath.get('binary.bin')).toMatchObject({ status: 'M', additions: null, deletions: null, binary: true });

  const modified = await readProjectGitDiff(id, 'modified.ts');
  expect(modified.baseText).toContain('value = 1');
  expect(modified.currentText).toContain('value = 2');
  const renamed = await readProjectGitDiff(id, 'new-name.ts');
  expect(renamed.previousPath).toBe('old-name.ts');
  expect(renamed.baseText).toBe(renamed.currentText);
  const deleted = await readProjectGitDiff(id, 'deleted.txt');
  expect(deleted.currentText).toBe('');
  const added = await readProjectGitDiff(id, 'added.ts');
  expect(added).toMatchObject({ status: 'U', baseText: '', currentText: 'export const added = true;\n' });
  const staged = await readProjectGitDiff(id, 'staged.ts');
  expect(staged).toMatchObject({ status: 'A', baseText: '', currentText: 'export const staged = true;\n' });
  const binary = await readProjectGitDiff(id, 'binary.bin');
  expect(binary).toMatchObject({ binary: true, baseText: null, currentText: null });
  const large = await readProjectGitDiff(id, 'large.txt');
  expect(large).toMatchObject({ tooLarge: true, baseText: null, currentText: null });

  await git(root, 'add', 'added.ts');
  const afterAdd = await readProjectGitSnapshot(id);
  expect(afterAdd.changes.find(change => change.path === 'added.ts')).toMatchObject({ status: 'A', additions: 1 });
});

it('reports a clean repository and a non-repository without inventing changes', async () => {
  const clean = await committedProject();
  expect(await readProjectGitSnapshot(clean.id)).toMatchObject({ state: 'ready', changes: [], truncated: false });

  const plainRoot = path.join(approved, 'plain');
  await fs.mkdir(plainRoot);
  const plain = await addProject(plainRoot);
  expect(await readProjectGitSnapshot(plain.id)).toMatchObject({ state: 'not-repository', changes: [] });
});

it('keeps a nested Local Project scoped to its own subtree', async () => {
  const root = path.join(approved, 'monorepo');
  const nested = path.join(root, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside\n');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'inside\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'baseline');
  const project = await addProject(nested);
  await fs.writeFile(path.join(root, 'outside.txt'), 'changed outside\n');
  await fs.writeFile(path.join(nested, 'inside.txt'), 'changed inside\n');

  const snapshot = await readProjectGitSnapshot(project.id);
  expect(snapshot.changes.map(change => change.path)).toEqual(['inside.txt']);
  const diff = await readProjectGitDiff(project.id, 'inside.txt');
  expect(diff.baseText).toBe('inside\n');
  expect(diff.currentText).toBe('changed inside\n');
});

it('treats Git metadata watches as debounced invalidation, including commit and push refs', async () => {
  vi.useFakeTimers();
  try {
    const { id } = await committedProject();
    const records: Array<{ nativePath: string; recursive: boolean; fire: () => void; close: ReturnType<typeof vi.fn> }> = [];
    const changed: string[] = [];
    const watches = new ProjectGitWatchSet(event => changed.push(event.projectId), (nativePath, listener, recursive = false) => {
      const emitter = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
      emitter.close = vi.fn();
      records.push({ nativePath, recursive, fire: listener, close: emitter.close });
      return emitter as never;
    });
    await watches.sync(id);
    expect(records.some(record => path.basename(record.nativePath) === 'project' && record.recursive)).toBe(true);
    expect(records.some(record => path.basename(record.nativePath) === '.git')).toBe(true);
    const installed = records.length;
    await watches.sync(id);
    expect(records).toHaveLength(installed);
    expect(records.every(record => record.close.mock.calls.length === 0)).toBe(true);
    records[0]!.fire(); records[0]!.fire();
    vi.advanceTimersByTime(179);
    expect(changed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changed).toEqual([id]);
    watches.close();
    expect(records.every(record => record.close.mock.calls.length === 1)).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.runIf(process.platform === 'win32')('invalidates a collapsed nested file through the real recursive Windows watcher', async () => {
  const { root, id } = await committedProject();
  const nested = path.join(root, 'docs');
  const file = path.join(nested, 'HANDOFF.md');
  await fs.mkdir(nested);
  await fs.writeFile(file, 'first\n');
  let resolveChanged!: () => void;
  const changed = new Promise<void>(resolve => { resolveChanged = resolve; });
  const watches = new ProjectGitWatchSet(event => {
    if (event.projectId === id) resolveChanged();
  });
  try {
    await watches.sync(id);
    await fs.writeFile(file, 'first\nsecond\n');
    await Promise.race([
      changed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Git watcher did not invalidate the nested file')), 3_000))
    ]);
  } finally {
    watches.close();
  }
});
