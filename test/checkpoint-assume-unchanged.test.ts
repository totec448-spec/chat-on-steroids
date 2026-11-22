import { execFile } from 'node:child_process';
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

const execute = promisify(execFile);
let directory: string;
let project: string;
let projectId: string;
const git = async (...args: string[]) => (await execute('git', args, { cwd: project })).stdout;

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
