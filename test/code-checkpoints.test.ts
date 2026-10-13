import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkpointBeforePatch, restoreCheckpoint } from '../src/main/checkpoints/index.js';
import { addCheckpoint, listCheckpoints, MAX_CHECKPOINTS_PER_PROJECT, resetCheckpointsForTests } from '../src/main/checkpoints/store.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { createRegistrar, type ToolContext, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import * as projectGit from '../src/main/project-git.js';
import { readProjectGitDiff, readProjectGitSnapshot } from '../src/main/project-git.js';
import { addProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';
import * as sessions from '../src/main/session/store.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetWorkspaces } from '../src/main/workspace.js';
import { CHECKPOINT_REF_PREFIX } from '../src/shared/project-git.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';
import { IS_WINDOWS, makeTempDir, removeTempDir } from './helpers.js';

const exec = promisify(execFile);
const SESSION = 'session-checkpoints-1';
let directory: string;
let approved: string;
let root: string;
let projectId: string;
let session: { projectId?: string; activeTurnId?: string; timelineTurns?: Record<string, unknown> } | null;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, windowsHide: true })).stdout;
}

beforeEach(async () => {
  directory = await makeTempDir('cos-checkpoints-');
  await fs.mkdir(path.join(directory, 'approved'));
  approved = await validateNewRoot(path.join(directory, 'approved'), []);
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  resetCheckpointsForTests();
  resetWorkspaces();
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'approved', path: approved }] });
  root = path.join(approved, 'project');
  await fs.mkdir(root);
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'kept.txt'), 'kept\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'baseline');
  projectId = (await addProject(root)).id;
  session = { projectId, activeTurnId: 'turn-1', timelineTurns: {} };
  vi.spyOn(sessions, 'getSession').mockImplementation(async id => (id === SESSION && session ? session as never : null));
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetCheckpointsForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

function call(sessionId: string | null, requestId: string | null = null): CallContext {
  return {
    startedAt: Date.now(), transportKey: null, agent: null,
    caller: { transportKey: null, requestId, conversationId: null, sessionId },
    outcome: null, evidence: emptyEvidence()
  };
}

function applyPatch(patch: string, sessionId: string | null = SESSION): Promise<ToolResult> {
  const ctx: ToolContext = {
    roots: getConfig().roots, caps: { ...DEFAULT_CAPABILITIES, create: true, edit: true, deleteFile: true },
    readOnly: false, agentTools: false, sessionTools: false, exposedFinishTool: false
  };
  const registrar = createRegistrar(null, ctx, 'core');
  let handler: ((input: { patch: string }) => Promise<ToolResult>) | undefined;
  registrar.register = ((name, _config, callback) => {
    if (name === 'apply_patch') handler = callback as typeof handler;
  }) as typeof registrar.register;
  registerCoreTools(registrar);
  return runInCallContext(call(sessionId), () => handler!({ patch }));
}

const editApp = (from: string, to: string) =>
  `*** Begin Patch\n*** Update File: /approved/project/app.ts\n@@\n-${from}\n+${to}\n*** End Patch`;

async function repositoryState(): Promise<string[]> {
  return Promise.all([
    git(root, 'rev-parse', 'HEAD'), git(root, 'for-each-ref'), git(root, 'ls-files', '--stage'),
    git(root, 'status', '--porcelain=v1', '--untracked-files=all')
  ]);
}

async function compare(ref: string) {
  const snapshot = await readProjectGitSnapshot(projectId, ref);
  expect(snapshot.state, snapshot.message).toBe('ready');
  return snapshot;
}

it('checkpoints the project once per turn, before the first patch, without touching refs or the index', async () => {
  await fs.writeFile(path.join(root, 'notes.md'), 'untracked before the turn\n');
  const before = await repositoryState();

  expect((await applyPatch(editApp('export const value = 1;', 'export const value = 2;'))).isError).not.toBe(true);
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toMatchObject({ sessionId: SESSION, key: 'turn:turn-1', reason: 'turn' });
  const afterFirst = await repositoryState();
  expect(afterFirst.slice(0, 3)).toEqual(before.slice(0, 3));

  // A later patch of the same turn does not move the checkpoint.
  await applyPatch(editApp('export const value = 2;', 'export const value = 3;'));
  await applyPatch('*** Begin Patch\n*** Add File: /approved/project/created.ts\n+export const created = true;\n*** End Patch');
  expect(await listCheckpoints(projectId)).toHaveLength(1);

  const ref = `${CHECKPOINT_REF_PREFIX}${checkpoint!.id}`;
  const snapshot = await compare(ref);
  expect(snapshot.comparison).toMatchObject({ ref, checkpoint: true, baseOid: checkpoint!.treeOid });
  expect(snapshot.checkpoints).toEqual([{ ref, createdAt: checkpoint!.createdAt, reason: 'turn' }]);
  // The untracked file was part of the checkpoint, so it is not a change since then.
  expect(snapshot.changes.map(change => [change.status, change.path]).sort()).toEqual([['A', 'created.ts'], ['M', 'app.ts']]);
  const diff = await readProjectGitDiff(projectId, 'app.ts', ref, snapshot.revision);
  expect(diff).toMatchObject({ baseText: 'export const value = 1;\n', currentText: 'export const value = 3;\n' });

  // A new turn takes its own checkpoint.
  session = { ...session, activeTurnId: 'turn-2' };
  await applyPatch(editApp('export const value = 3;', 'export const value = 4;'));
  expect((await listCheckpoints(projectId)).map(entry => entry.key)).toEqual(['turn:turn-2', 'turn:turn-1']);
  // Working tree view and branch picker keep working, and list the checkpoints too.
  expect((await readProjectGitSnapshot(projectId)).checkpoints).toHaveLength(2);
});

