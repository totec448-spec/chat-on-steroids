import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkpointBeforePatch, restoreCheckpoint } from '../src/main/checkpoints/index.js';
import { addCheckpoint, listCheckpoints, MAX_CHECKPOINTS_PER_PROJECT, resetCheckpointsForTests } from '../src/main/checkpoints/store.js';
import * as checkpointStore from '../src/main/checkpoints/store.js';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { emptyEvidence, runInCallContext, type CallContext } from '../src/main/mcp/call-context.js';
import { createRegistrar, type ToolContext, type ToolResult } from '../src/main/mcp/kernel.js';
import { registerCoreTools } from '../src/main/mcp/tools-core.js';
import * as logger from '../src/main/logger.js';
import * as projectGit from '../src/main/project-git.js';
import { presentTrees, readProjectGitDiff, readProjectGitSnapshot } from '../src/main/project-git.js';
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

/** The setting is Off in a fresh config; most tests here exercise capture, so they turn it on. */
async function setCodeCheckpoints(codeCheckpoints: boolean): Promise<void> {
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'approved', path: approved }], projects: { codeCheckpoints } });
}

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
  await setCodeCheckpoints(true);
  root = path.join(approved, 'project');
  await fs.mkdir(root);
  await git(root, 'init');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'config', 'user.name', 'CoS Test');
  // Exact bytes in the assertions below; line-ending conversion has its own test.
  await git(root, 'config', 'core.autocrlf', 'false');
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
  expect(snapshot.checkpoints).toEqual([{ ref, createdAt: checkpoint!.createdAt, reason: 'turn', available: true }]);
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

it('does not take a second Before turn checkpoint after the first is evicted from the ledger', async () => {
  await applyPatch(editApp('export const value = 1;', 'export const value = 2;'));
  expect(await listCheckpoints(projectId)).toHaveLength(1);

  const tree = (await git(root, 'rev-parse', 'HEAD^{tree}')).trim();
  const firstCreatedAt = Date.now() + 1;
  for (let index = 0; index < MAX_CHECKPOINTS_PER_PROJECT; index++) {
    await addCheckpoint({
      id: (index + 100).toString(16).padStart(32, '0'),
      projectId, sessionId: `other-session-${index}`, key: `turn:${index}`,
      reason: 'turn', treeOid: tree, headOid: null, createdAt: firstCreatedAt + index
    });
  }
  expect(await listCheckpoints(projectId)).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
  expect((await listCheckpoints(projectId)).some(entry => entry.sessionId === SESSION)).toBe(false);

  // The successful turn marker is independent of the 20-entry visible ledger.
  await applyPatch(editApp('export const value = 2;', 'export const value = 3;'));
  expect(await listCheckpoints(projectId)).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
  expect((await listCheckpoints(projectId)).some(entry => entry.sessionId === SESSION)).toBe(false);
});

// CodeRabbit on #1443: with a full list, the "Before restore" checkpoint evicted the oldest entry,
// which was the very checkpoint being restored, and the final check then failed with nothing restored.
it('restores the oldest checkpoint of a full list, and keeps it for another restore', async () => {
  const id = await checkpointNow();
  const tree = (await git(root, 'rev-parse', 'HEAD^{tree}')).trim();
  const after = Date.now() + 1;
  for (let index = 0; index < MAX_CHECKPOINTS_PER_PROJECT - 1; index++) {
    await addCheckpoint({
      id: (index + 200).toString(16).padStart(32, '0'),
      projectId, sessionId: `newer-${index}`, key: `turn:newer-${index}`,
      reason: 'turn', treeOid: tree, headOid: null, createdAt: after + index
    });
  }
  expect(await listCheckpoints(projectId)).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 9;\n');
  const ref = `${CHECKPOINT_REF_PREFIX}${id}`;
  const snapshot = await compare(ref);
  const result = await restoreCheckpoint(projectId, id, ['app.ts'], snapshot.revision, async () => true);
  expect(result).toMatchObject({ confirmed: true, restored: ['app.ts'], skipped: [] });
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
  const kept = await listCheckpoints(projectId);
  expect(kept).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT);
  // The restored-from checkpoint and the undo stay; the oldest of the others made room.
  expect(kept.some(entry => entry.id === id)).toBe(true);
  expect(kept.some(entry => entry.reason === 'restore')).toBe(true);
  expect(kept.some(entry => entry.sessionId === 'newer-0')).toBe(false);
});

