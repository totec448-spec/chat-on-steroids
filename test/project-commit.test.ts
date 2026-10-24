import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  commitProjectChanges, createPullRequest, githubRepository, pushProject, readCommitState, setGhRunnerForTests, type GhRunner
} from '../src/main/project-commit.js';
import { addProject } from '../src/main/projects.js';
import { validateNewRoot } from '../src/main/sandbox.js';

const exec = promisify(execFile);
let directory: string;
let approved: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-project-commit-'));
  approved = path.join(directory, 'approved');
  await fs.mkdir(approved, { recursive: true });
  approved = await validateNewRoot(approved, []);
  initConfigPath(directory);
  initDurableStore(directory);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'work', path: approved }] });
  setGhRunnerForTests(null);
});

afterEach(async () => {
  setGhRunnerForTests(null);
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

/** A project with one commit on main, pushed to a bare "origin" whose HEAD is main. */
async function project(options: { identity?: boolean; origin?: boolean } = {}): Promise<{ root: string; id: string; origin: string }> {
  const root = path.join(approved, 'project');
  const origin = path.join(directory, 'origin.git');
  await fs.mkdir(root, { recursive: true });
  await git(root, 'init', '-b', 'main');
  if (options.identity !== false) {
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'CoS Test');
  }
  await fs.writeFile(path.join(root, 'kept.ts'), 'export const kept = 1;\n');
  await fs.writeFile(path.join(root, 'gone.txt'), 'delete me\n');
  await fs.writeFile(path.join(root, 'other.ts'), 'export const other = 1;\n');
  await git(root, 'add', '.');
  await git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'baseline');
  if (options.origin !== false) {
    await git(directory, 'init', '--bare', '-b', 'main', origin);
    await git(root, 'remote', 'add', 'origin', origin);
    await git(root, 'push', '-u', 'origin', 'main');
    await git(root, 'remote', 'set-head', 'origin', 'main');
  }
  const added = await addProject(root);
  return { root, id: added.id, origin };
}

async function change(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'kept.ts'), 'export const kept = 2;\n');
  await fs.writeFile(path.join(root, 'new file.ts'), 'export const added = 1;\n');
  await fs.rm(path.join(root, 'gone.txt'));
  await fs.writeFile(path.join(root, 'other.ts'), 'export const other = 2;\n');
}

const revision = async (id: string) => (await readCommitState(id)).token;

