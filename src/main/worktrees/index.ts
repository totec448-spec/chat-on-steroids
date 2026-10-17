import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import type { Workspace } from '../workspace.js';
import { rawPromises as fs } from '../rawfs.js';
import { isContained } from '../sandbox.js';
import { gitExecutable } from '../project-git.js';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_ID = /^worker-[1-9][0-9]{0,5}$/;
const OID = /^[0-9a-f]{40,64}$/;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_BYTES = 1536 * 1024;
const MAX_STATUS = 2_000;
const MAX_FINGERPRINT_ENTRIES = 4_096;
const MAX_FINGERPRINT_DEPTH = 32;
const MAX_FINGERPRINT_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const MANAGED_FOLDER = '.chat-on-steroids-worktrees';

export type WorkerWorkspace = Pick<Workspace, 'real' | 'virtual'>;

export interface WorkerWorktreeLease {
  version: 1;
  runId: string;
  agentId: string;
  ownershipToken: string;
  sourceRepoRoot: string;
  commonDir: string;
  worktreePath: string;
  workspace: WorkerWorkspace;
  branch: string;
  branchRef: string;
  baseOid: string;
  /** Stable filesystem identity; a reused path does not inherit the prior owner's lease. */
  treeIdentity: string;
  workspaceIdentity: string;
  approvedRoot: Root;
  sourceDirty: boolean;
  createdAt: number;
}

/** Creation provenance applies only to this allocation call and never enters a marker. */
export interface AllocatedWorkerWorktree extends WorkerWorktreeLease {
  newlyCreated: boolean;
}

export interface WorkerWorktreeStatus {
  headOid: string;
  dirty: boolean;
  changes: string[];
  truncated: boolean;
}

export interface WorkerWorktreeDiff {
  baseOid: string;
  headOid: string;
  status: WorkerWorktreeStatus;
  committedPatch: string | null;
  committedPatchTruncated: boolean;
  workingPatch: string | null;
  workingPatchTruncated: boolean;
}

export type WorkerFinalizeBranch =
  | { mode: 'keep' }
  | { mode: 'delete-if-integrated'; integratedIntoOid: string }
  | { mode: 'discard' };

export interface WorkerFinalizeResult {
  removed: boolean;
  branchRemoved: boolean;
  branch: string;
  changes: string[];
}

export type WorkerCleanupBlocker =
  | 'tracked-changes'
  | 'untracked-files'
  | 'ignored-files'
  | 'unintegrated-commits'
  | 'status-truncated';

/**
 * A read-only snapshot for the broker to offer explicit cleanup at a worker lifecycle
 * boundary. A clean offer is NOT permission to delete: ignored files may be written
 * after inspection, and Git worktree remove can delete those files without --force.
 */
export interface WorkerCleanupInspection {
  worktreePath: string;
  branch: string;
  branchRef: string;
  baseOid: string;
  headOid: string;
  sourceHeadOid: string;
  hasWorkerCommits: boolean;
  branchIntegratedIntoSource: boolean;
  trackedChanges: string[];
  untrackedFiles: string[];
  ignoredFiles: string[];
  changesTruncated: boolean;
  blockers: WorkerCleanupBlocker[];
  canOfferRemoval: boolean;
}

/** Supplied ONLY by the durable worker broker, never synthesized from a disk marker. */
export interface WorkerCleanupOfferIdentity {
  runId: string;
  agentId: string;
  createdAt: number;
  reason: string;
  ownershipToken?: string;
}

/** Safe for UI projection: no native filesystem path or untracked filename. */
export interface WorkerCleanupOfferPreview {
  runId: string;
  agentId: string;
  createdAt: number;
  reason: string;
  /** Virtual root path, safe to project to the renderer. */
  workspace: string;
  branch: string;
  /** Commit present in this checkout at inspection time; internal only. */
  headOid: string;
  /** Main-process confirmation token. Never project file-derived digests to the renderer. */
  contentFingerprint: string | null;
  dirty: boolean;
  ignoredFiles: boolean;
  uniqueCommits: boolean;
  changes: string[];
  blockers: WorkerCleanupBlocker[];
  canOfferRemoval: boolean;
  hasWorkerCommits: boolean;
  branchIntegratedIntoSource: boolean;
  trackedChangesCount: number;
  untrackedFilesCount: number;
  ignoredFilesCount: number;
  changesTruncated: boolean;
}

export class WorkerWorktreeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkerWorktreeError';
  }
}

interface GitResult { code: number; stdout: Buffer; stderr: string; }
interface RepoContext { cwd: string; root: string; gitDir: string; commonDir: string; }
interface ResolvedRoot { root: Root; real: string; }
interface Marker extends Omit<WorkerWorktreeLease, 'sourceDirty' | 'approvedRoot'> {
  approvedRoot: Root;
  ownerDir: string;
  markerPath: string;
  hooksPath: string;
}

const live = new Map<string, WorkerWorktreeLease>();
const allocations = new Map<string, Promise<AllocatedWorkerWorktree>>();
const busy = new Set<string>();

function keyOf(runId: string, agentId: string): string {
  return `${runId.toLowerCase()}:${agentId}`;
}

function checkedIdentity(runId: string, agentId: string): { runId: string; agentId: string } {
  if (!RUN_ID.test(runId)) throw new WorkerWorktreeError('WORKTREE_IDENTITY_INVALID', 'runId must be the proven broker UUID');
  if (!AGENT_ID.test(agentId)) throw new WorkerWorktreeError('WORKTREE_IDENTITY_INVALID', 'agentId must be a proven worker-N identity');
  return { runId: runId.toLowerCase(), agentId };
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (/^GIT_/i.test(name)) delete environment[name];
  environment['GIT_TERMINAL_PROMPT'] = '0';
  environment['GCM_INTERACTIVE'] = 'never';
  // Git's replacement refs must never alter trusted commit graph checks.
  environment['GIT_NO_REPLACE_OBJECTS'] = '1';
  return environment;
}

/**
 * One repository's worktrees change one Git process at a time. `git worktree add` reads every
 * other worktree's admin folder, and one being created at that moment has no `commondir` yet:
 * concurrent worker allocations failed with "failed to read .git/worktrees/…/commondir"
 * (2026-10-14). Keyed by the repository's common Git directory; add, remove and list wait here.
 */
const worktreeChanges = new Map<string, Promise<unknown>>();
function oneWorktreeChangeAtATime<T>(commonDir: string, change: () => Promise<T>): Promise<T> {
  const run = (worktreeChanges.get(commonDir) ?? Promise.resolve()).then(change);
  const tail = run.catch(() => undefined);
  worktreeChanges.set(commonDir, tail);
  void tail.then(() => { if (worktreeChanges.get(commonDir) === tail) worktreeChanges.delete(commonDir); });
  return run;
}

async function runGit(cwd: string, args: readonly string[], maxBytes = MAX_GIT_BYTES): Promise<GitResult> {
  const executable = gitExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd, env: cleanGitEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false;
    const finish = (error?: Error, code = -1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new WorkerWorktreeError('WORKTREE_GIT_TIMEOUT', 'Git took too long to respond'));
    }, GIT_TIMEOUT_MS);
    child.once('error', error => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill();
        finish(new WorkerWorktreeError('WORKTREE_GIT_OUTPUT', 'Git returned too much data'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once('close', code => finish(undefined, code ?? -1));
  });
}

function safeGitArgs(hooksPath: string, args: readonly string[]): string[] {
  return [
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'commit.gpgSign=false',
    '-c', 'merge.gpgSign=false',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=false',
    '-c', 'diff.external=',
    ...args
  ];
}

function text(result: GitResult): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(result.stdout).replaceAll('\r', '');
}

async function realDirectory(value: string): Promise<string> {
  const real = await fs.realpath(path.resolve(value));
  if (!(await fs.stat(real)).isDirectory()) throw new WorkerWorktreeError('WORKTREE_PATH_INVALID', `${value} is not a directory`);
  return real;
}

async function directoryIdentity(value: string): Promise<string> {
  const stat = await fs.lstat(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) {
    throw new WorkerWorktreeError('WORKTREE_PATH_CHANGED', 'managed directory has no reliable ownership identity');
  }
  return `${stat.dev}:${stat.ino}`;
}

