import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkpointBeforePatch } from '../src/main/checkpoints/index.js';
import { listCheckpoints, resetCheckpointsForTests } from '../src/main/checkpoints/store.js';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { emptyEvidence, runInCallContext } from '../src/main/mcp/call-context.js';
import { addProject } from '../src/main/projects.js';
import * as sessions from '../src/main/session/store.js';
import * as projectGit from '../src/main/project-git.js';

const execute = promisify(execFile);
let directory: string;
let project: string;
let projectId: string;
const git = async (...args: string[]) => (await execute('git', args, { cwd: project })).stdout;
const capture = () => runInCallContext({ startedAt: Date.now(), transportKey: null, agent: null,
  caller: { transportKey: null, requestId: 'audit-request', conversationId: null, sessionId: 'audit-session' },
  outcome: null, evidence: emptyEvidence() }, () => checkpointBeforePatch([path.join(project, 'app.txt')]));

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-audit-checkpoint-')));
  project = path.join(directory, 'project');
  await fs.mkdir(project);
  initConfigPath(directory);
  initDurableStore(directory);
  sessions.initSessionStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'audit', path: directory }], projects: { codeCheckpoints: true } });
  await git('init');
  await git('config', 'user.name', 'Synthetic Test');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(project, 'app.txt'), 'committed version\n');
  await git('add', '.');
  await git('commit', '-m', 'Synthetic baseline');
  projectId = (await addProject(project)).id;
  vi.spyOn(sessions, 'getSession').mockResolvedValue({ projectId, activeTurnId: 'audit-turn' } as never);
});

async function stageIgnoredFile() {
  await fs.writeFile(path.join(project, '.gitignore'), 'ignored.local\n');
  await fs.writeFile(path.join(project, 'ignored.local'), 'staged ignored work\n');
  await git('add', '-f', '--', 'ignored.local');
}

it('keeps staged ignored work when an unrelated inventory filename is not UTF-8', async () => {
  await stageIgnoredFile();
  const runGit = projectGit.runGit;
  vi.spyOn(projectGit, 'runGit').mockImplementation(async (cwd, args, maxBytes, options) => {
    const result = await runGit(cwd, args, maxBytes, options);
    // Linux permits these bytes; macOS/Windows do not, so inject only the raw inventory row.
    if (args[0] === 'ls-files') result.stdout = Buffer.concat([result.stdout, Buffer.from([0x48, 0x20, 0xff, 0])]);
    return result;
  });
  await capture();
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toBeDefined();
  expect(await git('show', `${checkpoint!.treeOid}:ignored.local`)).toBe('staged ignored work\n');
});

it.skipIf(process.platform !== 'linux')('forwards a real non-UTF-8 assumed filename without dropping staged ignored work', async () => {
  await stageIgnoredFile();
  const name = Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff]);
  const full = Buffer.concat([Buffer.from(project + path.sep), name]);
  await fs.writeFile(full, 'original bytes\n');
  await git('add', '-A');
  const assumed = spawnSync('git', ['update-index', '--assume-unchanged', '-z', '--stdin'], {
    cwd: project, input: Buffer.concat([name, Buffer.from([0])])
  });
  expect(assumed.status).toBe(0);
  await fs.writeFile(full, 'working bytes\n');
  const originalIndex = await fs.readFile(path.join(project, '.git', 'index'));
  await capture();
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toBeDefined();
  expect(await git('show', `${checkpoint!.treeOid}:ignored.local`)).toBe('staged ignored work\n');
  const tree = spawnSync('git', ['ls-tree', '-rz', checkpoint!.treeOid], { cwd: project });
  expect(tree.status).toBe(0);
  const position = tree.stdout.indexOf(name);
  expect(position).toBeGreaterThan(0);
  const record = tree.stdout.subarray(0, position);
  const oid = record.subarray(record.lastIndexOf(0) + 1).toString('ascii').match(/ ([0-9a-f]{40,64})\t$/)?.[1];
  expect(oid).toBeDefined();
  expect(await git('cat-file', 'blob', oid!)).toBe('working bytes\n');
  expect(await fs.readFile(path.join(project, '.git', 'index'))).toEqual(originalIndex);
});

it.each(['unreadable', 'malformed'])('does not replace a valid seeded index with HEAD after %s flag inventory', async failure => {
  await stageIgnoredFile();
  const runGit = projectGit.runGit;
  vi.spyOn(projectGit, 'runGit').mockImplementation(async (cwd, args, maxBytes, options) => {
    if (args[0] === 'ls-files') return failure === 'unreadable'
      ? { code: 1, stdout: Buffer.alloc(0), stderr: 'synthetic inventory refusal' }
      : { code: 0, stdout: Buffer.from('H app.txt'), stderr: '' };
    return runGit(cwd, args, maxBytes, options);
  });
  await capture();
  expect(await listCheckpoints(projectId)).toEqual([]);
  expect(await git('show', ':ignored.local')).toBe('staged ignored work\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetCheckpointsForTests();
  sessions.resetSessionStoreForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it.each(['app.txt', 'nested/日本語 name.txt', ...(process.platform === 'win32' ? [] : ['line\nbreak.txt'])])('captures assume-unchanged working bytes without changing the user index: %s', async filename => {
  if (filename !== 'app.txt') {
    await fs.mkdir(path.dirname(path.join(project, filename)), { recursive: true });
    await fs.writeFile(path.join(project, filename), 'committed version\n');
    await git('add', '--', filename);
  }
  await git('update-index', '--assume-unchanged', '--', filename);
  await fs.writeFile(path.join(project, filename), 'important uncommitted local work\n');
  const originalIndex = await fs.readFile(path.join(project, '.git', 'index'));
  await runInCallContext({ startedAt: Date.now(), transportKey: null, agent: null,
    caller: { transportKey: null, requestId: 'audit-request', conversationId: null, sessionId: 'audit-session' },
    outcome: null, evidence: emptyEvidence() }, () => checkpointBeforePatch([path.join(project, filename)]));
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toBeDefined();
  const saved = await git('show', `${checkpoint!.treeOid}:${filename}`);
  expect(saved).toBe('important uncommitted local work\n');
  expect(await fs.readFile(path.join(project, filename), 'utf8')).toBe(saved);
  expect(await fs.readFile(path.join(project, '.git', 'index'))).toEqual(originalIndex);
});