it('is Off in a fresh config', () => {
  expect(defaultConfig().projects).toEqual({ codeCheckpoints: false });
});

it('takes no checkpoint and creates no ref or index while the setting is Off, and reads it at capture time', async () => {
  await setCodeCheckpoints(false);
  const before = await repositoryState();
  const runGit = projectGit.runGit;
  const temporaryIndexUsed = vi.fn();
  vi.spyOn(projectGit, 'runGit').mockImplementation(async (cwd, args, maxBytes, options) => {
    if (options?.indexFile) temporaryIndexUsed(args);
    return runGit(cwd, args, maxBytes, options);
  });

  expect((await applyPatch(editApp('export const value = 1;', 'export const value = 2;'))).isError).not.toBe(true);
  session = { ...session, activeTurnId: 'turn-2' };
  expect((await applyPatch(editApp('export const value = 2;', 'export const value = 3;'))).isError).not.toBe(true);

  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 3;\n');
  expect(await listCheckpoints(projectId)).toEqual([]);
  expect(temporaryIndexUsed).not.toHaveBeenCalled();
  expect((await repositoryState()).slice(0, 3)).toEqual([before[0], before[1], before[2]]);
  expect((await git(root, 'for-each-ref')).trim()).toBe(before[1]!.trim());

  // The next patch sees the changed setting without any restart: a new turn takes its checkpoint.
  await setCodeCheckpoints(true);
  session = { ...session, activeTurnId: 'turn-3' };
  await applyPatch(editApp('export const value = 3;', 'export const value = 4;'));
  expect((await listCheckpoints(projectId)).map(entry => entry.key)).toEqual(['turn:turn-3']);
});

it('keeps listing existing checkpoints and restoring from them while the setting is Off', async () => {
  const id = await checkpointNow();
  await setCodeCheckpoints(false);
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  session = { ...session, activeTurnId: 'turn-2' };
  await applyPatch(editApp('export const value = 2;', 'export const value = 3;'));
  expect((await listCheckpoints(projectId)).map(entry => entry.key)).toEqual(['turn:turn-1']);

  const ref = `${CHECKPOINT_REF_PREFIX}${id}`;
  const snapshot = await compare(ref);
  expect(snapshot.checkpoints).toEqual([{ ref, createdAt: expect.any(Number), reason: 'turn', available: true }]);
  expect((await readProjectGitSnapshot(projectId)).checkpoints).toHaveLength(1);

  const result = await restoreCheckpoint(projectId, id, ['app.ts'], snapshot.revision, async () => true);
  expect(result).toMatchObject({ confirmed: true, restored: ['app.ts'], skipped: [] });
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
  // The "Before restore" undo entry is part of Restore itself, not a new turn capture.
  expect((await listCheckpoints(projectId)).map(entry => entry.reason)).toEqual(['restore', 'turn']);
  const undo = await compare(result.undoRef!);
  expect((await restoreCheckpoint(projectId, result.undoRef!.slice(CHECKPOINT_REF_PREFIX.length), null, undo.revision, async () => true)).restored)
    .toEqual(['app.ts']);
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 3;\n');
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

it('takes no later checkpoint in a turn whose first capture failed, since its patch already ran', async () => {
  vi.spyOn(projectGit, 'withTemporaryIndex').mockRejectedValueOnce(new Error('disk full'));
  const info = vi.spyOn(logger, 'logInfo');
  await applyPatch(editApp('export const value = 1;', 'export const value = 2;'));
  await applyPatch(editApp('export const value = 2;', 'export const value = 3;'));
  await applyPatch(editApp('export const value = 3;', 'export const value = 3;'));
  expect(await listCheckpoints(projectId)).toEqual([]);
  // The skip says why, once per turn.
  expect(info.mock.calls.filter(([line]) => /no checkpoint for this turn: its first capture failed/.test(String(line)))).toHaveLength(1);

  session = { ...session, activeTurnId: 'turn-2' };
  await applyPatch(editApp('export const value = 3;', 'export const value = 4;'));
  expect((await listCheckpoints(projectId)).map(entry => entry.key)).toEqual(['turn:turn-2']);
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

it('skips a file-to-folder checkpoint swap before confirmation and leaves the file intact', async () => {
  await fs.mkdir(path.join(root, 'a'));
  await fs.writeFile(path.join(root, 'a', 'child.ts'), 'from checkpoint\n');
  const id = await checkpointNow();

  await fs.rm(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'a'), 'current file\n');
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);
  const confirm = vi.fn(async () => true);

  const info = vi.spyOn(logger, 'logInfo');
  const result = await restoreCheckpoint(projectId, id, null, revision, confirm);
  expect(confirm).not.toHaveBeenCalled();
  expect(result).toMatchObject({ confirmed: false, restored: [], undoRef: null });
  expect(info).toHaveBeenCalledWith('checkpoint restore: nothing restored; 2 path(s) swap a file and a folder');
  expect(result.skipped.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'a', reason: 'conflict' },
    { path: 'a/child.ts', reason: 'conflict' }
  ]);
  expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('current file\n');
});