async function rootsOf(approvedRoots: readonly Root[]): Promise<ResolvedRoot[]> {
  const result: ResolvedRoot[] = [];
  for (const root of approvedRoots) {
    if (!root.name || /[\\/]/.test(root.name)) throw new WorkerWorktreeError('WORKTREE_ROOT_INVALID', 'approved root has an invalid virtual name');
    // A server folder (#1469) has no local path; worktrees are only made in folders on this computer.
    if (root.remote) continue;
    // An unrelated approved folder may be offline (for example a disconnected drive).
    // Only existing, resolved roots may authorize an allocation or an owned lease.
    // The selected source and lease's original owning root are checked below.
    try { result.push({ root: { ...root }, real: await realDirectory(root.path) }); }
    catch (error) {
      if (error instanceof WorkerWorktreeError) {
        if (error.code === 'WORKTREE_PATH_INVALID') continue;
        throw error;
      }
      if (typeof (error as NodeJS.ErrnoException)?.code === 'string') continue;
      throw new WorkerWorktreeError('WORKTREE_ROOT_INVALID', `approved root ${root.name} cannot be resolved`);
    }
  }
  if (!result.length) throw new WorkerWorktreeError('WORKTREE_ROOT_REQUIRED', 'no approved root can own a worker worktree');
  return result;
}

function containedByAny(roots: readonly ResolvedRoot[], value: string): boolean {
  return roots.some(entry => isContained(entry.real, value));
}

function sameApprovedRoot(approved: ResolvedRoot, original: Root): boolean {
  // Root approval identity is its configured name/path pair. The canonical path
  // is separately used for containment: macOS can resolve /var to /private/var,
  // and a symlink may have been the originally approved path. A different
  // configured alias must never inherit an existing worker's lease.
  return approved.root.name === original.name &&
    path.resolve(approved.root.path) === path.resolve(original.path);
}

async function repositoryContext(cwd: string, roots: readonly ResolvedRoot[]): Promise<RepoContext> {
  const realCwd = await realDirectory(cwd);
  if (!containedByAny(roots, realCwd)) throw new WorkerWorktreeError('WORKTREE_OUTSIDE_ROOT', 'workspace is outside the approved roots');
  const result = await runGit(realCwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (result.code !== 0) throw new WorkerWorktreeError('WORKTREE_NOT_REPOSITORY', result.stderr || 'workspace is not a Git repository');
  const lines = text(result).trimEnd().split('\n');
  if (lines.length < 3) throw new WorkerWorktreeError('WORKTREE_REPOSITORY_INVALID', 'Git returned an incomplete repository identity');
  const root = await fs.realpath(path.resolve(realCwd, lines[0]!));
  const gitDir = await fs.realpath(path.resolve(realCwd, lines[1]!));
  const commonDir = await fs.realpath(path.resolve(realCwd, lines[2]!));
  if (![root, gitDir, commonDir].every(candidate => containedByAny(roots, candidate))) {
    throw new WorkerWorktreeError('WORKTREE_METADATA_OUTSIDE_ROOT', 'Git repository metadata is outside the approved roots');
  }
  if (!isContained(root, realCwd)) throw new WorkerWorktreeError('WORKTREE_OUTSIDE_REPOSITORY', 'workspace is outside its Git worktree');
  return { cwd: realCwd, root, gitDir, commonDir };
}

function safeRef(value: string): string {
  if (value === 'HEAD') return value;
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('/') || value.endsWith('.')) {
    throw new WorkerWorktreeError('WORKTREE_BASE_REF_INVALID', 'baseRef must be HEAD or a full local branch ref');
  }
  return value;
}

interface DetailedWorkerWorktreeStatus extends WorkerWorktreeStatus {
  trackedChanges: string[];
  untrackedFiles: string[];
  ignoredFiles: string[];
}

async function statusOf(cwd: string, includeIgnored = false): Promise<DetailedWorkerWorktreeStatus> {
  const [head, status] = await Promise.all([
    runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 256),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(includeIgnored ? ['--ignored=matching'] : [])], 1024 * 1024)
  ]);
  const headOid = text(head).trim();
  if (head.code !== 0 || !OID.test(headOid)) throw new WorkerWorktreeError('WORKTREE_HEAD_INVALID', head.stderr || 'Git HEAD is unavailable');
  if (status.code !== 0) throw new WorkerWorktreeError('WORKTREE_STATUS_FAILED', status.stderr || 'Git status failed');
  const parts = text(status).split('\0').filter(Boolean);
  const changes: string[] = [];
  const trackedChanges: string[] = [], untrackedFiles: string[] = [], ignoredFiles: string[] = [];
  for (let index = 0; index < parts.length && changes.length < MAX_STATUS; index++) {
    const record = parts[index]!;
    if (record.length < 4) continue;
    const filename = record.slice(3);
    changes.push(filename);
    if (record.startsWith('!! ')) ignoredFiles.push(filename);
    else if (record.startsWith('?? ')) untrackedFiles.push(filename);
    else trackedChanges.push(filename);
    if ((record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') && index + 1 < parts.length) index++;
  }
  return { headOid, dirty: parts.length > 0, changes, truncated: parts.length > MAX_STATUS, trackedChanges, untrackedFiles, ignoredFiles };
}

/**
 * Bound every byte that Git's status may cause a confirmed removal to discard.
 * `--ignored=matching` can report an entire ignored directory as one `!! dir/`;
 * recurse through those directories without following any directory symlink.
 * Metadata (size/mtime) alone is insufficient: two same-name, same-size edits
 * can have exactly the same mtime on real filesystems.
 */
async function safeTrackedIndexFlags(root: string): Promise<Buffer> {
  // Git deliberately hides working-tree edits on paths with assume-unchanged
  // (lowercase "h") or skip-worktree ("S"/"s"). A clean porcelain status then
  // cannot prove that deleting the checkout preserves these tracked bytes.
  // Inspect *every* tracked index record instead of relying on status paths;
  // refusal is safer than trying to outguess Git's intentionally skipped files.
  const listed = await runGit(root, ['ls-files', '--cached', '-v', '-z'], MAX_GIT_BYTES);
  if (listed.code !== 0) {
    throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNAVAILABLE', 'tracked Git index flags could not be inspected');
  }
  // Parse NUL-terminated raw bytes: filenames may contain newlines, tabs or
  // arbitrary bytes and must not be lossy-decoded when checking index flags.
  const data = listed.stdout;
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(0, offset);
    if (end < offset + 3 || data[offset + 1] !== 0x20) {
      throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNAVAILABLE', 'tracked Git index flag output is incomplete');
    }
    // Normal cached records use "H ". Other tags, including lowercase "h"
    // and "S" / "s", are never safe to remove based on git status alone.
    if (data[offset] !== 0x48) {
      throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNSAFE', 'tracked Git files have hidden or unexpected index flags');
    }
    offset = end + 1;
  }
  return data;
}

