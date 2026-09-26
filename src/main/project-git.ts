import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { watch as watchFs, type FSWatcher } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ProjectGitChange, ProjectGitChanged, ProjectGitDiff, ProjectGitSnapshot, ProjectGitStatus } from '../shared/project-git.js';
import { getConfig } from './config.js';
import { rawPromises as fs } from './rawfs.js';
import { projectFileTarget } from './project-files.js';
import { isContained } from './sandbox.js';

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CHANGES = 2_000;
const MAX_DIFF_SIDE_BYTES = 512 * 1024;
const UNTRACKED_STAT_BATCH = 16;
const GIT_TIMEOUT_MS = 15_000;
const CHANGE_DEBOUNCE_MS = 180;

interface GitResult { code: number; stdout: Buffer; stderr: string; }
interface RepositoryContext { projectId: string; projectReal: string; root: string; gitDir: string; commonDir: string; prefix: string; }

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readWorkingBytes(projectId: string, relative: string, limit: number): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  const target = await projectFileTarget(projectId, relative, { allowRoot: false });
  if (target.kind !== 'file') throw new Error('Choose a regular file');
  const before = await fs.lstat(target.real);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file');
  const handle = await fs.open(target.real, 'r');
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error('The project file changed while Git changes were read');
    const tooLarge = opened.size > limit;
    const bytes = Buffer.alloc(tooLarge ? Math.min(opened.size, 8 * 1024) : opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const checked = await projectFileTarget(projectId, relative, { allowRoot: false });
    const after = await fs.lstat(target.real);
    if (checked.kind !== 'file' || path.resolve(checked.real) !== path.resolve(target.real) ||
        !sameFile(opened, await handle.stat()) || !sameFile(opened, after)) {
      throw new Error('The project file changed while Git changes were read');
    }
    return { bytes, tooLarge };
  } finally { await handle.close(); }
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat',
    GIT_CONFIG_KEY_1: 'color.ui', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'diff.external', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'diff.trustExitCode', GIT_CONFIG_VALUE_3: 'false',
    GIT_CONFIG_KEY_4: 'core.fsmonitor', GIT_CONFIG_VALUE_4: 'false'
  };
}

