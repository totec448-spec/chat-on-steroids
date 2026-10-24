import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logInfo, logWarn } from './logger.js';
import { decode, readProjectGitSnapshot, repositoryContext, runGit, type RepositoryContext } from './project-git.js';
import type { CommitState, GhStatus, ProjectGitChange } from '../shared/project-git.js';

export type { CommitState } from '../shared/project-git.js';

/**
 * Commit & PR from Review: commit the chosen changes with the person's message, push the branch,
 * and open a pull request with the GitHub CLI (`gh`), or GitHub's own page when gh is missing or
 * signed out. Every step is a separate call, so the dialog can stop after any of them. Git and gh
 * never wait for typed input here: a missing password or host key fails with a sentence instead of
 * hanging. Errors are fixed sentences the window translates; Git's or a hook's own words follow
 * after a line break, untranslated.
 */

const PUSH_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 60_000;
const MAX_MESSAGE = 10_000;
/** What a hook or Git printed, shown with the error; long output is cut, never the start. */
const MAX_SHOWN_OUTPUT = 2_000;

export type GhResult = { code: number; stdout: string; stderr: string };
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>;

function shown(output: string): string {
  const text = output.trim();
  return text.length > MAX_SHOWN_OUTPUT ? `${text.slice(0, MAX_SHOWN_OUTPUT)}…` : text;
}

/** `owner/repo` of a GitHub remote address, in any of the forms Git accepts. */
export function githubRepository(url: string): { owner: string; repo: string } | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/\s]+@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

// ---------------------------------------------------------------- gh

const executableName = process.platform === 'win32' ? 'gh.exe' : 'gh';

/**
 * Where gh is. An app started from the Dock or the Start menu does not get the PATH a terminal
 * has, so the places gh's own installers use are searched too. Only absolute directories count
 * (on Windows a bare name would be looked up in the project folder first).
 */
function ghExecutable(): string | null {
  const home = os.homedir();
  const separator = process.platform === 'win32' ? ';' : ':';
  const listed = (process.env['PATH'] ?? process.env['Path'] ?? '').split(separator).map(entry => entry.trim().replace(/^"|"$/g, ''));
  const usual = process.platform === 'win32'
    ? [path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'GitHub CLI'), path.join(process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'Programs', 'GitHub CLI')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin')];
  for (const directory of [...listed, ...usual]) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executableName);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* Not here. */ }
  }
  return null;
}

const runGh: GhRunner = (args, cwd) => new Promise((resolve, reject) => {
  const executable = ghExecutable();
  if (!executable) { reject(Object.assign(new Error('gh was not found'), { code: 'ENOENT' })); return; }
  const child = spawn(executable, args, {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }
  });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { child.kill(); reject(new Error('gh took too long to respond')); }, GH_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
});

let ghRunner: GhRunner = runGh;
export function setGhRunnerForTests(runner: GhRunner | null): void { ghRunner = runner ?? runGh; }

async function ghStatus(cwd: string): Promise<GhStatus> {
  try {
    return (await ghRunner(['auth', 'status', '--hostname', 'github.com'], cwd)).code === 0 ? 'ready' : 'signed-out';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'signed-out';
  }
}

// ---------------------------------------------------------------- state

async function context(projectId: string): Promise<RepositoryContext> {
  const found = await repositoryContext(projectId);
  if (!found) throw new Error('This folder is not a Git repository');
  return found;
}

async function text(context: RepositoryContext, args: string[]): Promise<string | null> {
  const result = await runGit(context.root, args);
  return result.code === 0 ? decode(result.stdout).trim() : null;
}