async function cleanupContentFingerprint(root: string, inspected?: DetailedWorkerWorktreeStatus): Promise<string> {
  const initialIndexFlags = await safeTrackedIndexFlags(root);
  const initial = await statusOf(root, true);
  if (initial.truncated || (inspected && JSON.stringify(initial) !== JSON.stringify(inspected))) {
    throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNAVAILABLE', 'Git status changed or was truncated during cleanup inspection');
  }
  const index = await runGit(root, ['diff', '--cached', '--raw', '-z', 'HEAD', '--'], 1024 * 1024);
  if (index.code !== 0) throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNAVAILABLE', 'staged Git changes could not be inspected');
  const hash = createHash('sha256');
  hash.update('cos-worktree-cleanup-v1\0');
  hash.update(initial.headOid);
  hash.update('\0tracked-index-flags\0');
  hash.update(initialIndexFlags);
  hash.update('\0index\0');
  hash.update(index.stdout);
  const entries = new Map<string, 'tracked' | 'untracked' | 'ignored'>();
  for (const [kind, filenames] of [
    ['tracked', initial.trackedChanges], ['untracked', initial.untrackedFiles], ['ignored', initial.ignoredFiles]
  ] as const) {
    for (const gitName of filenames) {
      // Porcelain lists collapsed ignored directories with a trailing slash.
      const filename = gitName.replace(/\/$/, '');
      if (!filename || filename.includes('\0') || filename.includes('\ufffd') || path.isAbsolute(filename) ||
          filename.split(/[\\/]/).some(part => part === '..' || part === '.' || !part)) {
        throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNSAFE', 'Git status contains an unsafe path');
      }
      const target = path.resolve(root, filename);
      if (target === root || !isContained(root, target)) {
        throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNSAFE', 'Git status path escaped the worktree');
      }
      entries.set(filename, kind);
    }
  }
  let visited = 0;
  let bytes = 0;
  const addEntry = (): void => {
    if (++visited > MAX_FINGERPRINT_ENTRIES) {
      throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_LIMIT', 'too many changed files for safe cleanup confirmation');
    }
  };
  const addBytes = (amount: number): void => {
    bytes += amount;
    if (bytes > MAX_FINGERPRINT_BYTES) {
      throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_LIMIT', 'changed files exceed the cleanup fingerprint byte limit');
    }
  };
  const scan = async (relative: string, depth: number, allowMissing: boolean): Promise<void> => {
    if (depth > MAX_FINGERPRINT_DEPTH) throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_LIMIT', 'changed directory nesting is too deep');
    const absolute = path.resolve(root, relative);
    if (absolute === root || !isContained(root, absolute)) throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNSAFE', 'changed path escaped the worktree');
    // Resolve each ancestor with lstat: even a symlink pointing inside the root
    // must not turn the fingerprint read into a traversal outside this checkout.
    const components = path.relative(root, absolute).split(path.sep);
    let ancestor = root;
    for (const component of components.slice(0, -1)) {
      ancestor = path.join(ancestor, component);
      const parentStat = await fs.lstat(ancestor);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNSAFE', 'changed path crosses a symlink or non-directory');
      }
    }
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try { before = await fs.lstat(absolute); }
    catch (error: unknown) {
      if (allowMissing && (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        addEntry();
        hash.update('missing\0' + relative + '\0');
        return;
      }
      throw error;
    }
    addEntry();
    hash.update(relative + '\0');
    if (before.isSymbolicLink()) {
      const destination = await fs.readlink(absolute);
      addBytes(Buffer.byteLength(destination));
      hash.update('symlink\0' + destination + '\0');
    } else if (before.isDirectory()) {
      hash.update('directory\0');
      const children: string[] = [];
      // Bounded streaming enumeration: do not allocate an unbounded readdir list.
      for await (const child of await fs.opendir(absolute)) {
        children.push(child.name);
        if (visited + children.length > MAX_FINGERPRINT_ENTRIES) {
          throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_LIMIT', 'ignored directory contains too many files');
        }
      }
      children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const child of children) await scan(path.join(relative, child), depth + 1, false);
    } else if (before.isFile()) {
      hash.update('file\0');
      if (before.size > MAX_FINGERPRINT_BYTES - bytes) {
        throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_LIMIT', 'changed file exceeds the cleanup byte limit');
      }
      const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
          throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_CHANGED', 'changed file was replaced while opening');
        }
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let offset = 0;
        while (offset < opened.size) {
          const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
          if (bytesRead === 0) throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_CHANGED', 'changed file was truncated during reading');
          addBytes(bytesRead);
          hash.update(chunk.subarray(0, bytesRead));
          offset += bytesRead;
        }
        const afterRead = await handle.stat();
        if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs) {
          throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_CHANGED', 'changed file changed during reading');
        }
      } finally { await handle.close(); }
    } else {
      throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_UNSAFE', 'changed path is an unsupported filesystem object');
    }
    const after = await fs.lstat(absolute);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_CHANGED', 'changed path was modified during cleanup inspection');
    }
  };
  const ordered = [...entries].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const [filename, kind] of ordered) {
    hash.update(kind + '\0');
    await scan(filename, 0, kind === 'tracked');
  }
  const [final, finalIndex, finalIndexFlags] = await Promise.all([
    statusOf(root, true), runGit(root, ['diff', '--cached', '--raw', '-z', 'HEAD', '--'], 1024 * 1024),
    safeTrackedIndexFlags(root)
  ]);
  if (final.truncated || JSON.stringify(initial) !== JSON.stringify(final) ||
      finalIndex.code !== 0 || !index.stdout.equals(finalIndex.stdout) ||
      !initialIndexFlags.equals(finalIndexFlags)) {
    throw new WorkerWorktreeError('WORKTREE_FINGERPRINT_CHANGED', 'Git status changed during cleanup fingerprint');
  }
  return hash.digest('hex');
}

async function ensureDirectoryTree(root: string, segments: readonly string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
    // Check after mkdir as well as on EEXIST. Another allocation may have
    // created the same parent concurrently, or substituted a symlink/file.
    const found = await fs.lstat(current);
    if (found.isSymbolicLink() || !found.isDirectory()) {
      throw new WorkerWorktreeError('WORKTREE_STORAGE_UNSAFE', `${current} is not an owned directory`);
    }
    const resolved = await fs.realpath(current);
    if (!isContained(root, resolved)) throw new WorkerWorktreeError('WORKTREE_STORAGE_ESCAPE', 'managed worktree storage escaped its approved root');
    const verified = await fs.lstat(current);
    if (verified.isSymbolicLink() || !verified.isDirectory()) {
      throw new WorkerWorktreeError('WORKTREE_STORAGE_UNSAFE', 'managed directory changed after mkdir');
    }
    current = resolved;
  }
  return current;
}

function repoKey(commonDir: string): string {
  return createHash('sha256').update(commonDir).digest('hex').slice(0, 16);
}

function managedRootFor(repo: RepoContext, roots: readonly ResolvedRoot[]): ResolvedRoot {
  const candidates = roots.filter(entry =>
    isContained(entry.real, repo.root) && isContained(entry.real, repo.commonDir) &&
    !isContained(repo.root, path.join(entry.real, MANAGED_FOLDER))
  ).sort((left, right) => right.real.length - left.real.length);
  const chosen = candidates[0];
  if (!chosen) {
    throw new WorkerWorktreeError(
      'WORKTREE_STORAGE_UNAVAILABLE',
      'automatic worktrees need an approved parent of the repository so managed worktrees do not dirty the source repository'
    );
  }
  return chosen;
}

function virtualPath(root: Root, rootReal: string, real: string): string {
  const relative = path.relative(rootReal, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkerWorktreeError('WORKTREE_VIRTUAL_PATH_INVALID', 'managed workspace is not below its approved virtual root');
  }
  return path.posix.join('/', root.name, ...relative.split(path.sep));
}

function markerOf(lease: WorkerWorktreeLease, ownerDir: string, markerPath: string, hooksPath: string): Marker {
  return { ...lease, ownerDir, markerPath, hooksPath };
}

function isMarker(value: unknown): value is Marker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<Marker>;
  return marker.version === 1 && typeof marker.runId === 'string' && RUN_ID.test(marker.runId) &&
    typeof marker.agentId === 'string' && AGENT_ID.test(marker.agentId) &&
    typeof marker.ownershipToken === 'string' && /^[0-9a-f-]{36}$/i.test(marker.ownershipToken) &&
    typeof marker.sourceRepoRoot === 'string' && typeof marker.commonDir === 'string' &&
    typeof marker.worktreePath === 'string' && typeof marker.workspace?.real === 'string' && typeof marker.workspace?.virtual === 'string' &&
    typeof marker.branch === 'string' && typeof marker.branchRef === 'string' && typeof marker.baseOid === 'string' && OID.test(marker.baseOid) &&
    typeof marker.treeIdentity === 'string' && /^\d+:\d+$/.test(marker.treeIdentity) &&
    typeof marker.workspaceIdentity === 'string' && /^\d+:\d+$/.test(marker.workspaceIdentity) &&
    typeof marker.approvedRoot?.name === 'string' && typeof marker.approvedRoot?.path === 'string' &&
    typeof marker.ownerDir === 'string' && typeof marker.markerPath === 'string' && typeof marker.hooksPath === 'string' &&
    typeof marker.createdAt === 'number';
}

async function readMarker(markerPath: string): Promise<Marker | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    if (!isMarker(parsed)) throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'managed worktree ownership marker is invalid');
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

function leaseFromMarker(marker: Marker, sourceDirty: boolean): WorkerWorktreeLease {
  const { ownerDir: _ownerDir, markerPath: _markerPath, hooksPath: _hooksPath, ...lease } = marker;
  return { ...lease, sourceDirty };
}