describe('commit', () => {
  it('commits exactly the chosen changes with the message as written, and leaves the others', async () => {
    const { root, id } = await project();
    await change(root);
    const result = await commitProjectChanges(id, {
      message: 'Raise kept to 2\n\nAlso adds a file and removes another.', paths: ['kept.ts', 'new file.ts', 'gone.txt'],
      expectedToken: await revision(id)
    });
    expect(result.branch).toBe('main');
    expect(result.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(await git(root, 'log', '-1', '--format=%B')).toBe('Raise kept to 2\n\nAlso adds a file and removes another.');
    expect((await git(root, 'show', '--name-status', '--format=', 'HEAD')).split('\n').sort())
      .toEqual(['A\tnew file.ts', 'D\tgone.txt', 'M\tkept.ts']);
    expect(await git(root, 'status', '--porcelain')).toBe('M other.ts');
  });

  it('leaves what the person staged by hand for other files alone', async () => {
    const { root, id } = await project();
    await change(root);
    await git(root, 'add', 'other.ts');
    await commitProjectChanges(id, { message: 'Only kept', paths: ['kept.ts'], expectedToken: await revision(id) });
    expect(await git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('kept.ts');
    expect(await git(root, 'diff', '--cached', '--name-only')).toBe('other.ts');
  });

  it('refuses when the changes moved on since they were shown', async () => {
    const { root, id } = await project();
    await change(root);
    const seen = await revision(id);
    await fs.writeFile(path.join(root, 'kept.ts'), 'export const kept = 3;\n');
    await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], expectedToken: seen }))
      .rejects.toThrow('The changes changed. Review them again before committing.');
    expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it.each([
    [{ message: '  ', paths: ['kept.ts'] }, 'Write a commit message.'],
    [{ message: 'x', paths: [] }, 'Choose at least one file to commit.'],
    [{ message: 'x', paths: ['not-changed.ts'] }, 'Choose at least one file to commit.']
  ])('refuses a commit that has nothing to say or nothing to commit: %o', async (request, error) => {
    const { root, id } = await project();
    await change(root);
    await expect(commitProjectChanges(id, { ...request, expectedToken: await revision(id) })).rejects.toThrow(error);
  });

  it('says plainly when Git does not know who is committing', async () => {
    const home = path.join(directory, 'home');
    await fs.mkdir(home);
    const { root, id } = await project({ identity: false });
    await change(root);
    const previous = { HOME: process.env['HOME'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'], USERPROFILE: process.env['USERPROFILE'] };
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, USERPROFILE: home });
    try {
      await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], expectedToken: await revision(id) }))
        .rejects.toThrow('Git does not know your name and email yet.');
    } finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  it.skipIf(process.platform === 'win32')('shows what a pre-commit hook printed when it stops the commit', async () => {
    const { root, id } = await project();
    await change(root);
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\necho "lint: kept.ts has 1 problem" >&2\nexit 1\n', { mode: 0o755 });
    await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], expectedToken: await revision(id) }))
      .rejects.toThrow(/lint: kept\.ts has 1 problem/);
    expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('commits on a new branch when asked, and refuses a bad or taken name', async () => {
    const { root, id } = await project();
    await change(root);
    await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], newBranch: 'bad name..', expectedToken: await revision(id) }))
      .rejects.toThrow('That branch name is not allowed.');
    await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], newBranch: 'main', expectedToken: await revision(id) }))
      .rejects.toThrow('A branch with that name already exists.');
    const result = await commitProjectChanges(id, { message: 'Raise kept', paths: ['kept.ts'], newBranch: 'raise-kept', expectedToken: await revision(id) });
    expect(result.branch).toBe('raise-kept');
    expect(await git(root, 'branch', '--show-current')).toBe('raise-kept');
    expect(await git(root, 'log', '-1', '--format=%s', 'main')).toBe('baseline');
  });

  it('refuses while a merge is in progress, where Git cannot commit a choice of files', async () => {
    const { root, id } = await project();
    await git(root, 'checkout', '-q', '-b', 'side');
    await fs.writeFile(path.join(root, 'other.ts'), 'side\n');
    await git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qam', 'side');
    await git(root, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(root, 'other.ts'), 'main\n');
    await git(root, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qam', 'main');
    await git(root, 'merge', 'side').catch(() => undefined);
    await fs.writeFile(path.join(root, 'kept.ts'), 'export const kept = 9;\n');
    const state = await readCommitState(id);
    await expect(commitProjectChanges(id, { message: 'x', paths: ['other.ts'], expectedToken: state.token })).rejects.toThrow('Resolve the conflicts first, then commit.');
    await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], expectedToken: state.token }))
      .rejects.toThrow('A merge is in progress. Finish it in a terminal or your Git tool, then commit here.');
  });

  it('refuses on a detached HEAD, where a commit would belong to no branch', async () => {
    const { root, id } = await project();
    await git(root, 'checkout', '--detach');
    await change(root);
    await expect(commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], expectedToken: await revision(id) }))
      .rejects.toThrow('This folder is not on a branch. Check out a branch first.');
  });
});