it('restores nothing when a file changes while the undo checkpoint is taken', async () => {
  const id = await checkpointNow();
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);
  const real = projectGit.withTemporaryIndex;
  // The person saves the file in their editor while the "Before restore" snapshot is read.
  vi.spyOn(projectGit, 'withTemporaryIndex').mockImplementation(async (work) => {
    await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 9; // typed during the restore\n');
    return real(work);
  });
  await expect(restoreCheckpoint(projectId, id, ['app.ts'], revision, async () => true)).rejects.toThrow('The comparison changed. Refresh Review and try again.');
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 9; // typed during the restore\n');
});

it('confirms only non-conflicting files and keeps a non-empty folder in a folder-to-file swap', async () => {
  await fs.writeFile(path.join(root, 'a'), 'from checkpoint\n');
  const id = await checkpointNow();

  await fs.rm(path.join(root, 'a'));
  await fs.mkdir(path.join(root, 'a'));
  await fs.writeFile(path.join(root, 'a', 'child.ts'), 'current child\n');
  await fs.writeFile(path.join(root, 'a', 'keep.txt'), 'unrelated content\n');
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);
  const confirm = vi.fn(async () => true);

  const result = await restoreCheckpoint(projectId, id, null, revision, confirm);
  expect(confirm).toHaveBeenCalledWith(['app.ts']);
  expect(result.restored).toEqual(['app.ts']);
  expect(result.skipped.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'a', reason: 'conflict' },
    { path: 'a/child.ts', reason: 'conflict' },
    { path: 'a/keep.txt', reason: 'conflict' }
  ]);
  expect(await fs.readFile(path.join(root, 'app.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect(await fs.readFile(path.join(root, 'a', 'child.ts'), 'utf8')).toBe('current child\n');
  expect(await fs.readFile(path.join(root, 'a', 'keep.txt'), 'utf8')).toBe('unrelated content\n');
  expect((await fs.lstat(path.join(root, 'a'))).isDirectory()).toBe(true);
});

it('recreates a file whose parent folders were removed since the checkpoint', async () => {
  await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'deep', 'a.ts'), 'deep\n');
  const id = await checkpointNow();
  await fs.rm(path.join(root, 'src'), { recursive: true });
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);

  const result = await restoreCheckpoint(projectId, id, ['src/deep/a.ts'], revision, async () => true);
  expect(result).toMatchObject({ restored: ['src/deep/a.ts'], skipped: [] });
  expect(await fs.readFile(path.join(root, 'src', 'deep', 'a.ts'), 'utf8')).toBe('deep\n');
});

it('writes line endings the way git checkout would for the repository settings', async () => {
  await git(root, 'config', 'core.autocrlf', 'true');
  const id = await checkpointNow();
  await fs.writeFile(path.join(root, 'kept.txt'), 'edited\r\n');
  const { revision } = await compare(`${CHECKPOINT_REF_PREFIX}${id}`);

  await restoreCheckpoint(projectId, id, ['kept.txt'], revision, async () => true);
  expect(await fs.readFile(path.join(root, 'kept.txt'), 'utf8')).toBe('kept\r\n');
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
  // Git keeps no reference to a checkpoint's tree, so its garbage collection may remove one. The
  // list says so instead of offering it like the others, and comparing it explains why.
  const listed = (await readProjectGitSnapshot(projectId)).checkpoints!;
  expect(listed.find(choice => choice.ref === `${CHECKPOINT_REF_PREFIX}${'e'.repeat(32)}`)?.available).toBe(false);
  expect(listed.filter(choice => choice.available)).toHaveLength(MAX_CHECKPOINTS_PER_PROJECT - 1);
  expect(await readProjectGitSnapshot(projectId, `${CHECKPOINT_REF_PREFIX}${'e'.repeat(32)}`))
    .toMatchObject({ state: 'unavailable', changes: [], message: 'This checkpoint is no longer available. Git has cleaned it up.' });
  expect(await readProjectGitSnapshot(projectId, `${CHECKPOINT_REF_PREFIX}${'f'.repeat(32)}`)).toMatchObject({ state: 'unavailable', changes: [] });
});