it('takes no checkpoint for an unproven caller, a chat without a project or a patch outside the project', async () => {
  await fs.writeFile(path.join(approved, 'outside.txt'), 'outside\n');
  expect((await applyPatch(editApp('export const value = 1;', 'export const value = 2;'), null)).isError).not.toBe(true);
  expect((await applyPatch('*** Begin Patch\n*** Update File: /approved/outside.txt\n@@\n-outside\n+changed\n*** End Patch')).isError).not.toBe(true);
  session = { activeTurnId: 'turn-1', timelineTurns: {} };
  expect((await applyPatch(editApp('export const value = 2;', 'export const value = 3;'))).isError).not.toBe(true);
  expect(await listCheckpoints(projectId)).toEqual([]);
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 3;\n');
});

it('falls back to the request id without an active turn, and shares one capture between concurrent patches', async () => {
  session = { projectId, timelineTurns: {} };
  const real = path.join(root, 'app.ts');
  await Promise.all([1, 2, 3].map(() => runInCallContext(call(SESSION, 'wfr_request'), () => checkpointBeforePatch([real]))));
  expect((await listCheckpoints(projectId)).map(entry => entry.key)).toEqual(['request:wfr_request']);
});

it('never fails or blocks the patch when the capture fails', async () => {
  vi.spyOn(projectGit, 'withTemporaryIndex').mockRejectedValue(new Error('disk full'));
  const result = await applyPatch(editApp('export const value = 1;', 'export const value = 2;'));
  expect(result.isError).not.toBe(true);
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 2;\n');
  expect(await listCheckpoints(projectId)).toEqual([]);
});

async function checkpointNow(): Promise<string> {
  await runInCallContext(call(SESSION), () => checkpointBeforePatch([path.join(root, 'app.ts')]));
  const [entry] = await listCheckpoints(projectId);
  return entry!.id;
}

it('restores one file after confirmation and keeps a "Before restore" checkpoint to undo it', async () => {
  const id = await checkpointNow();
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  await fs.writeFile(path.join(root, 'kept.txt'), 'edited\n');
  const before = await repositoryState();
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);

  const confirm = vi.fn(async () => true);
  const result = await restoreCheckpoint(projectId, id, ['app.ts'], revision, confirm);
  expect(confirm).toHaveBeenCalledWith(['app.ts']);
  expect(result).toMatchObject({ confirmed: true, restored: ['app.ts'], skipped: [] });
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect(await fs.readFile(path.join(root, 'kept.txt'), 'utf8')).toBe('edited\n');
  const after = await repositoryState();
  expect(after.slice(0, 3)).toEqual(before.slice(0, 3));

  const undo = await compare(result.undoRef!);
  expect(undo.changes.map(change => change.path)).toEqual(['app.ts']);
  expect((await listCheckpoints(projectId))[0]).toMatchObject({ reason: 'restore' });
  const back = await restoreCheckpoint(projectId, result.undoRef!.slice(CHECKPOINT_REF_PREFIX.length), null, undo.revision, async () => true);
  expect(back.restored).toEqual(['app.ts']);
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 2;\n');
});