describe('push', () => {
  it('pushes a new branch and tracks it, then pushes plainly', async () => {
    const { root, id, origin } = await project();
    await change(root);
    await commitProjectChanges(id, { message: 'Raise kept', paths: ['kept.ts'], newBranch: 'raise-kept', expectedToken: await revision(id) });
    await expect(pushProject(id)).resolves.toEqual({ branch: 'raise-kept', remote: 'origin', tracking: true });
    expect(await git(origin, 'log', '-1', '--format=%s', 'raise-kept')).toBe('Raise kept');
    expect(await git(root, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/raise-kept');
    await commitProjectChanges(id, { message: 'Other', paths: ['other.ts'], expectedToken: await revision(id) });
    await expect(pushProject(id)).resolves.toEqual({ branch: 'raise-kept', remote: 'origin', tracking: false });
  });

  it('says when the remote has work this branch does not, instead of forcing', async () => {
    const { root, id, origin } = await project();
    const clone = path.join(directory, 'clone');
    await git(directory, 'clone', origin, clone);
    await fs.writeFile(path.join(clone, 'kept.ts'), 'from elsewhere\n');
    await git(clone, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-am', 'elsewhere');
    await git(clone, 'push');
    await change(root);
    await commitProjectChanges(id, { message: 'Mine', paths: ['other.ts'], expectedToken: await revision(id) });
    await expect(pushProject(id)).rejects.toThrow('The remote has commits this branch does not have. Pull them first, then push again.');
  });

  it('says when there is nowhere to push', async () => {
    const { root, id } = await project({ origin: false });
    await change(root);
    await commitProjectChanges(id, { message: 'x', paths: ['kept.ts'], expectedToken: await revision(id) });
    await expect(pushProject(id)).rejects.toThrow('This repository has no remote to push to.');
  });
});

describe('the repository on GitHub', () => {
  it.each([
    ['https://github.com/octo/app.git', { owner: 'octo', repo: 'app' }],
    ['https://github.com/octo/app', { owner: 'octo', repo: 'app' }],
    ['git@github.com:octo/app.git', { owner: 'octo', repo: 'app' }],
    ['ssh://git@github.com/octo/app', { owner: 'octo', repo: 'app' }],
    ['https://user@github.com/octo/app.git', { owner: 'octo', repo: 'app' }],
    ['https://gitlab.com/octo/app.git', null],
    ['/srv/git/app.git', null],
    ['https://github.com/octo', null]
  ])('reads %s', (url, expected) => expect(githubRepository(url)).toEqual(expected));
});

describe('state and pull requests', () => {
  async function onGitHub(): Promise<{ root: string; id: string }> {
    // Fetches name GitHub; pushes still go to the local bare repository.
    const made = await project();
    await git(made.root, 'remote', 'set-url', 'origin', 'https://github.com/octo/app.git');
    await git(made.root, 'remote', 'set-url', '--push', 'origin', made.origin);
    return made;
  }

  it('tells the dialog the branch, the default branch, the remote and whether gh is ready', async () => {
    const { id } = await onGitHub();
    setGhRunnerForTests(async args => args[0] === 'auth' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' });
    await expect(readCommitState(id)).resolves.toMatchObject({
      branch: 'main', defaultBranch: 'main', remote: 'origin', upstream: 'origin/main', github: { owner: 'octo', repo: 'app' }, gh: 'ready', changes: []
    });
    setGhRunnerForTests(async () => ({ code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' }));
    expect((await readCommitState(id)).gh).toBe('signed-out');
    setGhRunnerForTests(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); });
    expect((await readCommitState(id)).gh).toBe('missing');
  });

  it('creates the pull request with gh, from this branch into the default one', async () => {
    const { root, id } = await onGitHub();
    await git(root, 'checkout', '-b', 'raise-kept');
    const calls: string[][] = [];
    const gh: GhRunner = async args => {
      calls.push(args);
      return args[0] === 'auth' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: 'https://github.com/octo/app/pull/7\n', stderr: '' };
    };
    setGhRunnerForTests(gh);
    await expect(createPullRequest(id, { title: 'Raise kept', body: 'Because.' })).resolves.toEqual({ url: 'https://github.com/octo/app/pull/7', via: 'gh' });
    expect(calls.at(-1)).toEqual(['pr', 'create', '--repo', 'octo/app', '--head', 'raise-kept', '--base', 'main', '--title', 'Raise kept', '--body', 'Because.']);
  });

  it('opens the existing pull request instead of failing when the branch has one', async () => {
    const { root, id } = await onGitHub();
    await git(root, 'checkout', '-b', 'raise-kept');
    setGhRunnerForTests(async args => args[0] === 'auth' ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: 'a pull request for branch "raise-kept" into branch "main" already exists:\nhttps://github.com/octo/app/pull/5\n' });
    await expect(createPullRequest(id, { title: 't', body: '' })).resolves.toEqual({ url: 'https://github.com/octo/app/pull/5', via: 'existing' });
  });

  it("falls back to GitHub's own page, filled in, without gh", async () => {
    const { root, id } = await onGitHub();
    await git(root, 'checkout', '-b', 'raise-kept');
    setGhRunnerForTests(async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); });
    const result = await createPullRequest(id, { title: 'Raise kept', body: 'Because.' });
    expect(result.via).toBe('browser');
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe('https://github.com/octo/app/compare/main...raise-kept');
    expect(Object.fromEntries(url.searchParams)).toEqual({ expand: '1', title: 'Raise kept', body: 'Because.' });
  });

  it('refuses a pull request from the default branch into itself', async () => {
    const { id } = await onGitHub();
    await expect(createPullRequest(id, { title: 't', body: '' })).rejects.toThrow('This branch is the default branch. Commit on a new branch to open a pull request.');
  });

  it('refuses a pull request for a remote that is not on GitHub', async () => {
    const { root, id } = await project();
    await git(root, 'checkout', '-b', 'raise-kept');
    await expect(createPullRequest(id, { title: 't', body: '' })).rejects.toThrow('This repository is not on GitHub. Open the pull request on its own site.');
  });
});