it('starts the capture from the repository index, so unchanged files keep their stat data', async () => {
  // Staged inside the project, then edited again: the checkpoint holds the working tree.
  await fs.writeFile(path.join(root, 'kept.txt'), 'staged\n');
  await git(root, 'add', 'kept.txt');
  await fs.writeFile(path.join(root, 'kept.txt'), 'working tree\n');
  const before = await repositoryState();
  const calls: string[][] = [];
  const runGit = projectGit.runGit;
  vi.spyOn(projectGit, 'runGit').mockImplementation(async (cwd, args, maxBytes, options) => {
    if (options?.indexFile) calls.push(args.filter(arg => !arg.startsWith('core.') && arg !== '-c'));
    return runGit(cwd, args, maxBytes, options);
  });

  await applyPatch(editApp('export const value = 1;', 'export const value = 2;'));
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toBeDefined();
  const captureCalls = calls.filter(args => ['read-tree', 'add', 'write-tree'].includes(args[0]!));
  expect(captureCalls.map(args => args[0])).toEqual(['add', 'write-tree']);
  expect(await git(root, 'show', `${checkpoint!.treeOid}:kept.txt`)).toBe('working tree\n');
  expect(await git(root, 'show', `${checkpoint!.treeOid}:app.ts`)).toBe('export const value = 1;\n');
  // The user's own index still holds what they staged.
  expect((await repositoryState()).slice(0, 3)).toEqual(before.slice(0, 3));
  expect(await git(root, 'show', ':kept.txt')).toBe('staged\n');
});

it('falls back to reading HEAD when the repository index cannot seed the capture', async () => {
  const calls: string[][] = [];
  const runGit = projectGit.runGit;
  vi.spyOn(projectGit, 'runGit').mockImplementation(async (cwd, args, maxBytes, options) => {
    if (options?.indexFile) calls.push(args.filter(arg => !arg.startsWith('core.') && arg !== '-c'));
    // The repository reports an index that is not there.
    if (!options?.indexFile && args[0] === 'rev-parse' && args[1] === '--git-path') {
      return { code: 0, stdout: Buffer.from('missing-index-file\n'), stderr: '' };
    }
    return runGit(cwd, args, maxBytes, options);
  });

  await fs.writeFile(path.join(root, 'notes.md'), 'untracked\n');
  await applyPatch(editApp('export const value = 1;', 'export const value = 2;'));
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toBeDefined();
  expect(calls.filter(args => ['read-tree', 'add', 'write-tree'].includes(args[0]!)).map(args => args[0])).toEqual(['read-tree', 'add', 'write-tree']);
  expect(await git(root, 'show', `${checkpoint!.treeOid}:notes.md`)).toBe('untracked\n');
  expect(await git(root, 'show', `${checkpoint!.treeOid}:app.ts`)).toBe('export const value = 1;\n');
});

it('falls back to reading HEAD when the seeded index cannot be written as a tree', async () => {
  const calls: string[][] = [];
  const runGit = projectGit.runGit;
  let failedOnce = false;
  vi.spyOn(projectGit, 'runGit').mockImplementation(async (cwd, args, maxBytes, options) => {
    if (options?.indexFile) calls.push(args.filter(arg => !arg.startsWith('core.') && arg !== '-c'));
    // An unresolved merge outside the project makes write-tree refuse the seeded index.
    if (options?.indexFile && args.at(-1) === 'write-tree' && !failedOnce) {
      failedOnce = true;
      return { code: 128, stdout: Buffer.alloc(0), stderr: 'error: other.txt: unmerged (deadbeef)' };
    }
    return runGit(cwd, args, maxBytes, options);
  });

  await applyPatch(editApp('export const value = 1;', 'export const value = 2;'));
  const [checkpoint] = await listCheckpoints(projectId);
  expect(checkpoint).toBeDefined();
  expect(calls.filter(args => ['read-tree', 'add', 'write-tree'].includes(args[0]!)).map(args => args[0]))
    .toEqual(['add', 'write-tree', 'read-tree', 'add', 'write-tree']);
  expect(await git(root, 'show', `${checkpoint!.treeOid}:app.ts`)).toBe('export const value = 1;\n');
});