async function runGit(cwd: string, args: string[], maxBytes = MAX_GIT_OUTPUT_BYTES): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...args], {
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
      finish(new Error('Git took too long to respond'));
    }, GIT_TIMEOUT_MS);
    child.once('error', error => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill(); finish(new Error('Git returned too much data')); return;
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

function decode(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function safeRelative(value: string): string | null {
  const normal = value.replaceAll('\\', '/');
  if (!normal || normal.length > 4096 || normal.startsWith('/') || /^[A-Za-z]:\//.test(normal)) return null;
  if (normal.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return normal;
}

function projectRelative(value: string, prefix: string): string | null {
  const safe = safeRelative(value);
  if (!safe) return null;
  if (!prefix) return safe;
  return safe.startsWith(`${prefix}/`) ? safe.slice(prefix.length + 1) : null;
}

async function repositoryContext(projectId: string): Promise<RepositoryContext | null> {
  const project = await projectFileTarget(projectId, '', { allowRoot: true });
  const result = await runGit(project.real, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) return null;
    throw new Error(result.stderr || 'Git repository could not be inspected');
  }
  const lines = decode(result.stdout).replaceAll('\r', '').trimEnd().split('\n');
  if (lines.length < 3) throw new Error('Git returned an incomplete repository identity');
  const root = path.resolve(lines[0]!);
  const gitDir = path.resolve(project.real, lines[1]!);
  const commonDir = path.resolve(project.real, lines[2]!);
  const approved = getConfig().roots.map(entry => path.resolve(entry.path));
  if (![root, gitDir, commonDir].every(candidate => approved.some(parent => isContained(parent, candidate)))) {
    throw new Error('The Git repository metadata is outside the approved folders');
  }
  const relative = path.relative(root, project.real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The selected project is outside its Git worktree');
  }
  return {
    projectId, projectReal: project.real, root, gitDir, commonDir,
    prefix: relative ? relative.split(path.sep).join('/') : ''
  };
}

function splitZero(buffer: Buffer): string[] {
  const decoded = decode(buffer);
  const parts = decoded.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function statusFromXY(xy: string): ProjectGitStatus {
  if (xy === '??') return 'U';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  return 'M';
}

function parseStatus(buffer: Buffer, prefix: string): ProjectGitChange[] {
  const parts = splitZero(buffer);
  const changes: ProjectGitChange[] = [];
  for (let index = 0; index < parts.length;) {
    const record = parts[index++]!;
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const pathValue = projectRelative(record.slice(3), prefix);
    if (!pathValue || xy === '!!') continue;
    const status = statusFromXY(xy);
    let previousPath: string | undefined;
    if (status === 'R') {
      const candidate = parts[index++];
      previousPath = candidate ? projectRelative(candidate, prefix) ?? undefined : undefined;
    }
    changes.push({ status, path: pathValue, previousPath, additions: null, deletions: null, binary: false });
    if (changes.length >= MAX_CHANGES) break;
  }
  return changes;
}

interface Numstat { additions: number | null; deletions: number | null; binary: boolean; }

function parseNumstat(buffer: Buffer, prefix: string): Map<string, Numstat> {
  const result = new Map<string, Numstat>();
  const parts = splitZero(buffer);
  for (let index = 0; index < parts.length;) {
    const first = parts[index++]!;
    const columns = first.split('\t');
    if (columns.length < 3) continue;
    const binary = columns[0] === '-' || columns[1] === '-';
    const value = { additions: binary ? null : Number(columns[0]), deletions: binary ? null : Number(columns[1]), binary };
    if (columns[2]) {
      const file = projectRelative(columns.slice(2).join('\t'), prefix);
      if (file) result.set(file, value);
      continue;
    }
    // With -z, rename records put the old and new names in the following NUL fields.
    index++; // old path
    const current = parts[index++];
    const file = current ? projectRelative(current, prefix) : null;
    if (file) result.set(file, value);
  }
  return result;
}

async function headExists(context: RepositoryContext): Promise<boolean> {
  const result = await runGit(context.projectReal, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return result.code === 0;
}

async function untrackedStats(context: RepositoryContext, relative: string): Promise<Numstat> {
  try {
    const { bytes, tooLarge } = await readWorkingBytes(context.projectId, relative, MAX_DIFF_SIDE_BYTES);
    const binary = bytes.includes(0);
    if (binary) return { additions: null, deletions: null, binary: true };
    if (tooLarge) return { additions: null, deletions: null, binary: false };
    const text = decode(bytes);
    const additions = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { additions, deletions: 0, binary: false };
  } catch {
    return { additions: null, deletions: null, binary: true };
  }
}

function unavailable(projectId: string, message: string): ProjectGitSnapshot {
  return { projectId, state: 'unavailable', changes: [], truncated: false, revision: '', message };
}

export async function readProjectGitSnapshot(projectId: string): Promise<ProjectGitSnapshot> {
  let context: RepositoryContext | null;
  try { context = await repositoryContext(projectId); }
  catch (error) { return unavailable(projectId, error instanceof Error ? error.message : String(error)); }
  if (!context) return { projectId, state: 'not-repository', changes: [], truncated: false, revision: '' };
  try {
    const hasHead = await headExists(context);
    const status = await runGit(context.projectReal, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--find-renames=50%', '--', '.']);
    if (status.code !== 0) throw new Error(status.stderr || 'Git status failed');
    const changes = parseStatus(status.stdout, context.prefix);
    const statsResult = await runGit(context.projectReal, [
      'diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames=50%', ...(hasHead ? ['HEAD'] : ['--cached']), '--', '.'
    ]);
    if (statsResult.code !== 0) throw new Error(statsResult.stderr || 'Git diff statistics failed');
    const stats = parseNumstat(statsResult.stdout, context.prefix);
    const needsWorkingStats: ProjectGitChange[] = [];
    for (const change of changes) {
      const measured = stats.get(change.path);
      if (change.status === 'U' || (change.status === 'A' && !measured)) needsWorkingStats.push(change);
      else if (measured) Object.assign(change, measured);
    }
    for (let index = 0; index < needsWorkingStats.length; index += UNTRACKED_STAT_BATCH) {
      await Promise.all(needsWorkingStats.slice(index, index + UNTRACKED_STAT_BATCH).map(async change => {
        Object.assign(change, await untrackedStats(context, change.path));
      }));
    }
    const truncated = changes.length >= MAX_CHANGES;
    const revision = createHash('sha256').update(JSON.stringify(changes)).digest('hex');
    return { projectId, state: 'ready', changes, truncated, revision };
  } catch (error) {
    return unavailable(projectId, error instanceof Error ? error.message : String(error));
  }
}

function repositoryPath(context: RepositoryContext, relative: string): string {
  return context.prefix ? `${context.prefix}/${relative}` : relative;
}

function textFromBytes(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try { return decode(bytes); } catch { return null; }
}

async function readHeadFile(context: RepositoryContext, relative: string): Promise<{ text: string | null; tooLarge: boolean }> {
  const object = `HEAD:${repositoryPath(context, relative)}`;
  const size = await runGit(context.projectReal, ['cat-file', '-s', object], 128);
  if (size.code !== 0) return { text: '', tooLarge: false };
  const bytes = Number(decode(size.stdout).trim());
  if (!Number.isFinite(bytes) || bytes > MAX_DIFF_SIDE_BYTES) return { text: null, tooLarge: true };
  const content = await runGit(context.projectReal, ['cat-file', 'blob', object], MAX_DIFF_SIDE_BYTES + 1);
  if (content.code !== 0) throw new Error(content.stderr || 'The Git base could not be read');
  return { text: textFromBytes(content.stdout), tooLarge: false };
}

async function readWorkingFile(projectId: string, relative: string): Promise<{ text: string | null; tooLarge: boolean }> {
  const result = await readWorkingBytes(projectId, relative, MAX_DIFF_SIDE_BYTES);
  return { text: result.tooLarge ? null : textFromBytes(result.bytes), tooLarge: result.tooLarge };
}

export async function readProjectGitDiff(projectId: string, relativePath: string): Promise<ProjectGitDiff> {
  const snapshot = await readProjectGitSnapshot(projectId);
  if (snapshot.state !== 'ready') throw new Error(snapshot.message || 'This folder is not a Git repository');
  const change = snapshot.changes.find(entry => entry.path === relativePath);
  if (!change) throw new Error('This file is no longer changed');
  const context = await repositoryContext(projectId);
  if (!context) throw new Error('This folder is not a Git repository');
  const base = change.status === 'A' || change.status === 'U'
    ? { text: '', tooLarge: false }
    : await readHeadFile(context, change.previousPath ?? change.path);
  const current = change.status === 'D'
    ? { text: '', tooLarge: false }
    : await readWorkingFile(projectId, change.path);
  const tooLarge = base.tooLarge || current.tooLarge;
  const binary = change.binary || (!tooLarge && (base.text === null || current.text === null));
  return {
    projectId, status: change.status, path: change.path, previousPath: change.previousPath,
    additions: change.additions, deletions: change.deletions, binary, tooLarge,
    baseText: binary || tooLarge ? null : base.text,
    currentText: binary || tooLarge ? null : current.text,
    note: tooLarge ? 'This diff is too large to display.' : binary ? 'Binary diff · preview unavailable' : undefined
  };
}

type WatchFactory = (nativePath: string, listener: () => void, recursive?: boolean) => FSWatcher;

async function collectGitDirectories(root: string, output: Set<string>, limit = 96): Promise<void> {
  if (output.size >= limit) return;
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    output.add(root);
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (output.size >= limit) return;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await collectGitDirectories(path.join(root, entry.name), output, limit);
    }
  } catch { /* Optional Git metadata directories may not exist yet. */ }
}

/** Watches Git metadata only as an invalidation signal. Git remains the sole source of truth. */
export class ProjectGitWatchSet {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private projectId: string | null = null;

  constructor(
    private readonly changed: (event: ProjectGitChanged) => void,
    private readonly watchFactory: WatchFactory = (nativePath, listener, recursive = false) =>
      watchFs(nativePath, { persistent: false, recursive }, listener)
  ) {}

  async sync(projectId: string | null): Promise<void> {
    if (projectId && this.projectId === projectId && this.watchers.length > 0) return;
    const generation = ++this.generation;
    this.closeWatchers();
    this.projectId = projectId;
    if (!projectId) return;
    let context: RepositoryContext | null;
    try { context = await repositoryContext(projectId); } catch { return; }
    if (!context || generation !== this.generation || this.projectId !== projectId) return;
    // One native recursive watch covers working-tree writes even when their folders are not
    // expanded in Files. It is active only while that project panel is open and is debounced
    // into a fresh Git read; it never infers a status from filesystem events.
    try {
      const watcher = this.watchFactory(context.projectReal, () => this.schedule(projectId), true);
      watcher.on('error', () => watcher.close());
      this.watchers.push(watcher);
    } catch { /* Refresh remains available on platforms without recursive native watching. */ }
    const candidates = new Set([context.gitDir, context.commonDir]);
    await collectGitDirectories(path.join(context.commonDir, 'refs'), candidates);
    await collectGitDirectories(path.join(context.commonDir, 'logs', 'refs'), candidates);
    for (const candidate of candidates) {
      try {
        if (!(await fs.stat(candidate)).isDirectory()) continue;
        const watcher = this.watchFactory(candidate, () => this.schedule(projectId));
        watcher.on('error', () => watcher.close());
        if (generation !== this.generation || this.projectId !== projectId) { watcher.close(); return; }
        this.watchers.push(watcher);
      } catch { /* Missing optional refs/log directories do not prevent reconciliation. */ }
    }
  }

  close(): void {
    this.generation++;
    this.projectId = null;
    this.closeWatchers();
  }

  private schedule(projectId: string): void {
    if (this.projectId !== projectId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.projectId === projectId) this.changed({ projectId });
    }, CHANGE_DEBOUNCE_MS);
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