it('restores all listed files: recreates deleted ones, removes created ones and keeps the executable bit', async () => {
  await fs.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho one\n', { mode: 0o755 });
  await git(root, 'add', 'run.sh');
  await git(root, 'commit', '-m', 'script');
  const id = await checkpointNow();
  await fs.rm(path.join(root, 'kept.txt'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'created.ts'), 'created\n');
  await fs.writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho two\n');
  const { revision, changes } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);
  expect(changes.map(change => [change.status, change.path]).sort()).toEqual([['A', 'src/created.ts'], ['D', 'kept.txt'], ['M', 'run.sh']]);

  const result = await restoreCheckpoint(projectId, id, null, revision, async () => true);
  expect(result.restored.sort()).toEqual(['kept.txt', 'run.sh', 'src/created.ts']);
  expect(await fs.readFile(path.join(root, 'kept.txt'), 'utf8')).toBe('kept\n');
  await expect(fs.stat(path.join(root, 'src', 'created.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(root, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho one\n');
  if (!IS_WINDOWS) expect((await fs.stat(path.join(root, 'run.sh'))).mode & 0o111).not.toBe(0);
  expect((await compare(`${CHECKPOINT_REF_PREFIX}${id}`)).changes).toEqual([]);
});

it('writes nothing when the user keeps the files, the comparison changed, or a file changed while the dialog was open', async () => {
  const id = await checkpointNow();
  const ref = `${CHECKPOINT_REF_PREFIX}${id}`;
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const { revision } = await compare(ref);

  expect(await restoreCheckpoint(projectId, id, ['app.ts'], revision, async () => false))
    .toEqual({ confirmed: false, restored: [], skipped: [], undoRef: null });
  await expect(restoreCheckpoint(projectId, id, ['app.ts'], 'f'.repeat(64), async () => true)).rejects.toThrow('The comparison changed');
  await expect(restoreCheckpoint(projectId, id, ['kept.txt'], revision, async () => true)).rejects.toThrow('no longer differ');

  // Same line count, so only the file identity tells the two versions apart.
  await expect(restoreCheckpoint(projectId, id, ['app.ts'], revision, async () => {
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 9;\n');
    return true;
  })).rejects.toThrow('The comparison changed');
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 9;\n');
  expect((await listCheckpoints(projectId)).map(entry => entry.reason)).toEqual(['turn']);
});

it.skipIf(IS_WINDOWS)('never writes through a symlink', async () => {
  const id = await checkpointNow();
  await fs.rm(path.join(root, 'kept.txt'));
  await fs.writeFile(path.join(approved, 'secret.txt'), 'outside\n');
  await fs.symlink(path.join(approved, 'secret.txt'), path.join(root, 'kept.txt'));
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);
  const result = await restoreCheckpoint(projectId, id, ['kept.txt'], revision, async () => true);
  expect(result.skipped).toEqual([{ path: 'kept.txt', reason: 'unsupported' }]);
  expect(await fs.readFile(path.join(approved, 'secret.txt'), 'utf8')).toBe('outside\n');
});

it('ignores Git replacement objects when comparing and restoring', async () => {
  const id = await checkpointNow();
  const original = (await git(root, 'rev-parse', 'HEAD:app.ts')).trim();
  await fs.writeFile(path.join(root, 'decoy.txt'), 'replaced content\n');
  const decoy = (await git(root, 'hash-object', '-w', 'decoy.txt')).trim();
  await fs.rm(path.join(root, 'decoy.txt'));
  await git(root, 'replace', original, decoy);
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const snapshot = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);
  const diff = await readProjectGitDiff(projectId, 'app.ts', `${CHECKPOINT_REF_PREFIX}${id}`, snapshot.revision);
  expect(diff.baseText).toBe('export const value = 1;\n');
  await restoreCheckpoint(projectId, id, ['app.ts'], snapshot.revision, async () => true);
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
});

it('keeps a bounded ledger across restarts, and an unknown or pruned tree reads as unavailable', async () => {
  const tree = (await git(root, 'rev-parse', 'HEAD^{tree}')).trim();
  for (let index = 0; index < MAX_CHECKPOINTS_PER_PROJECT + 3; index++) {
    await addCheckpoint({
      id: index.toString(16).padStart(32, '0'), projectId, sessionId: SESSION, key: `turn:${index}`,
      reason: 'turn', treeOid: tree, headOid: null, createdAt: 1_000 + index
    });
  }
  resetCheckpointsForTests();
  const kept = await listCheckpoints(projectId);
  expect(kept).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
  expect(kept.at(-1)!.createdAt).toBe(1_003);

  await addCheckpoint({
    id: 'e'.repeat(32), projectId, sessionId: SESSION, key: 'turn:pruned', reason: 'turn', treeOid: '0'.repeat(40), headOid: null, createdAt: 9_999
  });
  expect(await readProjectGitSnapshot(projectId, `${CHECKPOINT_REF_PREFIX}${'e'.repeat(32)}`)).toMatchObject({ state: 'unavailable', changes: [] });
  expect(await readProjectGitSnapshot(projectId, `${CHECKPOINT_REF_PREFIX}${'f'.repeat(32)}`)).toMatchObject({ state: 'unavailable', changes: [] });
});