it('rehashes a file edited in the same second as the last index write, even with the same size', async () => {
  // Without ctime, only Git's racy-clean check against the index file's mtime can see this edit.
  await git(root, 'config', 'core.trustctime', 'false');
  const indexPath = path.join(root, '.git', 'index');
  const indexTime = (await fs.stat(indexPath)).mtime;
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 7;\n');
  await fs.utimes(path.join(root, 'app.ts'), indexTime, indexTime);
  // A real wait: the edit must keep the exact stat the index recorded (same size, same second), and
  // only the clock moving past that second makes Git's racy-clean check the one thing that sees it.
  // Moving the timestamps instead changes the recorded stat and no longer tests this path.
  await new Promise(resolve => setTimeout(resolve, 1_100));

  await applyPatch(editApp('export const value = 7;', 'export const value = 8;'));
  const [checkpoint] = await listCheckpoints(projectId);
  expect(await git(root, 'show', `${checkpoint!.treeOid}:app.ts`)).toBe('export const value = 7;\n');
});

// CodeRabbit on #1443: reading the checkpoint list failing must not take the plain Working tree view with it.
it('keeps the Review snapshot when the checkpoint list cannot be read, and says why only for a checkpoint comparison', async () => {
  await fs.writeFile(path.join(root, 'app.ts'), 'export const value = 2;\n');
  const warn = vi.spyOn(logger, 'logWarn');
  const list = vi.spyOn(checkpointStore, 'listCheckpoints').mockRejectedValue(new Error('checkpoint list unreadable'));
  try {
    const snapshot = await readProjectGitSnapshot(projectId);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.changes.map(change => change.path)).toContain('app.ts');
    expect(snapshot.checkpoints).toEqual([]);
    expect(warn.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringContaining('checkpoint list unreadable'));
    const compared = await readProjectGitSnapshot(projectId, `${CHECKPOINT_REF_PREFIX}missing`);
    expect(compared.state).toBe('unavailable');
    expect(compared.message).toContain('checkpoint list unreadable');
  } finally {
    list.mockRestore();
    warn.mockRestore();
  }
});

// CodeRabbit on #1443: Git failing to read the trees is an error, not "every checkpoint was cleaned up".
it('reports a failed tree check as an error, and a missing tree as gone', async () => {
  const oid = 'a'.repeat(40), gone = 'b'.repeat(40);
  const failed = async () => ({ code: 128, stdout: Buffer.from(''), stderr: 'fatal: unable to read the object database\n' });
  await expect(presentTrees({ projectReal: root }, [oid], failed as never)).rejects.toThrow('Git could not check the checkpoints: fatal: unable to read the object database');
  const options: unknown[] = [];
  const answered = async (_cwd: string, _args: string[], _max: unknown, given: unknown) => {
    options.push(given);
    return { code: 0, stdout: Buffer.from(`${oid} tree\n${gone} missing\n`), stderr: '' };
  };
  expect([...await presentTrees({ projectReal: root }, [oid, gone], answered as never)]).toEqual([oid]);
  // CodeRabbit: a replacement ref must not make a kept tree look cleaned up.
  expect(options).toEqual([expect.objectContaining({ noReplaceObjects: true })]);
});

// CodeRabbit on #1443: a refused checkpoint comparison is logged once, with the checkpoint and why.
it('logs a refused checkpoint comparison once, with the checkpoint and the reason', async () => {
  const warn = vi.spyOn(logger, 'logWarn');
  try {
    const ref = `${CHECKPOINT_REF_PREFIX}${'f'.repeat(32)}`;
    const snapshot = await readProjectGitSnapshot(projectId, ref);
    expect(snapshot.state).toBe('unavailable');
    const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes(ref));
    expect(lines).toEqual([`project git: checkpoint ${ref} of ${projectId} not compared: not in the checkpoint list`]);
  } finally {
    warn.mockRestore();
  }
});