function markerMatchesLease(marker: Marker, lease: WorkerWorktreeLease): boolean {
  return marker.runId === lease.runId && marker.agentId === lease.agentId && marker.ownershipToken === lease.ownershipToken &&
    path.resolve(marker.sourceRepoRoot) === path.resolve(lease.sourceRepoRoot) && path.resolve(marker.commonDir) === path.resolve(lease.commonDir) &&
    path.resolve(marker.worktreePath) === path.resolve(lease.worktreePath) &&
    path.resolve(marker.workspace.real) === path.resolve(lease.workspace.real) && marker.workspace.virtual === lease.workspace.virtual &&
    marker.branch === lease.branch && marker.branchRef === lease.branchRef && marker.baseOid === lease.baseOid &&
    marker.treeIdentity === lease.treeIdentity && marker.workspaceIdentity === lease.workspaceIdentity &&
    marker.createdAt === lease.createdAt && marker.approvedRoot.name === lease.approvedRoot.name &&
    path.resolve(marker.approvedRoot.path) === path.resolve(lease.approvedRoot.path);
}

/** A marker is data until its complete deterministic slot is proven. Never unlink its claimed paths. */
function assertMarkerSlot(marker: Marker, markerPath: string): void {
  const ownerDir = path.dirname(markerPath);
  const expected = expectedBranch(marker.runId, marker.agentId);
  const repoDir = path.dirname(path.dirname(path.dirname(ownerDir)));
  if (path.resolve(marker.ownerDir) !== path.resolve(ownerDir) ||
      path.resolve(marker.markerPath) !== path.resolve(markerPath) ||
      path.resolve(marker.hooksPath) !== path.resolve(path.join(ownerDir, 'hooks')) ||
      path.resolve(marker.worktreePath) !== path.resolve(path.join(ownerDir, 'tree')) ||
      marker.branch !== expected.branch || marker.branchRef !== expected.branchRef ||
      path.basename(ownerDir) !== marker.agentId ||
      path.basename(path.dirname(ownerDir)) !== marker.runId ||
      path.basename(path.dirname(path.dirname(ownerDir))) !== repoKey(marker.commonDir) ||
      path.basename(repoDir) !== MANAGED_FOLDER ||
      !isContained(marker.worktreePath, marker.workspace.real)) {
    throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'ownership marker does not match its deterministic managed slot');
  }
}

async function markerForLease(lease: WorkerWorktreeLease): Promise<Marker> {
  const ownerDir = path.dirname(lease.worktreePath);
  const markerPath = path.join(ownerDir, 'owner.json');
  const marker = await readMarker(markerPath);
  if (!marker) throw new WorkerWorktreeError('WORKTREE_NOT_OWNED', 'worktree ownership could not be proven');
  assertMarkerSlot(marker, markerPath);
  if (!markerMatchesLease(marker, lease)) throw new WorkerWorktreeError('WORKTREE_NOT_OWNED', 'worktree ownership could not be proven');
  return marker;
}

async function assertOwnedWorktree(lease: WorkerWorktreeLease): Promise<Marker> {
  const marker = await markerForLease(lease);
  if (await directoryIdentity(marker.worktreePath) !== lease.treeIdentity ||
      await directoryIdentity(marker.workspace.real) !== lease.workspaceIdentity) {
    throw new WorkerWorktreeError('WORKTREE_PATH_CHANGED', 'owned Git worktree or project folder was replaced');
  }
  const worktreeReal = await realDirectory(marker.worktreePath);
  if (path.resolve(worktreeReal) !== path.resolve(marker.worktreePath)) throw new WorkerWorktreeError('WORKTREE_PATH_CHANGED', 'owned worktree path changed');
  const workspaceReal = await realDirectory(marker.workspace.real);
  if (path.resolve(workspaceReal) !== path.resolve(marker.workspace.real) ||
      !isContained(worktreeReal, workspaceReal)) {
    throw new WorkerWorktreeError('WORKTREE_PATH_CHANGED', 'owned worker project path moved outside its allocated directory');
  }
  const branch = await runGit(worktreeReal, ['symbolic-ref', '--quiet', 'HEAD'], 512);
  if (branch.code !== 0 || text(branch).trim() !== marker.branchRef) throw new WorkerWorktreeError('WORKTREE_BRANCH_CHANGED', 'owned worktree no longer has its allocated branch');
  const common = await runGit(worktreeReal, ['rev-parse', '--git-common-dir'], 4096);
  if (common.code !== 0) throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', common.stderr || 'owned worktree repository identity is unavailable');
  const commonReal = await fs.realpath(path.resolve(worktreeReal, text(common).trim()));
  if (path.resolve(commonReal) !== path.resolve(marker.commonDir)) throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', 'owned worktree repository identity changed');
  // Catch directory replacement while asynchronous Git checks were running.
  if (await directoryIdentity(marker.worktreePath) !== lease.treeIdentity ||
      await directoryIdentity(marker.workspace.real) !== lease.workspaceIdentity) {
    throw new WorkerWorktreeError('WORKTREE_PATH_CHANGED', 'owned Git worktree or project folder changed during validation');
  }
  return marker;
}

async function branchExists(cwd: string, branchRef: string): Promise<boolean> {
  const found = await runGit(cwd, ['show-ref', '--verify', '--quiet', branchRef], 128);
  if (found.code === 0) return true;
  if (found.code === 1) return false;
  throw new WorkerWorktreeError('WORKTREE_BRANCH_CHECK_FAILED', found.stderr || 'Git branch check failed');
}

