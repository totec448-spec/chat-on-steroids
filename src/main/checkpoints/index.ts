/**
 * Code checkpoints: a Git tree of the Local Project taken before a turn's first patch, and a
 * confirmed per-file Restore from it. Only Git objects are written while capturing; no ref,
 * branch, HEAD or the user's index ever changes. Review projects the comparison (project-git.ts).
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { responseTurnId } from '../../shared/chronology.js';
import { CHECKPOINT_REF_PREFIX, type CheckpointRestoreResult, type ProjectGitSnapshot } from '../../shared/project-git.js';
import { getConfig } from '../config.js';
import { logInfo, logWarn } from '../logger.js';
import { currentCall } from '../mcp/call-context.js';
import { projectRestoreTarget, revalidateProjectFileTarget } from '../project-files.js';
import { decode, readProjectGitSnapshot, repositoryContext, runGit, withTemporaryIndex, type RepositoryContext } from '../project-git.js';
import { rawPromises as fs } from '../rawfs.js';
import { isContained } from '../sandbox.js';
import { getSession } from '../session/store.js';
import { addCheckpoint, findCheckpoint, hasCheckpoint, type CodeCheckpoint } from './store.js';

const OID = /^[0-9a-f]{40,64}$/;
const CAPTURE_BUDGET_MS = 10_000;
const MAX_RESTORE_FILE_BYTES = 64 * 1024 * 1024;

const MAX_FAILED_TURNS = 256;
const MAX_CAPTURED_TURNS = 512;

const captures = new Map<string, Promise<void>>();
/** Turns whose capture failed; their patches already ran, so a later capture would not be "before". */
const failedTurns = new Set<string>();
/** Successful turn keys stay fenced after their visible ledger entry is evicted. */
const capturedTurns = new Set<string>();
const restores = new Map<string, Promise<unknown>>();
/** Turns whose skipped capture was already logged, so a long turn says it once. */
const skipsLogged = new Set<string>();

function rememberFailedTurn(flight: string): void {
  failedTurns.add(flight);
  for (const oldest of failedTurns) {
    if (failedTurns.size <= MAX_FAILED_TURNS) break;
    failedTurns.delete(oldest);
  }
}

function rememberCapturedTurn(flight: string): void {
  capturedTurns.add(flight);
  for (const oldest of capturedTurns) {
    if (capturedTurns.size <= MAX_CAPTURED_TURNS) break;
    capturedTurns.delete(oldest);
  }
}

/**
 * The repository's own index, as Git resolves it for this worktree, or null when it has none yet
 * (a new repository, an unborn branch). Read without the temporary index in the environment.
 */
async function repositoryIndexPath(context: RepositoryContext): Promise<string | null> {
  const result = await runGit(context.projectReal, ['rev-parse', '--git-path', 'index'], 64 * 1024, { noReplaceObjects: true });
  if (result.code !== 0) return null;
  const relative = decode(result.stdout).replace(/\r?\n$/, '');
  if (!relative) return null;
  return path.resolve(context.projectReal, relative);
}

/** Starts the temporary index as a copy of the repository's, so its stat data is valid. */
async function seedFromRepositoryIndex(context: RepositoryContext, indexFile: string): Promise<boolean> {
  const source = await repositoryIndexPath(context).catch(() => null);
  if (!source) return false;
  try {
    const stats = await fs.stat(source);
    await fs.copyFile(source, indexFile);
    // Git treats an entry as racily clean by comparing it with the index file's own mtime; the
    // copy keeps the original's (rounded down), or a file edited in the same second as the last
    // index write with an unchanged size would read as unchanged.
    const mtime = new Date(Math.floor(stats.mtimeMs));
    await fs.utimes(indexFile, mtime, mtime);
    return true;
  } catch {
    await fs.rm(indexFile, { force: true }).catch(() => undefined);
    return false;
  }
}

