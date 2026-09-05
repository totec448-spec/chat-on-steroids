import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts', 'verify-public-history.mjs');
const repositories: string[] = [];
const safeEmail = '227782719+totec448-spec@users.noreply.github.com';

function makeRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), 'public-history-privacy-'));
  repositories.push(repository);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository });
  writeFileSync(path.join(repository, 'README.md'), 'clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  commit(repository, 'Clean root', safeEmail);
  return repository;
}

function commit(repository: string, message: string, email: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'totec448-spec',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'totec448-spec',
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

function tag(repository: string, name: string, message: string, email: string): void {
  execFileSync('git', ['tag', '-a', name, '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: 'totec448-spec',
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_NAME: 'totec448-spec',
      GIT_AUTHOR_EMAIL: email,
    },
  });
}

function verify(repository: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('public-history privacy gate', () => {
  it('accepts the numeric GitHub noreply identity', () => {
    const repository = makeRepository();
    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('rejects a non-noreply maintainer identity without printing the address', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity', privateEmail);

    const result = verify(repository, {
      ...process.env,
      // Reproduce a child repository running inside a fork's GitHub Actions job.
      GITHUB_REPOSITORY: 'example-fork/chat-on-steroids',
      GITHUB_WORKSPACE: process.cwd(),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  it('rejects Claude session provenance in commit messages without echoing it', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_exampleIdentifier'].join('');
    commit(repository, `Unsafe trailer\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  /**
   * A full clone carries refs this branch will never contain: other contributors' fetched
   * branches, abandoned local experiments. Those cannot enter the releasable line, so they
   * are not this gate's business — and failing on them made a clean branch look unsafe.
   */
  it('passes a clean checked-out line even when an unrelated ref carries unsafe identity', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    execFileSync('git', ['checkout', '-q', '-b', 'unrelated'], { cwd: repository });
    commit(repository, 'Unsafe identity on a ref this branch never contains', privateEmail);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repository });

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('still rejects unsafe identity that is an ancestor of HEAD', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity in ancestry', privateEmail);
    commit(repository, 'Clean commit on top', safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  /**
   * The merge commit GitHub writes for a merged pull request carries whatever address that
   * account publishes, and no local hook ever saw it. Once it is on `origin/main` the value
   * is public, so failing every later push cannot unpublish it — it only strands the clone.
   * Taking it out is a deliberate rewrite of a public branch, not a hook's decision.
   */
  it('exempts unsafe identity that is already published on origin/main', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity merged through the forge', privateEmail);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Clean local commit on top', safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('still rejects unsafe identity a push would add ahead of origin/main', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Unsafe identity not published yet', privateEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  it('keeps annotated tags reachable from HEAD under the same checks', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_taggedIdentifier'].join('');
    tag(repository, 'v0.0.1-test', `Release\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  it('ignores an annotated tag that is not reachable from HEAD', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_otherLineIdentifier'].join('');
    execFileSync('git', ['checkout', '-q', '-b', 'other-line'], { cwd: repository });
    commit(repository, 'Only on the other line', safeEmail);
    tag(repository, 'v0.0.2-other', `Release\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repository });

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });
});