async function allocate(input: {
  runId: string;
  agentId: string;
  primeWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  baseRef?: string;
}): Promise<AllocatedWorkerWorktree> {
  const identity = checkedIdentity(input.runId, input.agentId);
  const roots = await rootsOf(input.approvedRoots);
  const source = await repositoryContext(input.primeWorkspace.real, roots);
  const sourceStatus = await statusOf(source.cwd);
  const approved = managedRootFor(source, roots);
  const baseRef = safeRef(input.baseRef ?? 'HEAD');
  const base = await runGit(source.cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`], 256);
  const baseOid = text(base).trim();
  if (base.code !== 0 || !OID.test(baseOid)) throw new WorkerWorktreeError('WORKTREE_BASE_UNAVAILABLE', base.stderr || 'base revision is unavailable');
  const projectRelative = path.relative(source.root, source.cwd);
  if (projectRelative === '..' || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) {
    throw new WorkerWorktreeError('WORKTREE_PROJECT_ESCAPE', 'prime workspace is outside the repository root');
  }
  const compactRun = identity.runId.replaceAll('-', '');
  const branch = `cos/worktrees/${compactRun}/${identity.agentId}`;
  const branchRef = `refs/heads/${branch}`;
  const ownerDir = await ensureDirectoryTree(approved.real, [MANAGED_FOLDER, repoKey(source.commonDir), identity.runId, identity.agentId]);
  const hooksPath = await ensureDirectoryTree(ownerDir, ['hooks']);
  const worktreePath = path.join(ownerDir, 'tree');
  const markerPath = path.join(ownerDir, 'owner.json');
  const expectedWorkspaceReal = projectRelative ? path.join(worktreePath, projectRelative) : worktreePath;
  const expectedWorkspaceVirtual = virtualPath(approved.root, approved.real, expectedWorkspaceReal);
  const recoverSlot = async (marker: Marker): Promise<WorkerWorktreeLease> => {
    assertMarkerSlot(marker, markerPath);
    if (marker.runId !== identity.runId || marker.agentId !== identity.agentId ||
        path.resolve(marker.sourceRepoRoot) !== path.resolve(source.root) ||
        path.resolve(marker.commonDir) !== path.resolve(source.commonDir) ||
        marker.branchRef !== branchRef ||
        path.resolve(marker.worktreePath) !== path.resolve(worktreePath) ||
        path.resolve(marker.workspace.real) !== path.resolve(expectedWorkspaceReal) ||
        marker.workspace.virtual !== expectedWorkspaceVirtual ||
        marker.approvedRoot.name !== approved.root.name ||
        path.resolve(marker.approvedRoot.path) !== path.resolve(approved.root.path)) {
      throw new WorkerWorktreeError('WORKTREE_OWNER_CONFLICT', 'managed worktree marker does not match the broker allocation');
    }
    const workspaceReal = await realDirectory(marker.workspace.real);
    const treeReal = await realDirectory(worktreePath);
    if (!isContained(treeReal, workspaceReal)) {
      throw new WorkerWorktreeError('WORKTREE_PROJECT_ESCAPE', 'worker project resolved outside its isolated worktree');
    }
    const recovered = leaseFromMarker(marker, sourceStatus.dirty);
    await assertOwnedWorktree(recovered);
    return recovered;
  };
  const existing = await readMarker(markerPath);
  if (existing) {
    const recovered = await recoverSlot(existing);
    live.set(keyOf(identity.runId, identity.agentId), recovered);
    return { ...recovered, newlyCreated: false };
  }
  try {
    await fs.lstat(worktreePath);
    throw new WorkerWorktreeError('WORKTREE_PATH_OCCUPIED', 'managed worktree destination already exists without an ownership marker');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  if (await branchExists(source.cwd, branchRef)) {
    throw new WorkerWorktreeError('WORKTREE_BRANCH_OCCUPIED', 'managed worker branch already exists without an ownership marker');
  }
  if (projectRelative) {
    // The source's on-disk cwd may exist only in untracked/ignored content. A worktree
    // materializes the selected base commit, so that cwd would be missing after `add`.
    // Reject before creating a branch/worktree: computing workspaceIdentity afterwards
    // would otherwise throw ENOENT and strand both without an ownership marker.
    const treePath = projectRelative.split(path.sep).join('/');
    const entry = await runGit(source.cwd, ['cat-file', '-t', `${baseOid}:${treePath}`], 128);
    if (entry.code !== 0 || text(entry).trim() !== 'tree') {
      throw new WorkerWorktreeError(
        'WORKTREE_PROJECT_NOT_IN_BASE',
        'the selected nested workspace must be a tracked directory in the chosen base revision'
      );
    }
  }
  const add = await oneWorktreeChangeAtATime(source.commonDir,
    () => runGit(source.cwd, safeGitArgs(hooksPath, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseOid])));
  if (add.code !== 0) {
    const raced = await readMarker(markerPath);
    if (raced) {
      const recovered = await recoverSlot(raced);
      live.set(keyOf(identity.runId, identity.agentId), recovered);
      return { ...recovered, newlyCreated: false };
    }
    throw new WorkerWorktreeError('WORKTREE_ADD_FAILED', add.stderr || 'Git could not create the worker worktree');
  }
  const lease: WorkerWorktreeLease = {
    version: 1, ...identity, ownershipToken: randomUUID(), sourceRepoRoot: source.root, commonDir: source.commonDir,
    worktreePath, workspace: { real: expectedWorkspaceReal, virtual: expectedWorkspaceVirtual },
    branch, branchRef, baseOid,
    treeIdentity: await directoryIdentity(worktreePath), workspaceIdentity: await directoryIdentity(expectedWorkspaceReal),
    approvedRoot: { ...approved.root }, sourceDirty: sourceStatus.dirty, createdAt: Date.now()
  };
  const marker = markerOf(lease, ownerDir, markerPath, hooksPath);
  try {
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await assertOwnedWorktree(lease);
  } catch (error) {
    // The marker may have been claimed by a competing process after Git created
    // this tree. Never force-remove a slot bearing another owner's marker.
    const currentMarker = await readMarker(markerPath).catch(() => undefined);
    if (currentMarker === null || (currentMarker && markerMatchesLease(currentMarker, lease))) {
      const removed = await oneWorktreeChangeAtATime(source.commonDir,
        () => runGit(source.cwd, safeGitArgs(hooksPath, ['worktree', 'remove', '--force', worktreePath]))).catch(() => null);
      if (removed?.code === 0) {
        await runGit(source.cwd, ['update-ref', '-d', branchRef, baseOid], 256).catch(() => undefined);
        if (currentMarker) await fs.unlink(markerPath).catch(() => undefined);
      }
    }
    throw error;
  }
  live.set(keyOf(identity.runId, identity.agentId), lease);
  return { ...lease, newlyCreated: true };
}

/**
 * Allocates one deterministic, isolated Git worktree for a proven broker run/worker identity.
 * The source checkout is never reset, cleaned or otherwise changed; dirty source state is merely
 * reported on the lease. Storage must live under an approved parent outside the source repository.
 */
export function allocWorkerWorkspace(input: {
  runId: string;
  agentId: string;
  primeWorkspace: WorkerWorkspace;
  approvedRoots: readonly Root[];
  baseRef?: string;
}): Promise<AllocatedWorkerWorktree> {
  const identity = checkedIdentity(input.runId, input.agentId);
  const key = keyOf(identity.runId, identity.agentId);
  const existing = allocations.get(key);
  // A joined flight receives the owned lease, but it did not create it. The caller that
  // started the Git operation alone may retire it after its own failed spawn transaction.
  if (existing) return existing.then(lease => ({ ...lease, newlyCreated: false }));
  const flight = allocate({ ...input, ...identity }).finally(() => allocations.delete(key));
  allocations.set(key, flight);
  return flight;
}

/** Process-local fast lookup. allocWorkerWorkspace() is also restart-safe and recovers its marker. */
export function lookupWorkerWorkspace(input: { runId: string; agentId: string }): WorkerWorktreeLease | null {
  const identity = checkedIdentity(input.runId, input.agentId);
  const lease = live.get(keyOf(identity.runId, identity.agentId));
  return lease ? { ...lease, workspace: { ...lease.workspace }, approvedRoot: { ...lease.approvedRoot } } : null;
}

/**
 * Required at each privileged worker file/command boundary: the synchronous lookup is a
 * broker index, not evidence that its on-disk checkout still exists or belongs to that worker.
 * In particular, callers must not resolve a relative path from currentWorkspace() alone.
 */
export async function validateWorkerWorkspaceLease(
  lease: WorkerWorktreeLease,
  approvedRoots: readonly Root[]
): Promise<WorkerWorktreeLease> {
  const identity = checkedIdentity(lease.runId, lease.agentId);
  const key = keyOf(identity.runId, identity.agentId);
  const registered = live.get(key);
  if (!registered || !markerMatchesLease(markerOf(registered, path.dirname(registered.worktreePath),
      path.join(path.dirname(registered.worktreePath), 'owner.json'),
      path.join(path.dirname(registered.worktreePath), 'hooks')), lease)) {
    throw new WorkerWorktreeError('WORKTREE_NOT_OWNED', 'worker has no matching live broker allocation');
  }
  try {
    const roots = await rootsOf(approvedRoots);
    const owningRoot = roots.find(root => sameApprovedRoot(root, lease.approvedRoot));
    if (!owningRoot || !isContained(owningRoot.real, lease.worktreePath)) {
      throw new WorkerWorktreeError('WORKTREE_ROOT_CHANGED', 'worker worktree no longer belongs to a current approved root');
    }
    const source = await repositoryContext(lease.sourceRepoRoot, roots);
    if (path.resolve(source.root) !== path.resolve(lease.sourceRepoRoot) ||
        path.resolve(source.commonDir) !== path.resolve(lease.commonDir)) {
      throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', 'source repository identity changed');
    }
    const marker = await assertOwnedWorktree(lease);
    if (path.resolve(marker.ownerDir) !== path.resolve(path.dirname(lease.worktreePath)) ||
        path.resolve(marker.workspace.real) !== path.resolve(lease.workspace.real) ||
        marker.workspace.virtual !== virtualPath(owningRoot.root, owningRoot.real, lease.workspace.real)) {
      throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'worker workspace marker does not match its approved location');
    }
    return { ...registered, workspace: { ...registered.workspace }, approvedRoot: { ...registered.approvedRoot } };
  } catch (error) {
    // The broker must stop handing out the now-stale cwd even via synchronous projections.
    if (live.get(key)?.ownershipToken === registered.ownershipToken) live.delete(key);
    if (error instanceof WorkerWorktreeError) throw error;
    throw new WorkerWorktreeError('WORKTREE_OWNER_UNAVAILABLE', 'worker Git worktree ownership could not be verified');
  }
}

export interface RestoreManagedWorktreesResult {
  restored: WorkerWorktreeLease[];
  rejected: Array<{ markerPath: string; error: string }>;
}

function expectedBranch(runId: string, agentId: string): { branch: string; branchRef: string } {
  const branch = `cos/worktrees/${runId.replaceAll('-', '')}/${agentId}`;
  return { branch, branchRef: `refs/heads/${branch}` };
}

async function candidateMarkerPaths(
  rootReal: string,
  rejected: RestoreManagedWorktreesResult['rejected'],
  accepted: ReadonlyMap<string, ReadonlySet<string>>
): Promise<string[]> {
  const managed = path.join(rootReal, MANAGED_FOLDER);
  let managedStat: Awaited<ReturnType<typeof fs.lstat>>;
  try { managedStat = await fs.lstat(managed); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  if (managedStat.isSymbolicLink() || !managedStat.isDirectory()) {
    rejected.push({ markerPath: managed, error: 'WORKTREE_STORAGE_UNSAFE: managed worktree root is not a real directory' });
    return [];
  }
  const managedReal = await fs.realpath(managed);
  if (!isContained(rootReal, managedReal)) {
    rejected.push({ markerPath: managed, error: 'WORKTREE_STORAGE_ESCAPE: managed worktree root escaped its approved root' });
    return [];
  }
  const markers: string[] = [];
  for (const repoEntry of await fs.readdir(managedReal, { withFileTypes: true })) {
    if (!repoEntry.isDirectory() || repoEntry.isSymbolicLink() || !/^[0-9a-f]{16}$/.test(repoEntry.name)) continue;
    const repoDir = path.join(managedReal, repoEntry.name);
    for (const runEntry of await fs.readdir(repoDir, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || !RUN_ID.test(runEntry.name)) continue;
      const workers = accepted.get(runEntry.name.toLowerCase());
      if (!workers?.size) continue;
      const runDir = path.join(repoDir, runEntry.name);
      for (const agentEntry of await fs.readdir(runDir, { withFileTypes: true })) {
        if (!agentEntry.isDirectory() || agentEntry.isSymbolicLink() || !workers.has(agentEntry.name)) continue;
        markers.push(path.join(runDir, agentEntry.name, 'owner.json'));
      }
    }
  }
  return markers;
}

/**
 * A broker-approved cleanup offer can inspect an on-disk lease after Clear/restart.
 * Unlike startup recovery this must never add that lease to the live worker registry:
 * a completed/cleared worker must not regain execution authority.
 */
async function offeredWorkerLease(
  approvedRoots: readonly Root[],
  offer: WorkerCleanupOfferIdentity
): Promise<WorkerWorktreeLease> {
  const identity = checkedIdentity(offer.runId, offer.agentId);
  if (!Number.isSafeInteger(offer.createdAt) || offer.createdAt <= 0 ||
      typeof offer.reason !== 'string' || !offer.reason ||
      (offer.ownershipToken !== undefined && (!offer.ownershipToken || typeof offer.ownershipToken !== 'string'))) {
    throw new WorkerWorktreeError('WORKTREE_OFFER_INVALID', 'cleanup offer is missing a durable allocation identity');
  }
  const accepted = new Map([[identity.runId, new Set([identity.agentId])]]);
  const roots = await rootsOf(approvedRoots);
  const matches: WorkerWorktreeLease[] = [];
  for (const approved of roots) {
    const rejected: RestoreManagedWorktreesResult['rejected'] = [];
    const markerPaths = await candidateMarkerPaths(approved.real, rejected, accepted);
    if (rejected.length) throw new WorkerWorktreeError('WORKTREE_STORAGE_UNSAFE', 'cleanup storage ownership cannot be proven');
    for (const markerPath of markerPaths) {
      const marker = await readMarker(markerPath);
      if (!marker || marker.runId !== identity.runId || marker.agentId !== identity.agentId) {
        throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'cleanup slot marker does not match its broker offer');
      }
      assertMarkerSlot(marker, markerPath);
      // Offer.createdAt is the broker's cleanup-event time, not the checkout's
      // allocation time. A newer checkout cannot inherit an older cleanup offer.
      if (marker.createdAt > offer.createdAt ||
          (offer.ownershipToken !== undefined && marker.ownershipToken !== offer.ownershipToken)) {
        throw new WorkerWorktreeError('WORKTREE_NOT_OWNED', 'cleanup offer does not match the allocated worker generation');
      }
      if (!sameApprovedRoot(approved, marker.approvedRoot) ||
          ![marker.sourceRepoRoot, marker.commonDir, marker.worktreePath, marker.workspace.real]
            .every(value => isContained(approved.real, path.resolve(value)))) {
        throw new WorkerWorktreeError('WORKTREE_ROOT_CHANGED', 'cleanup offer no longer belongs to an approved root');
      }
      const source = await repositoryContext(marker.sourceRepoRoot, roots);
      if (path.resolve(source.root) !== path.resolve(marker.sourceRepoRoot) ||
          path.resolve(source.commonDir) !== path.resolve(marker.commonDir)) {
        throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', 'cleanup offer belongs to a different source repository');
      }
      const lease = leaseFromMarker(marker, false);
      if (marker.workspace.virtual !== virtualPath(approved.root, approved.real, marker.workspace.real)) {
        throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'cleanup offer has an invalid virtual workspace');
      }
      await assertOwnedWorktree(lease);
      matches.push(lease);
    }
  }
  if (matches.length !== 1) {
    throw new WorkerWorktreeError(matches.length ? 'WORKTREE_OWNER_AMBIGUOUS' : 'WORKTREE_NOT_OWNED',
      matches.length ? 'multiple worker worktrees match this cleanup offer' : 'cleanup offer has no verified owned worktree');
  }
  return matches[0]!;
}

/**
 * On-demand only. The caller supplies exact still-authorized broker cleanup offers.
 * Refused/removed/ambiguous candidates are omitted; no workspace is adopted.
 */
export async function listOfferedWorkerWorktrees(
  approvedRoots: readonly Root[],
  offers: readonly WorkerCleanupOfferIdentity[]
): Promise<WorkerCleanupOfferPreview[]> {
  const result: WorkerCleanupOfferPreview[] = [];
  const seen = new Set<string>();
  for (const offer of offers) {
    if (!RUN_ID.test(offer.runId) || !AGENT_ID.test(offer.agentId)) continue;
    const key = keyOf(offer.runId, offer.agentId);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const lease = await offeredWorkerLease(approvedRoots, offer);
      const inspected = await inspectWorkerWorkspaceForCleanup(lease);
      let contentFingerprint: string | null = null;
      if (!inspected.changesTruncated) {
        try {
          contentFingerprint = await cleanupContentFingerprint(lease.worktreePath);
          // The fingerprint must describe the same status that the UI reviewed.
          const verified = await statusOf(lease.worktreePath, true);
          if (verified.headOid !== inspected.headOid || verified.truncated ||
              JSON.stringify(verified.trackedChanges) !== JSON.stringify(inspected.trackedChanges) ||
              JSON.stringify(verified.untrackedFiles) !== JSON.stringify(inspected.untrackedFiles) ||
              JSON.stringify(verified.ignoredFiles) !== JSON.stringify(inspected.ignoredFiles)) {
            contentFingerprint = null;
          }
        } catch { /* A missing, unreadable, unsafe or over-limit file is never authorized for removal. */ }
      }
      result.push({
        runId: lease.runId, agentId: lease.agentId, createdAt: offer.createdAt,
        reason: offer.reason, workspace: lease.workspace.virtual, branch: inspected.branch, headOid: inspected.headOid,
        contentFingerprint,
        dirty: inspected.trackedChanges.length + inspected.untrackedFiles.length + inspected.ignoredFiles.length > 0 || inspected.changesTruncated,
        ignoredFiles: inspected.ignoredFiles.length > 0,
        uniqueCommits: inspected.hasWorkerCommits && !inspected.branchIntegratedIntoSource,
        changes: [...inspected.trackedChanges, ...inspected.untrackedFiles, ...inspected.ignoredFiles],
        blockers: inspected.blockers, canOfferRemoval: inspected.canOfferRemoval && contentFingerprint !== null,
        hasWorkerCommits: inspected.hasWorkerCommits,
        branchIntegratedIntoSource: inspected.branchIntegratedIntoSource,
        trackedChangesCount: inspected.trackedChanges.length,
        untrackedFilesCount: inspected.untrackedFiles.length,
        ignoredFilesCount: inspected.ignoredFiles.length,
        changesTruncated: inspected.changesTruncated
      });
    } catch { /* Fail closed: a broker offer is not proof that a disk checkout is safe. */ }
  }
  return result;
}

/**
 * Called only after a UI confirmation for an exact broker offer. This explicitly
 * discards local working files (including ignored files) but always preserves the
 * branch and its commits. The broker must revoke worker execution before calling.
 */
export async function disposeOfferedWorkerWorktree(
  approvedRoots: readonly Root[],
  offer: WorkerCleanupOfferIdentity,
  activeProcessCwds: readonly string[],
  expectedContentFingerprint?: string
): Promise<WorkerFinalizeResult> {
  // The caller is the confirmation-gated main-process IPC; no tool/worker path
  // may call this with a marker it discovered or synthesized on its own.
  const lease = await offeredWorkerLease(approvedRoots, offer);
  // A Clear action can retire a broker worker while an autonomous shell it previously
  // started still runs. Removing that shell's cwd would race an active writer. The main
  // process passes the live process-manager cwd projection immediately before disposal.
  // No permission to remove is inferred from an empty/incomplete broker history.
  if (activeProcessCwds.some(cwd => path.isAbsolute(cwd) && isContained(lease.worktreePath, path.resolve(cwd)))) {
    throw new WorkerWorktreeError('WORKTREE_ACTIVE_PROCESS', 'a running command still uses this checkout');
  }
  return finalizeWorkerWorkspace({
    lease, reason: 'cancelled', discardChanges: true, branch: { mode: 'keep' }, expectedContentFingerprint
  });
}

/**
 * Startup recovery for broker-restored workers. Only worker allocations accepted by the
 * restored durable broker may be discovered; an orphaned checkout's own marker grants no
 * recovery authority. Discovery is fixed-depth beneath approved managed directories.
 * A marker is adopted only after its deterministic path, branch, repository common-dir and live
 * Git worktree all prove the same run/worker owner. Ambiguous duplicate identities restore none.
 */
export async function restoreManagedWorktrees(
  approvedRoots: readonly Root[],
  acceptedAllocations: readonly { runId: string; agentId: string }[]
): Promise<RestoreManagedWorktreesResult> {
  const result: RestoreManagedWorktreesResult = { restored: [], rejected: [] };
  const accepted = new Map<string, Set<string>>();
  for (const allocation of acceptedAllocations) {
    // Never infer broker authority from malformed or partial identities.
    if (!RUN_ID.test(allocation.runId) || !AGENT_ID.test(allocation.agentId)) continue;
    const runId = allocation.runId.toLowerCase();
    const workers = accepted.get(runId) ?? new Set<string>();
    workers.add(allocation.agentId);
    accepted.set(runId, workers);
  }
  if (accepted.size === 0) return result;
  const roots = await rootsOf(approvedRoots);
  const candidates = new Map<string, Array<{ lease: WorkerWorktreeLease; markerPath: string }>>();
  for (const approved of roots) {
    const markerPaths = await candidateMarkerPaths(approved.real, result.rejected, accepted);
    for (const markerPath of markerPaths) {
      try {
        const marker = await readMarker(markerPath);
        if (!marker) continue;
        const identity = checkedIdentity(marker.runId, marker.agentId);
        assertMarkerSlot(marker, markerPath);
        if (!sameApprovedRoot(approved, marker.approvedRoot)) {
          throw new WorkerWorktreeError('WORKTREE_ROOT_CHANGED', 'the owning approved root has changed since allocation');
        }
        if (![marker.sourceRepoRoot, marker.commonDir, marker.worktreePath, marker.workspace.real]
          .every(value => isContained(approved.real, path.resolve(value)))) {
          throw new WorkerWorktreeError('WORKTREE_OUTSIDE_ROOT', 'restored worktree or repository metadata is outside current approved roots');
        }
        const source = await repositoryContext(marker.sourceRepoRoot, roots);
        if (path.resolve(source.root) !== path.resolve(marker.sourceRepoRoot) ||
            path.resolve(source.commonDir) !== path.resolve(marker.commonDir)) {
          throw new WorkerWorktreeError('WORKTREE_REPOSITORY_CHANGED', 'restored worker marker names the wrong source repository');
        }
        const workspaceReal = await realDirectory(marker.workspace.real);
        const worktreeReal = await realDirectory(marker.worktreePath);
        if (!isContained(worktreeReal, workspaceReal)) throw new WorkerWorktreeError('WORKTREE_PROJECT_ESCAPE', 'restored worker workspace escaped its owned worktree');
        if (marker.workspace.virtual !== virtualPath(approved.root, approved.real, workspaceReal)) {
          throw new WorkerWorktreeError('WORKTREE_OWNER_INVALID', 'restored worker virtual workspace does not match its approved root');
        }
        let sourceDirty = false;
        try { sourceDirty = (await statusOf(marker.sourceRepoRoot)).dirty; } catch { /* diagnostic only */ }
        const lease = leaseFromMarker(marker, sourceDirty);
        lease.approvedRoot = { ...approved.root };
        lease.workspace = { real: workspaceReal, virtual: virtualPath(approved.root, approved.real, workspaceReal) };
        await assertOwnedWorktree(lease);
        const key = keyOf(identity.runId, identity.agentId);
        candidates.set(key, [...(candidates.get(key) ?? []), { lease, markerPath }]);
      } catch (error) {
        result.rejected.push({ markerPath, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  for (const [key, rows] of candidates) {
    if (rows.length !== 1) {
      live.delete(key);
      for (const row of rows) result.rejected.push({ markerPath: row.markerPath, error: 'WORKTREE_OWNER_AMBIGUOUS: more than one managed worktree claims this worker identity' });
      continue;
    }
    const row = rows[0]!;
    const existing = live.get(key);
    if (existing && existing.ownershipToken !== row.lease.ownershipToken) {
      result.rejected.push({ markerPath: row.markerPath, error: 'WORKTREE_OWNER_CONFLICT: live registry already contains another lease for this worker identity' });
      continue;
    }
    live.set(key, row.lease);
    result.restored.push({ ...row.lease, workspace: { ...row.lease.workspace }, approvedRoot: { ...row.lease.approvedRoot } });
  }
  return result;
}

export async function inspectWorkerWorkspace(lease: WorkerWorktreeLease): Promise<WorkerWorktreeStatus> {
  await assertOwnedWorktree(lease);
  return statusOf(lease.worktreePath);
}

/**
 * Inspect an exact, marker-proven worker checkout for a cleanup offer. The broker must
 * retain its durable worker identity/lease until the user decides; do not discover
 * cleanup authority by scanning stray marker directories.
 */
export async function inspectWorkerWorkspaceForCleanup(lease: WorkerWorktreeLease): Promise<WorkerCleanupInspection> {
  const marker = await assertOwnedWorktree(lease);
  const [status, source, branch] = await Promise.all([
    statusOf(marker.worktreePath, true),
    runGit(marker.sourceRepoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], 256),
    runGit(marker.sourceRepoRoot, ['rev-parse', '--verify', `${marker.branchRef}^{commit}`], 256)
  ]);
  const sourceHeadOid = text(source).trim();
  if (source.code !== 0 || !OID.test(sourceHeadOid)) {
    throw new WorkerWorktreeError('WORKTREE_SOURCE_HEAD_INVALID', source.stderr || 'source HEAD is unavailable');
  }
  if (branch.code !== 0 || text(branch).trim() !== status.headOid) {
    throw new WorkerWorktreeError('WORKTREE_BRANCH_CHANGED', 'worker branch changed during cleanup inspection');
  }
  const hasWorkerCommits = status.headOid !== marker.baseOid;
  let branchIntegratedIntoSource = !hasWorkerCommits;
  if (hasWorkerCommits) {
    const ancestry = await runGit(marker.sourceRepoRoot, ['merge-base', '--is-ancestor', status.headOid, sourceHeadOid], 128);
    if (ancestry.code > 1 || ancestry.code < 0) {
      throw new WorkerWorktreeError('WORKTREE_ANCESTRY_FAILED', ancestry.stderr || 'worker branch integration could not be checked');
    }
    branchIntegratedIntoSource = ancestry.code === 0;
  }
  // Prove this is still the same checkout after the asynchronous Git inspections.
  await assertOwnedWorktree(lease);
  const blockers: WorkerCleanupBlocker[] = [];
  if (status.trackedChanges.length) blockers.push('tracked-changes');
  if (status.untrackedFiles.length) blockers.push('untracked-files');
  if (status.ignoredFiles.length) blockers.push('ignored-files');
  if (hasWorkerCommits && !branchIntegratedIntoSource) blockers.push('unintegrated-commits');
  if (status.truncated) blockers.push('status-truncated');
  return {
    worktreePath: marker.worktreePath, branch: marker.branch, branchRef: marker.branchRef,
    baseOid: marker.baseOid, headOid: status.headOid, sourceHeadOid,
    hasWorkerCommits, branchIntegratedIntoSource,
    trackedChanges: status.trackedChanges, untrackedFiles: status.untrackedFiles,
    ignoredFiles: status.ignoredFiles, changesTruncated: status.truncated,
    blockers, canOfferRemoval: blockers.length === 0
  };
}

async function patchOrTruncated(cwd: string, args: readonly string[]): Promise<{ patch: string | null; truncated: boolean }> {
  try {
    const result = await runGit(cwd, args, MAX_PATCH_BYTES);
    if (result.code !== 0) throw new WorkerWorktreeError('WORKTREE_DIFF_FAILED', result.stderr || 'Git diff failed');
    return { patch: text(result), truncated: false };
  } catch (error) {
    if (error instanceof WorkerWorktreeError && error.code === 'WORKTREE_GIT_OUTPUT') return { patch: null, truncated: true };
    throw error;
  }
}

export async function diffWorkerWorkspace(lease: WorkerWorktreeLease): Promise<WorkerWorktreeDiff> {
  await assertOwnedWorktree(lease);
  const status = await statusOf(lease.worktreePath);
  const committed = await patchOrTruncated(lease.worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--unified=3', lease.baseOid, status.headOid, '--', '.']);
  const working = await patchOrTruncated(lease.worktreePath, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--unified=3', '--', '.']);
  return {
    baseOid: lease.baseOid, headOid: status.headOid, status,
    committedPatch: committed.patch, committedPatchTruncated: committed.truncated,
    workingPatch: working.patch, workingPatchTruncated: working.truncated
  };
}

async function withLeaseMutation<T>(lease: WorkerWorktreeLease, operation: () => Promise<T>): Promise<T> {
  const key = keyOf(lease.runId, lease.agentId);
  if (busy.has(key)) throw new WorkerWorktreeError('WORKTREE_BUSY', 'another mutation already owns this worker worktree');
  busy.add(key);
  try { return await operation(); }
  finally { busy.delete(key); }
}


/**
 * Listing reads every worktree's admin folder as well, so it waits behind add and remove: beside a
 * removal that emptied `.git/worktrees` it failed with "Invalid path …/.git/worktrees", and two
 * workers of one repository finishing together could fail one cleanup (full suite, 2026-10-17).
 */
async function branchCheckedOut(cwd: string, commonDir: string, branchRef: string): Promise<boolean> {
  const listed = await oneWorktreeChangeAtATime(commonDir, () => runGit(cwd, ['worktree', 'list', '--porcelain'], 1024 * 1024));
  if (listed.code !== 0) throw new WorkerWorktreeError('WORKTREE_LIST_FAILED', listed.stderr || 'Git worktrees could not be listed');
  return text(listed).split('\n').some(line => line === `branch ${branchRef}`);
}

/** Check irreversible branch disposal before removing the worker's working directory. */
async function deletableBranchOid(marker: Marker, disposition: WorkerFinalizeBranch): Promise<string | null> {
  if (disposition.mode === 'keep' || !(await branchExists(marker.sourceRepoRoot, marker.branchRef))) return null;
  const head = await runGit(marker.sourceRepoRoot, ['rev-parse', '--verify', `${marker.branchRef}^{commit}`], 256);
  const branchHead = text(head).trim();
  if (head.code !== 0 || !OID.test(branchHead)) throw new WorkerWorktreeError('WORKTREE_BRANCH_INVALID', head.stderr || 'worker branch could not be inspected');
  if (disposition.mode === 'delete-if-integrated') {
    if (!OID.test(disposition.integratedIntoOid)) throw new WorkerWorktreeError('WORKTREE_INTEGRATED_REVISION_INVALID', 'integratedIntoOid is invalid');
    const merged = await runGit(marker.sourceRepoRoot, ['merge-base', '--is-ancestor', branchHead, disposition.integratedIntoOid], 128);
    if (merged.code !== 0) {
      if (merged.code === 1) throw new WorkerWorktreeError('WORKTREE_BRANCH_UNMERGED', 'worker branch is not contained by the supplied integrated revision');
      throw new WorkerWorktreeError('WORKTREE_ANCESTRY_FAILED', merged.stderr || 'worker branch ancestry could not be checked');
    }
  }
  return branchHead;
}

async function deleteOwnedBranch(marker: Marker, disposition: WorkerFinalizeBranch): Promise<boolean> {
  const branchHead = await deletableBranchOid(marker, disposition);
  if (!branchHead) return false;
  if (await branchCheckedOut(marker.sourceRepoRoot, marker.commonDir, marker.branchRef)) throw new WorkerWorktreeError('WORKTREE_BRANCH_IN_USE', 'worker branch is checked out by another worktree');
  const removed = await runGit(marker.sourceRepoRoot, ['update-ref', '-d', marker.branchRef, branchHead], 256);
  if (removed.code !== 0) throw new WorkerWorktreeError('WORKTREE_BRANCH_REMOVE_FAILED', removed.stderr || 'owned worker branch could not be removed');
  return true;
}

async function removeEmptyParents(marker: Marker): Promise<void> {
  for (const candidate of [marker.hooksPath, marker.ownerDir, path.dirname(marker.ownerDir), path.dirname(path.dirname(marker.ownerDir))]) {
    try { await fs.rmdir(candidate); }
    catch (error: unknown) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error; }
  }
}

/**
 * Retires only a marker-proven worker worktree with explicit authorization to discard its
 * files. Git worktree remove may delete ignored files even without --force, including files
 * created after a preflight status call: without discardChanges, preserve the entire tree.
 * Branch deletion separately requires integration ancestry or explicit owned-branch discard.
 */
export function finalizeWorkerWorkspace(input: {
  lease: WorkerWorktreeLease;
  reason: 'completed' | 'cancelled' | 'failed' | 'superseded';
  discardChanges?: boolean;
  branch?: WorkerFinalizeBranch;
  /** Captured before the native dialog; only used for confirmation-gated cleanup. */
  expectedContentFingerprint?: string;
}): Promise<WorkerFinalizeResult> {
  return withLeaseMutation(input.lease, async () => {
    const marker = await markerForLease(input.lease);
    const disposition = input.branch ?? { mode: 'keep' as const };
    if (disposition.mode === 'discard' && !['cancelled', 'failed', 'superseded'].includes(input.reason)) {
      throw new WorkerWorktreeError('WORKTREE_BRANCH_DISCARD_FORBIDDEN', 'completed work can be deleted only after proving it was integrated');
    }
    await deletableBranchOid(marker, disposition);
    let changes: string[] = [];
    let worktreeExists = true;
    try {
      const status = await statusOf(marker.worktreePath, true);
      changes = status.changes;
      // Even a clean status does not authorize deletion: ignored files could appear
      // before Git removes the worktree, and Git will delete them without --force.
      if (input.discardChanges !== true) return { removed: false, branchRemoved: false, branch: marker.branch, changes };
      if (input.expectedContentFingerprint !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(input.expectedContentFingerprint)) {
          throw new WorkerWorktreeError('WORKTREE_CONTENT_CHANGED', 'cleanup confirmation had no valid content fingerprint');
        }
        try {
          const currentFingerprint = await cleanupContentFingerprint(marker.worktreePath, status);
          if (currentFingerprint !== input.expectedContentFingerprint) {
            throw new WorkerWorktreeError('WORKTREE_CONTENT_CHANGED', 'checkout files changed since cleanup confirmation');
          }
        } catch {
          throw new WorkerWorktreeError('WORKTREE_CONTENT_CHANGED', 'checkout content changed or cannot be proven safe');
        }
      }
    } catch (error: unknown) {
      if (input.expectedContentFingerprint !== undefined) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error instanceof WorkerWorktreeError && error.code === 'WORKTREE_PATH_INVALID')) worktreeExists = false;
      else throw error;
    }
    if (worktreeExists) {
      await assertOwnedWorktree(input.lease);
      const args = ['worktree', 'remove', ...(input.discardChanges === true ? ['--force'] : []), marker.worktreePath];
      const removed = await oneWorktreeChangeAtATime(input.lease.commonDir, () => runGit(marker.sourceRepoRoot, safeGitArgs(marker.hooksPath, args)));
      if (removed.code !== 0) throw new WorkerWorktreeError('WORKTREE_REMOVE_FAILED', removed.stderr || 'owned worker worktree could not be removed');
    }
    const branchRemoved = await deleteOwnedBranch(marker, disposition);
    await fs.unlink(marker.markerPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    });
    await removeEmptyParents(marker);
    live.delete(keyOf(input.lease.runId, input.lease.agentId));
    return { removed: true, branchRemoved, branch: marker.branch, changes };
  });
}

/** Test seam only: does not touch disk or Git. */
export function resetWorkerWorktreeRegistryForTests(): void {
  live.clear();
  allocations.clear();
  busy.clear();
}