async function snapshotTree(context: RepositoryContext, indexFile: string, seeded: boolean): Promise<{ treeOid: string; headOid: string | null }> {
  // A full index in the temporary file: a split index would write its shared part next to it.
  const git = (args: string[]) => runGit(context.projectReal, ['-c', 'core.splitIndex=false', ...args], 64 * 1024, { indexFile, noReplaceObjects: true });
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const headOid = head.code === 0 ? decode(head.stdout).trim() : null;
  if (headOid !== null && !OID.test(headOid)) throw new Error('Git returned an invalid HEAD');
  if (!seeded) {
    // A freshly read index has no stat data, so the add below hashes every tracked file.
    const read = await git(headOid ? ['read-tree', headOid] : ['read-tree', '--empty']);
    if (read.code !== 0) throw new Error(read.stderr || 'Git could not read HEAD');
  }
  // From the project folder, `.` limits the snapshot to the project. Outside it the tree keeps
  // what the seed holds (the user's staged state, or HEAD); nothing compares or restores there.
  const added = await git(['add', '-A', '--', '.']);
  if (added.code !== 0) throw new Error(added.stderr || 'Git could not snapshot the project');
  const tree = await git(['write-tree']);
  const treeOid = decode(tree.stdout).trim();
  if (tree.code !== 0 || !OID.test(treeOid)) throw new Error(tree.stderr || 'Git could not write the checkpoint tree');
  return { treeOid, headOid };
}

async function captureTree(context: RepositoryContext): Promise<{ treeOid: string; headOid: string | null }> {
  return withTemporaryIndex(async indexFile => {
    if (await seedFromRepositoryIndex(context, indexFile)) {
      try { return await snapshotTree(context, indexFile, true); } catch (error) {
        // An index Git cannot write as a tree (an unresolved merge outside the project, say).
        logWarn(`code checkpoint: the repository index could not seed the snapshot, reading HEAD instead: ${error instanceof Error ? error.message : String(error)}`);
        await fs.rm(indexFile, { force: true }).catch(() => undefined);
      }
    }
    return snapshotTree(context, indexFile, false);
  });
}

async function createCheckpoint(context: RepositoryContext, sessionId: string, key: string, reason: CodeCheckpoint['reason'],
  abandoned: () => boolean = () => false, keep?: string): Promise<CodeCheckpoint | null> {
  const { treeOid, headOid } = await captureTree(context);
  // A capture that outlived its budget may have read files the patch has since written.
  if (abandoned()) return null;
  const entry: CodeCheckpoint = {
    id: randomBytes(16).toString('hex'), projectId: context.projectId, sessionId, key, reason, treeOid, headOid, createdAt: Date.now()
  };
  await addCheckpoint(entry, keep);
  return entry;
}

async function captureWithinBudget(context: RepositoryContext, sessionId: string, key: string): Promise<void> {
  if (await hasCheckpoint(context.projectId, sessionId, key)) return;
  let timedOut = false, timer: NodeJS.Timeout | undefined;
  const capture = createCheckpoint(context, sessionId, key, 'turn', () => timedOut);
  const deadline = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), CAPTURE_BUDGET_MS); });
  try {
    if (await Promise.race([capture, deadline]) === 'timeout') {
      timedOut = true;
      capture.catch(() => undefined);
      throw new Error('the snapshot took too long');
    }
  } finally { clearTimeout(timer); }
}

/**
 * Called after a patch verified and before it executes. Never fails the patch: an unproven
 * caller, a chat without a Git project or a capture failure simply takes no checkpoint. With
 * `projects.codeCheckpoints` Off (read here, at capture time) none is taken; existing ones stay
 * listed and `restoreCheckpoint` is unaffected.
 */
