import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logInfo, logWarn } from './logger.js';
import { decode, readProjectGitSnapshot, repositoryContext, runGit, withTemporaryIndex, type RepositoryContext, type GitRunOptions } from './project-git.js';
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
  // A character can arrive split across two chunks; the stream decoder keeps it whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { if (stdout.length < 64 * 1024) stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
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

/** How many bytes of changed files the token may read; more is refused, never guessed from metadata. */
const CHANGES_BUDGET_BYTES = 256 * 1024 * 1024;
let changesBudget = CHANGES_BUDGET_BYTES;
export function setChangesBudgetForTests(bytes: number | null): void { changesBudget = bytes ?? CHANGES_BUDGET_BYTES; }

/**
 * Review's revision names the list of changes and their line counts, so an edit that keeps the
 * counts would not change it. Commit must take exactly the content the person looked at, so its
 * token also covers every changed file's bytes.
 */
async function changesToken(repo: RepositoryContext, changes: readonly ProjectGitChange[]): Promise<string> {
  const files = await Promise.all(changes.map(async change => {
    const file = path.join(repo.projectReal, ...change.path.split('/'));
    const stat = await fs.lstat(file).catch(() => null);
    return { change, file, stat };
  }));
  // Sizes first: a tree with huge untracked output must not be read gigabyte by gigabyte.
  const total = files.reduce((sum, { stat }) => sum + (stat?.isFile() ? stat.size : 0), 0);
  if (total > changesBudget) throw refusal('git commit', 'These changes are too large to commit from here. Commit them in a terminal.');
  const hash = createHash('sha256').update(JSON.stringify(changes));
  for (const { change, file, stat } of files) {
    hash.update(`\0${change.path}\0`);
    if (!stat) { hash.update('absent'); continue; }
    if (!stat.isFile()) { hash.update(`${stat.mode}:${stat.isSymbolicLink() ? await fs.readlink(file).catch(() => '') : ''}`); continue; }
    try {
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    } catch { hash.update('unreadable'); }
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

/** A refusal: one log line with the sentence (never a path or Git's words), and the error the window translates. */
function refusal(area: 'git commit' | 'git push' | 'pull request', sentence: string): Error {
  logWarn(`${area}: refused (${sentence})`);
  return new Error(sentence);
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

/** Null means Git could not prove the position, not an unborn branch or detached HEAD. */
async function commitPosition(repo: RepositoryContext): Promise<{ ref: string | null; commit: string | null } | null> {
  const symbolic = await runGit(repo.root, ['symbolic-ref', '--quiet', 'HEAD']);
  if (symbolic.code !== 0 && symbolic.code !== 1) return null;
  const ref = symbolic.code === 0 ? decode(symbolic.stdout).trim() : null;
  if (ref === '') return null;
  const head = await runGit(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code === 0) return { ref, commit: decode(head.stdout).trim() };
  // rev-parse --quiet returns 1 for an unborn branch. A detached HEAD must have a commit.
  return head.code === 1 && ref !== null ? { ref, commit: null } : null;
}

/** Commits exactly the chosen changes, as their files are now, and nothing else that is staged. */
export async function commitProjectChanges(projectId: string, request: CommitRequest): Promise<{ commit: string; branch: string }> {
  const message = request.message.replace(/\r\n/g, '\n').trim();
  if (!message) throw refusal('git commit', 'Write a commit message.');
  if (message.length > MAX_MESSAGE) throw refusal('git commit', 'The commit message is too long.');
  const snapshot = await readProjectGitSnapshot(projectId);
  if (snapshot.state !== 'ready' || snapshot.truncated) throw refusal('git commit', 'The changes changed. Review them again before committing.');
  const repo = await context(projectId);
  if (await changesToken(repo, snapshot.changes) !== request.expectedToken) throw refusal('git commit', 'The changes changed. Review them again before committing.');
  const wanted = new Set(request.paths);
  const chosen = snapshot.changes.filter(change => wanted.has(change.path));
  if (!chosen.length) throw refusal('git commit', 'Choose at least one file to commit.');
  if (chosen.length !== wanted.size) throw refusal('git commit', 'The changes changed. Review them again before committing.');
  if (chosen.some(change => change.status === 'C')) throw refusal('git commit', 'Resolve the conflicts first, then commit.');
  // A merge, cherry-pick or revert in progress commits everything or nothing; a choice of files cannot.
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (await fs.access(path.join(repo.gitDir, marker)).then(() => true, () => false)) {
      throw refusal('git commit', 'A merge is in progress. Finish it in a terminal or your Git tool, then commit here.');
    }
  }
  const inRepository = (relative: string) => repo.prefix ? `${repo.prefix}/${relative}` : relative;
  // A rename is both of its paths: the old one goes, the new one comes. Only the new one is still
  // there to stage; staging the old one fails ("did not match any files").
  const paths = [...new Set(chosen.flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]))].map(inRepository);
  const toStage = [...new Set(chosen.map(change => change.path))].map(inRepository);
  const position = await commitPosition(repo);
  if (!position) throw refusal('git commit', 'The changes changed. Review them again before committing.');
  let branch = position.ref?.startsWith('refs/heads/') ? position.ref.slice('refs/heads/'.length) : null;
  const created = request.newBranch?.trim();
  const startedOn = branch;
  if (created) {
    if ((await runGit(repo.root, ['check-ref-format', '--branch', created])).code !== 0 || created.startsWith('-')) throw refusal('git commit', 'That branch name is not allowed.');
    if ((await runGit(repo.root, ['show-ref', '--verify', '--quiet', `refs/heads/${created}`])).code === 0) throw refusal('git commit', 'A branch with that name already exists.');
  } else if (!branch) throw refusal('git commit', 'This folder is not on a branch. Check out a branch first.');
  // Starting branch/commit for native checkout after a definitely unaccepted attempt.
  const startCommit = position.commit;
  let switched = false;
  // Keep the user's index untouched until our commit is accepted. A plain external
  // commit may already have released its index lock before running its hooks;
  // restoring a saved tree after failure can therefore undo its staging.
  const indexPath = path.join(repo.gitDir, 'index'), indexFile = `${indexPath}.lock`;
  const action = `commit (CoS ${randomUUID()})`;
  let leased = false, stopped = true, attempted = false, succeeded = false;
  let failure: unknown;
  let reportedCommit: string | null = null;
  const execute = async (args: string[], options: GitRunOptions = {}) => {
    stopped = false;
    try {
      const result = await runGit(repo.root, args, undefined, options);
      stopped = result.code >= 0;
      return result;
    } catch (error) {
      stopped = (error as { gitStopped?: boolean }).gitStopped === true;
      throw error;
    }
  };
  const putBack = async (): Promise<void> => {
    if (!created || !switched) return;
    try {
      const back = startedOn ? await runGit(repo.root, ['switch', '--no-guess', startedOn])
        : startCommit ? await runGit(repo.root, ['switch', '--detach', startCommit]) : null;
      if (back?.code !== 0) { logWarn('git commit: kept the new branch because Git refused rollback checkout'); return; }
      // Native deletion keeps symbolic-ref/worktree guards. Compare with restored
      // HEAD, not an inherited upstream, and remove tracking config on success.
      const removed = await runGit(repo.root, ['-c', `branch.${created}.remote=.`, '-c', `branch.${created}.merge=`, 'branch', '-d', created]);
      if (removed.code !== 0) logWarn('git commit: kept the new branch because Git refused safe branch cleanup');
    } catch { logWarn('git commit: kept the new branch because rollback checkout did not finish'); }
  };
  try {
    if (created) {
      let made: Awaited<ReturnType<typeof runGit>>;
      try { made = await execute(['switch', '-c', created]); }
      catch (error) {
        // An error never proves ownership, even when the requested name is now selected.
        logWarn('git commit: kept any matching branch because branch creation was not confirmed');
        throw error;
      }
      if (made.code !== 0) {
        // A matching name may belong to another writer/worktree. Failure is not
        // proof this attempt created it, so do not clean it up.
        logWarn('git commit: kept any matching branch because branch creation was not confirmed');
        logWarn('git commit: not committed (Git could not create the branch)');
        throw new Error(`Git could not create the branch:\n${shown(made.stderr)}`);
      }
      switched = true;
      branch = created;
    }
    let lock: import('node:fs/promises').FileHandle;
    try { lock = await fs.open(indexFile, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw refusal('git commit', 'Another Git operation is in progress. Try again when it finishes.');
      throw error;
    }
    leased = true;
    try {
      const original = await fs.stat(indexPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (original) {
        await lock.writeFile(createReadStream(indexPath));
        await lock.chmod(original.mode & 0o777);
        // A fresh copy's timestamp would hide same-tick edits from Git's racy
        // stat cache. Keep it conservatively older than the source index.
        await lock.utimes(original.atime, new Date(Math.max(1000, original.mtimeMs - 1000)));
      } else {
        await withTemporaryIndex(async empty => {
          const initialized = await execute(['read-tree', '--empty'], { indexFile: empty });
          if (initialized.code !== 0) throw new Error(`Git did not commit:\n${shown(initialized.stderr)}`);
          await lock.writeFile(createReadStream(empty));
        });
      }
      await lock.sync();
    } finally { await lock.close(); }
    const admitted = await commitPosition(repo);
    const intendedRef = created && switched ? `refs/heads/${created}` : position.ref;
    if (!admitted || admitted.ref !== intendedRef || admitted.commit !== startCommit) {
      throw refusal('git commit', 'The changes changed. Review them again before committing.');
    }
    // Git writes its private index via index.lock.lock; index.lock continuously
    // excludes new real-index writers, including hooks in other Git processes.
    const added = await execute(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { input: `${toStage.join('\0')}\0`, env: LITERAL, indexFile });
    if (added.code !== 0) {
      logWarn('git commit: not committed (Git could not stage the chosen files)');
      throw new Error(`Git did not commit:\n${shown(added.stderr)}`);
    }
    attempted = true;
    const committed = await execute(['commit', '--cleanup=whitespace', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'],
      { input: `${paths.join('\0')}\0`, env: { ...LITERAL, GIT_REFLOG_ACTION: action }, indexFile, timeoutMs: 120_000 });
    if (committed.code !== 0) {
      const output = `${committed.stderr}\n${decode(committed.stdout)}`;
      const noIdentity = /Please tell me who you are|Author identity unknown|unable to auto-detect email/i.test(output);
      logWarn(`git commit: command failed (${noIdentity ? 'no Git identity' : 'checking whether Git accepted the commit'})`);
      if (noIdentity) throw new Error('Git does not know your name and email yet. Set them once with git config --global user.name and user.email, then commit again.');
      throw new Error(`Git did not commit:\n${shown(output)}`);
    }
    succeeded = true;
    // Git's final summary follows its foreground hooks. Resolve the reported
    // object, never a later moving HEAD; no English words or reflogs are required.
    const summary = [...decode(committed.stdout).matchAll(/^\[[^\r\n]* ([0-9a-f]{4,64})\](?: |$)/gm)].at(-1);
    reportedCommit = summary ? await text(repo, ['rev-parse', '--verify', `${summary[1]}^{commit}`]) : null;
  } catch (error) { failure = error; }
  const current = await commitPosition(repo).catch(() => null);
  const expectedRef = created && switched ? `refs/heads/${created}` : position.ref;
  const sameStart = current?.ref === expectedRef && current.commit === position.commit;
  // Native reflogs identify OUR accepted HEAD update after an error. Never force
  // reflogs on: disabled/unreadable receipts leave both indexes for recovery.
  const receipt = attempted && stopped ? await text(repo, ['reflog', 'show', '-1', '--format=%H%x00%gs', 'HEAD']).catch(() => null) : null;
  const [oid, subject] = receipt?.split('\0') ?? [];
  const ownCommit = reportedCommit ?? (subject?.startsWith(`${action}:`) ? oid : null);
  const accepted = stopped && current?.ref === expectedRef && current.commit === ownCommit ? ownCommit : null;
  if (leased && accepted) {
    try {
      // A timeout in a post-commit hook can precede Git's private-index write.
      // Reconcile only our paths to the exact receipt; keep unrelated staging.
      const reset = await execute(['reset', '-q', accepted, '--pathspec-from-file=-', '--pathspec-file-nul'],
        { input: `${paths.join('\0')}\0`, env: LITERAL, indexFile });
      if (reset.code !== 0) throw new Error(`Git did not commit:\n${shown(reset.stderr)}`);
      const ready = await fs.open(indexFile, 'r+');
      try { await ready.sync(); } finally { await ready.close(); }
      await fs.rename(indexFile, indexPath);
      leased = false;
      if (process.platform !== 'win32') {
        const directory = await fs.open(repo.gitDir, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) { failure = error; }
    if (!leased && failure) {
      logWarn('git commit: kept the accepted commit and published its private index after a late failure');
      const late = new Error('Git committed, but a later step failed. Check the commit before trying again.');
      late.message += `\n${shown(failure instanceof Error ? failure.message : String(failure))}`;
      failure = late;
    }
  } else if (!succeeded && stopped && sameStart) {
    // No write-back on refusal. An already-prepared external as-is commit can
    // still advance later, using the unchanged real index it originally read.
    if (leased) {
      try {
        await fs.rm(`${indexFile}.lock`, { force: true });
        await fs.unlink(indexFile);
        leased = false;
      } catch { logWarn('git commit: kept its private index because cleanup was refused'); }
    }
    if (!leased) await putBack();
  }
  if (leased) {
    logWarn('git commit: kept the original index and private index.lock because completion needs recovery');
    const recovery = new Error('Git state needs recovery. Check this branch before retrying; index.lock was kept.');
    if (failure) recovery.message += `\n${shown(failure instanceof Error ? failure.message : String(failure))}`;
    throw recovery;
  }
  if (failure) throw failure;
  const commit = accepted ? (await text(repo, ['rev-parse', '--short', accepted])) ?? accepted : '';
  logInfo(`git commit: committed ${chosen.length} change(s)${created ? ' on a new branch' : ''}`);
  // Committed on the new branch, or on the branch it was on (a detached HEAD without one was refused).
  return { commit, branch: created ?? branch ?? '' };
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
  if (!branch) throw refusal('git push', 'This folder is not on a branch. Check out a branch first.');
  const facts = await remoteFacts(repo);
  if (!facts.remote) throw refusal('git push', 'This repository has no remote to push to.');
  // Nothing may wait for a password or a host key: without a terminal it would wait forever.
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS'] as const) if (process.env[key]) env[key] = process.env[key];
  // GIT_TERMINAL_PROMPT stops Git's own prompts, not ssh's: a host key or a key passphrase would be
  // asked on the terminal the app was started from. The person's own ssh command is left as set.
  if (!env['GIT_SSH'] && !env['GIT_SSH_COMMAND'] && !(await text(repo, ['config', '--get', 'core.sshCommand']))) env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes';
  // Always to the branch's own name on the remote. A plain `git push` would follow push.default and the
  // upstream: a branch made from origin/main tracks main, and is then refused or pushed into main.
  // The upstream is set only when there is none.
  const tracking = !facts.upstream;
  const args = ['push', '--porcelain', ...(tracking ? ['-u'] : []), facts.remote, `HEAD:refs/heads/${branch}`];
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
  if (!branch) throw refusal('pull request', 'This folder is not on a branch. Check out a branch first.');
  const facts = await remoteFacts(repo);
  const head = facts.url ? githubRepository(facts.url) : null;
  if (!head) throw refusal('pull request', 'This repository is not on GitHub. Open the pull request on its own site.');
  const upstreamUrl = facts.remote !== 'upstream' ? await text(repo, ['remote', 'get-url', 'upstream']) : null;
  const upstream = upstreamUrl ? githubRepository(upstreamUrl) : null;
  const base = upstream ?? head;
  const fork = base.owner.toLowerCase() !== head.owner.toLowerCase() || base.repo.toLowerCase() !== head.repo.toLowerCase();
  // Not known here (no remote HEAD, no main or master): GitHub uses the repository's default.
  const into = facts.defaultBranch;
  if (!fork && into === branch) throw refusal('pull request', 'This branch is the default branch. Commit on a new branch to open a pull request.');
  const headRef = fork ? `${head.owner}:${branch}` : branch;
  const title = request.title.trim();
  if (!title) throw refusal('pull request', 'Write a commit message.');
  if (await ghStatus(repo.root) === 'ready') {
    const created = await ghRunner(['pr', 'create', '--repo', `${base.owner}/${base.repo}`, '--head', headRef, ...(into ? ['--base', into] : []), '--title', title, '--body', request.body], repo.root);
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(`${created.stdout}\n${created.stderr}`)?.[0];
    if (created.code === 0 && url) { logInfo('pull request: created with gh'); return { url, via: 'gh' }; }
    if (url && /already exists/i.test(created.stderr)) { logInfo('pull request: the branch already has one; opening it'); return { url, via: 'existing' }; }
    logWarn('pull request: gh refused');
    throw new Error(`gh could not create the pull request:\n${shown(created.stderr || created.stdout)}`);
  }
  const query = new URLSearchParams({ expand: '1', title, body: request.body.slice(0, MAX_BROWSER_BODY) });
  logInfo('pull request: gh is missing or signed out; opening GitHub\'s page instead');
  return { url: `https://github.com/${base.owner}/${base.repo}/compare/${into ? `${into.split('/').map(encodeURIComponent).join('/')}...` : ''}${encodeURIComponent(headRef).replace(/%2F/gi, '/').replace(/%3A/gi, ':')}?${query}`, via: 'browser' };
}