async function branchOf(context: RepositoryContext): Promise<string | null> {
  return text(context, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

async function remoteFacts(context: RepositoryContext): Promise<{ remote: string | null; upstream: string | null; url: string | null; defaultBranch: string | null }> {
  const upstream = await text(context, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const remotes = (await text(context, ['remote']))?.split('\n').map(name => name.trim()).filter(Boolean) ?? [];
  const fromUpstream = upstream ? remotes.find(name => upstream.startsWith(`${name}/`)) : undefined;
  const remote = fromUpstream ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null);
  if (!remote) return { remote: null, upstream, url: null, defaultBranch: null };
  const url = await text(context, ['remote', 'get-url', remote]);
  const head = await text(context, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  let defaultBranch = head?.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : null;
  if (!defaultBranch) {
    for (const candidate of ['main', 'master']) {
      if ((await runGit(context.root, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`])).code === 0) { defaultBranch = candidate; break; }
    }
  }
  return { remote, upstream, url, defaultBranch };
}

/** A file bigger than this is named by its size and time instead of its bytes. */
const HASHED_BYTES = 64 * 1024 * 1024;

/**
 * Review's revision names the list of changes and their line counts, so an edit that keeps the
 * counts would not change it. Commit must take exactly the content the person looked at, so its
 * token also covers every changed file's bytes.
 */
async function changesToken(repo: RepositoryContext, changes: readonly ProjectGitChange[]): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(changes));
  for (const change of changes) {
    const file = path.join(repo.projectReal, ...change.path.split('/'));
    hash.update(`\0${change.path}\0`);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > HASHED_BYTES) hash.update(`${stat.mode}:${stat.size}:${stat.mtimeMs}`);
      else hash.update(await fs.readFile(file));
    } catch { hash.update('absent'); }
  }
  return hash.digest('hex');
}

/** What the Commit dialog shows and offers. */
export async function readCommitState(projectId: string): Promise<CommitState> {
  const repo = await context(projectId);
  const snapshot = await readProjectGitSnapshot(projectId);
  if (snapshot.state !== 'ready') throw new Error(snapshot.message || 'This folder is not a Git repository');
  if (snapshot.truncated) throw new Error('There are too many changes to commit from here. Commit them in a terminal.');
  const branch = await branchOf(repo);
  const facts = await remoteFacts(repo);
  const github = facts.url ? githubRepository(facts.url) : null;
  return { branch, defaultBranch: facts.defaultBranch, remote: facts.remote, upstream: facts.upstream, github,
    gh: github ? await ghStatus(repo.root) : null, changes: snapshot.changes, token: await changesToken(repo, snapshot.changes) };
}

// ---------------------------------------------------------------- commit

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

export interface CommitRequest {
  message: string;
  /** Project-relative paths of changes shown in Review. */
  paths: string[];
  /** Create this branch from the current commit first and commit there. */
  newBranch?: string;
  /** `readCommitState`'s token from when the person chose; any other content is refused. */
  expectedToken: string;
}

/** Commits exactly the chosen changes, as their files are now, and nothing else that is staged. */
export async function commitProjectChanges(projectId: string, request: CommitRequest): Promise<{ commit: string; branch: string }> {
  const message = request.message.replace(/\r\n/g, '\n').trim();
  if (!message) throw new Error('Write a commit message.');
  if (message.length > MAX_MESSAGE) throw new Error('The commit message is too long.');
  const snapshot = await readProjectGitSnapshot(projectId);
  if (snapshot.state !== 'ready' || snapshot.truncated) throw new Error('The changes changed. Review them again before committing.');
  const repo = await context(projectId);
  if (await changesToken(repo, snapshot.changes) !== request.expectedToken) throw new Error('The changes changed. Review them again before committing.');
  const wanted = new Set(request.paths);
  const chosen = snapshot.changes.filter(change => wanted.has(change.path));
  if (!chosen.length) throw new Error('Choose at least one file to commit.');
  if (chosen.length !== wanted.size) throw new Error('The changes changed. Review them again before committing.');
  if (chosen.some(change => change.status === 'C')) throw new Error('Resolve the conflicts first, then commit.');
  // A merge, cherry-pick or revert in progress commits everything or nothing; a choice of files cannot.
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (await fs.access(path.join(repo.gitDir, marker)).then(() => true, () => false)) {
      throw new Error('A merge is in progress. Finish it in a terminal or your Git tool, then commit here.');
    }
  }
  const inRepository = (relative: string) => repo.prefix ? `${repo.prefix}/${relative}` : relative;
  // A rename is both of its paths: the old one goes, the new one comes.
  const paths = [...new Set(chosen.flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]))].map(inRepository);
  let branch = await branchOf(repo);
  const created = request.newBranch?.trim();
  const startedOn = branch;
  if (created) {
    if ((await runGit(repo.root, ['check-ref-format', '--branch', created])).code !== 0 || created.startsWith('-')) throw new Error('That branch name is not allowed.');
    if ((await runGit(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${created}`])).code === 0) throw new Error('A branch with that name already exists.');
    const switched = await runGit(repo.root, ['switch', '-c', created]);
    if (switched.code !== 0) throw new Error(`Git could not create the branch:\n${shown(switched.stderr)}`);
    branch = created;
  }
  if (!branch) throw new Error('This folder is not on a branch. Check out a branch first.');
  const pathspec = { input: `${paths.join('\0')}\0`, env: LITERAL };
  // What the person staged by hand among these paths stays staged if the commit does not happen.
  const staged = new Set(decode((await runGit(repo.root, ['diff', '--cached', '--name-only', '-z', '--no-renames'])).stdout).split('\0').filter(Boolean));
  const added = await runGit(repo.root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, pathspec);
  if (added.code !== 0) throw new Error(`Git did not commit:\n${shown(added.stderr)}`);
  const committed = await runGit(repo.root, ['commit', '--cleanup=whitespace', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'], undefined,
    { ...pathspec, timeoutMs: 120_000 });
  if (committed.code !== 0) {
    const unstage = paths.filter(file => !staged.has(file));
    if (unstage.length) await runGit(repo.root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], undefined, { input: `${unstage.join('\0')}\0`, env: LITERAL });
    if (created && startedOn) await runGit(repo.root, ['switch', '-q', startedOn]).then(() => runGit(repo.root, ['branch', '-D', created]));
    const output = `${committed.stderr}\n${decode(committed.stdout)}`;
    logWarn(`git commit: not committed (${/Please tell me who you are|Author identity unknown|unable to auto-detect email/i.test(output) ? 'no Git identity' : 'Git or a hook refused'})`);
    if (/Please tell me who you are|Author identity unknown|unable to auto-detect email/i.test(output)) {
      throw new Error('Git does not know your name and email yet. Set them once with git config --global user.name and user.email, then commit again.');
    }
    throw new Error(`Git did not commit:\n${shown(output)}`);
  }
  const commit = (await text(repo, ['rev-parse', '--short', 'HEAD'])) ?? '';
  logInfo(`git commit: committed ${chosen.length} change(s)${created ? ' on a new branch' : ''}`);
  return { commit, branch };
}

// ---------------------------------------------------------------- push

function pushError(stderr: string): Error {
  if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i.test(stderr) && /rejected/i.test(stderr)) {
    return new Error('The remote has commits this branch does not have. Pull them first, then push again.');
  }
  if (/Authentication failed|could not read Username|Permission denied|terminal prompts disabled|403/i.test(stderr)) {
    return new Error(`The remote refused the sign-in. Check that Git can push from a terminal, then try again.\n${shown(stderr)}`);
  }
  if (/Could not resolve host|unable to access|Connection (?:timed out|refused)|Network is unreachable/i.test(stderr)) {
    return new Error(`The remote could not be reached. Check the connection, then try again.\n${shown(stderr)}`);
  }
  return new Error(`Git could not push:\n${shown(stderr)}`);
}

/** Pushes the current branch; a branch without an upstream gets one on its remote. */
export async function pushProject(projectId: string): Promise<{ branch: string; remote: string; tracking: boolean }> {
  const repo = await context(projectId);
  const branch = await branchOf(repo);
  if (!branch) throw new Error('This folder is not on a branch. Check out a branch first.');
  const facts = await remoteFacts(repo);
  if (!facts.remote) throw new Error('This repository has no remote to push to.');
  // Nothing may wait for a password or a host key: without a terminal it would wait forever.
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS'] as const) if (process.env[key]) env[key] = process.env[key];
  const tracking = !facts.upstream;
  const args = tracking ? ['push', '--porcelain', '-u', facts.remote, `HEAD:refs/heads/${branch}`] : ['push', '--porcelain'];
  const pushed = await runGit(repo.root, args, undefined, { timeoutMs: PUSH_TIMEOUT_MS, env });
  if (pushed.code !== 0) {
    logWarn('git push: refused by the remote or not reachable');
    throw pushError(`${pushed.stderr}\n${decode(pushed.stdout)}`);
  }
  logInfo(`git push: pushed the branch${tracking ? ' and set its upstream' : ''}`);
  return { branch, remote: facts.remote, tracking };
}

// ---------------------------------------------------------------- pull request

const MAX_BROWSER_BODY = 4_000;

/**
 * Opens a pull request from the current branch into the remote's default branch. A fork (an
 * `upstream` remote on GitHub) gets its pull request on the upstream repository.
 */
export async function createPullRequest(projectId: string, request: { title: string; body: string }): Promise<{ url: string; via: 'gh' | 'existing' | 'browser' }> {
  const repo = await context(projectId);
  const branch = await branchOf(repo);
  if (!branch) throw new Error('This folder is not on a branch. Check out a branch first.');
  const facts = await remoteFacts(repo);
  const head = facts.url ? githubRepository(facts.url) : null;
  if (!head) throw new Error('This repository is not on GitHub. Open the pull request on its own site.');
  const upstreamUrl = facts.remote !== 'upstream' ? await text(repo, ['remote', 'get-url', 'upstream']) : null;
  const upstream = upstreamUrl ? githubRepository(upstreamUrl) : null;
  const base = upstream ?? head;
  const fork = base.owner.toLowerCase() !== head.owner.toLowerCase() || base.repo.toLowerCase() !== head.repo.toLowerCase();
  const into = facts.defaultBranch ?? 'main';
  if (!fork && into === branch) throw new Error('This branch is the default branch. Commit on a new branch to open a pull request.');
  const headRef = fork ? `${head.owner}:${branch}` : branch;
  const title = request.title.trim();
  if (!title) throw new Error('Write a commit message.');
  if (await ghStatus(repo.root) === 'ready') {
    const created = await ghRunner(['pr', 'create', '--repo', `${base.owner}/${base.repo}`, '--head', headRef, '--base', into, '--title', title, '--body', request.body], repo.root);
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(`${created.stdout}\n${created.stderr}`)?.[0];
    if (created.code === 0 && url) { logInfo('pull request: created with gh'); return { url, via: 'gh' }; }
    if (url && /already exists/i.test(created.stderr)) { logInfo('pull request: the branch already has one; opening it'); return { url, via: 'existing' }; }
    logWarn('pull request: gh refused');
    throw new Error(`gh could not create the pull request:\n${shown(created.stderr || created.stdout)}`);
  }
  const query = new URLSearchParams({ expand: '1', title, body: request.body.slice(0, MAX_BROWSER_BODY) });
  logInfo('pull request: gh is missing or signed out; opening GitHub\'s page instead');
  return { url: `https://github.com/${base.owner}/${base.repo}/compare/${into.split('/').map(encodeURIComponent).join('/')}...${encodeURIComponent(headRef).replace(/%2F/gi, '/').replace(/%3A/gi, ':')}?${query}`, via: 'browser' };
}