export async function checkpointBeforePatch(realPaths: readonly string[]): Promise<void> {
  try {
    if (getConfig().projects?.codeCheckpoints !== true) return;
    const caller = currentCall()?.caller;
    const sessionId = caller?.sessionId;
    if (!sessionId) return;
    const session = await getSession(sessionId);
    if (!session?.projectId) return;
    const key = session.activeTurnId ? `turn:${responseTurnId(session.timelineTurns, session.activeTurnId)}`
      : caller.requestId ? `request:${caller.requestId}` : null;
    if (!key) return;
    const flight = `${session.projectId}\0${sessionId}\0${key}`;
    if (capturedTurns.has(flight)) return;
    if (failedTurns.has(flight)) {
      if (!skipsLogged.has(flight)) {
        skipsLogged.add(flight);
        if (skipsLogged.size > MAX_FAILED_TURNS) skipsLogged.delete(skipsLogged.values().next().value!);
        logInfo('code checkpoint: no checkpoint for this turn: its first capture failed, and a later one would already hold its edits');
      }
      return;
    }
    let context: RepositoryContext | null;
    try { context = await repositoryContext(session.projectId); }
    catch (error) { rememberFailedTurn(flight); throw error; }
    if (!context || !realPaths.some(real => isContained(context.projectReal, real))) return;
    let work = captures.get(flight);
    if (!work) {
      work = captureWithinBudget(context, sessionId, key)
        .then(() => { rememberCapturedTurn(flight); })
        .catch(error => { rememberFailedTurn(flight); throw error; })
        .finally(() => captures.delete(flight));
      captures.set(flight, work);
    }
    await work;
  } catch (error) {
    logWarn(`code checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Git = (args: string[], maxBytes?: number) => ReturnType<typeof runGit>;

async function treeEntry(git: Git, tree: string, repoPath: string): Promise<{ mode: string; oid: string } | null> {
  const listed = await git(['ls-tree', '-z', tree, '--', repoPath]);
  if (listed.code !== 0) throw new Error(listed.stderr || 'The checkpoint could not be read');
  const match = /^(\d{6}) \w+ ([0-9a-f]{40,64})\t/.exec(decode(listed.stdout));
  return match ? { mode: match[1]!, oid: match[2]! } : null;
}

async function hashFile(git: Git, repoPath: string, real: string): Promise<string> {
  const hashed = await git(['hash-object', `--path=${repoPath}`, '--', real]);
  const oid = decode(hashed.stdout).trim();
  if (hashed.code !== 0 || !OID.test(oid)) throw new Error(hashed.stderr || 'Git could not hash the file');
  return oid;
}

function repositoryPath(context: RepositoryContext, relative: string): string {
  return context.prefix ? context.prefix + '/' + relative : relative;
}

/**
 * A Git tree cannot be restored as a file path. If a checkpoint wants a folder where the
 * working tree has a file, or a file where it has a folder, skip that whole path group before
 * asking for confirmation. In particular, never remove a non-empty conflicting folder.
 */
async function conflictingFileDirectoryPaths(context: RepositoryContext, fromTree: string, paths: readonly string[]): Promise<Set<string>> {
  const git: Git = (args, maxBytes = 4096) => runGit(context.root, args, maxBytes, { noReplaceObjects: true });
  const candidates = new Set<string>();
  for (const relative of paths) {
    const parts = relative.split('/');
    for (let length = parts.length; length > 0; length--) candidates.add(parts.slice(0, length).join('/'));
  }
  const roots = new Set<string>();
  for (const candidate of candidates) {
    const wanted = await treeEntry(git, fromTree, repositoryPath(context, candidate));
    let currentKind: 'file' | 'directory' | 'other' | null = null;
    try { currentKind = (await projectRestoreTarget(context.projectId, candidate)).kind; }
    catch { /* A blocked descendant is handled by checking its existing ancestors. */ }
    const wantedFile = wanted !== null && wanted.mode !== '040000';
    if ((wantedFile && currentKind === 'directory') || (wanted?.mode === '040000' && currentKind === 'file')) {
      roots.add(candidate);
    }
  }
  const skipped = new Set<string>();
  for (const relative of paths) {
    let candidate = relative;
    while (true) {
      if (roots.has(candidate)) { skipped.add(relative); break; }
      const separator = candidate.lastIndexOf('/');
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
  }
  return skipped;
}

/** Writes one file back only while its content still matches what `guardTree` captured. */
async function restoreFile(context: RepositoryContext, fromTree: string, guardTree: string, relative: string):
  Promise<'restored' | CheckpointRestoreResult['skipped'][number]['reason']> {
  const repoPath = repositoryPath(context, relative);
  const git: Git = (args, maxBytes = 4096) => runGit(context.root, args, maxBytes, { noReplaceObjects: true });
  const currentOid = async (): Promise<string | null> => {
    const target = await projectRestoreTarget(context.projectId, relative);
    if (target.kind !== null && target.kind !== 'file') throw new Error('unsupported');
    return target.kind === 'file' ? hashFile(git, repoPath, target.real) : null;
  };
  let observed: string | null;
  try { observed = await currentOid(); } catch { return 'unsupported'; }
  if (((await treeEntry(git, guardTree, repoPath))?.oid ?? null) !== observed) return 'changed';
  const wanted = await treeEntry(git, fromTree, repoPath);
  if (wanted && wanted.mode !== '100644' && wanted.mode !== '100755') return 'unsupported';
  const content = wanted ? await git(['cat-file', '--filters', `${fromTree}:${repoPath}`], MAX_RESTORE_FILE_BYTES) : null;
  if (content && content.code !== 0) return 'failed';
  const target = await projectRestoreTarget(context.projectId, relative);
  if (content) await fs.mkdir(path.dirname(target.real), { recursive: true });
  // Last check before the write: a file edited since the guard snapshot is left alone.
  if (await currentOid() !== observed) return 'changed';
  if (!content) {
    if (target.kind === 'file') {
      await revalidateProjectFileTarget({ ...target, kind: 'file' });
      await fs.rm(target.real);
    }
    return 'restored';
  }
  const previousMode = target.kind === 'file' ? (await fs.stat(target.real)).mode & 0o777 : 0o644;
  const mode = wanted!.mode === '100755' ? previousMode | 0o111 : previousMode & ~0o111;
  const temporary = `${target.real}.cos-restore-${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(temporary, content.stdout, { flag: 'wx', mode });
    await fs.rename(temporary, target.real);
    await fs.chmod(target.real, mode).catch(() => undefined);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  return 'restored';
}

/**
 * Restores the listed files (or every listed change) of one checkpoint comparison. The
 * comparison must still have the revision the user saw. A "Before restore" checkpoint of the
 * current state is taken first, so the restore can itself be undone from Review.
 */
export function restoreCheckpoint(projectId: string, checkpointId: string, paths: readonly string[] | null,
  expectedRevision: string, confirm: (paths: string[]) => Promise<boolean>): Promise<CheckpointRestoreResult> {
  const operation = (restores.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const source = await findCheckpoint(projectId, checkpointId);
    const current = async (): Promise<ProjectGitSnapshot> => {
      const snapshot = await readProjectGitSnapshot(projectId, `${CHECKPOINT_REF_PREFIX}${checkpointId}`);
      if (snapshot.state !== 'ready' || !snapshot.comparison?.checkpoint || !source) {
        throw new Error(snapshot.message || 'This checkpoint is no longer available');
      }
      if (snapshot.revision !== expectedRevision) throw new Error('The comparison changed. Refresh Review and try again.');
      return snapshot;
    };
    const snapshot = await current();
    const wanted = paths ? new Set(paths) : null;
    const selected = snapshot.changes.filter(change => !wanted || wanted.has(change.path)).map(change => change.path);
    if (!selected.length || (wanted && selected.length !== wanted.size)) throw new Error('These files no longer differ from the checkpoint');
    if (!wanted && snapshot.truncated) throw new Error('Too many changes to restore at once. Restore files one by one.');
    const context = await repositoryContext(projectId);
    if (!context) throw new Error('This folder is not a Git repository');
    const conflictPaths = await conflictingFileDirectoryPaths(context, source!.treeOid, selected);
    const restorable = selected.filter(relative => !conflictPaths.has(relative));
    const skipped = [...conflictPaths].map(file => ({ path: file, reason: 'conflict' as const }));
    // Preflight may take time. Do not confirm a list based on a comparison that changed meanwhile.
    await current();
    if (!restorable.length) {
      logInfo(`checkpoint restore: nothing restored; ${skipped.length} path(s) swap a file and a folder`);
      return { confirmed: false, restored: [], skipped, undoRef: null };
    }
    if (!(await confirm(restorable))) {
      logInfo(`checkpoint restore: kept the current files (${restorable.length} offered)`);
      return { confirmed: false, restored: [], skipped: [], undoRef: null };
    }
    // The dialog can stay open for a long time; what is restored must still be what was confirmed.
    await current();
    // A full list must not make room by dropping the very checkpoint being restored.
    const undo = (await createCheckpoint(context, source!.sessionId, `restore:${randomBytes(8).toString('hex')}`, 'restore', undefined, checkpointId))!;
    // A file saved while the undo snapshot was read would be in it, and the per-file guard below
    // compares with that snapshot: check the comparison once more before writing anything.
    await current();
    const result: CheckpointRestoreResult = { confirmed: true, restored: [], skipped, undoRef: `${CHECKPOINT_REF_PREFIX}${undo.id}` };
    for (const relative of restorable) {
      let outcome: Awaited<ReturnType<typeof restoreFile>>;
      try { outcome = await restoreFile(context, source!.treeOid, undo.treeOid, relative); }
      catch (error) {
        logWarn(`checkpoint restore failed for one file: ${error instanceof Error ? error.message : String(error)}`);
        outcome = 'failed';
      }
      if (outcome === 'restored') result.restored.push(relative);
      else result.skipped.push({ path: relative, reason: outcome });
    }
    return result;
  });
  restores.set(projectId, operation);
  return operation;
}
