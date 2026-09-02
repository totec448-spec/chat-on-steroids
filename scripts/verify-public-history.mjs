import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const maintainerLogin = 'totec448-spec';
const safeMaintainerEmail = /^(?:\d+\+)?totec448-spec@users\.noreply\.github\.com$/i;
const canonicalRepositoryRemote = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:|git:\/\/github\.com\/)totec448-spec\/chat-on-steroids(?:\.git)?\/?$/i;

// Keep the blocked values split so this guard does not contain the data it rejects.
const blockedText = [
  { label: 'private maintainer email', value: ['totec448', 'gmail.com'].join('@') },
  { label: 'Claude session trailer', value: ['Claude', 'Session:'].join('-') },
  { label: 'Claude session URL', value: ['https://claude.ai/code/', 'session_'].join('') },
  { label: 'private Windows user path', value: ['C:', 'Users', 'totec'].join('\\') },
];

function runGit(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function findBlockedText(text, location) {
  const normalized = text.toLowerCase();
  return blockedText
    .filter(({ value }) => normalized.includes(value.toLowerCase()))
    .map(({ label }) => `${location} contains ${label}`);
}

function checkMaintainerIdentity(name, email, location) {
  const normalizedName = name.trim().toLowerCase();
  const normalizedEmail = email.trim().replace(/^<|>$/g, '').toLowerCase();
  const belongsToMaintainer =
    normalizedName === maintainerLogin || normalizedEmail.includes(maintainerLogin);
  if (belongsToMaintainer && !safeMaintainerEmail.test(normalizedEmail)) {
    return [`${location} uses a non-noreply maintainer email`];
  }
  return [];
}

function parseGitIdent(ident) {
  const match = ident.match(/^(.*) <([^>]+)> \d+ [+-]\d{4}$/);
  if (!match) throw new Error('Could not parse the Git author identity.');
  return { name: match[1] ?? '', email: match[2] ?? '' };
}

function checkIndexedOrCommittedFiles(treeish) {
  const failures = [];
  for (const { label, value } of blockedText) {
    const args = ['grep', '-q', '-I', '-i', '-F', '-e', value];
    if (treeish === '--cached') args.push('--cached');
    else args.push(treeish);
    args.push('--', '.');
    const result = runGit(args, { allowFailure: true });
    if (result.status === 0) failures.push(`${treeish} contains ${label}`);
    else if (result.status !== 1) throw new Error(`git grep failed while checking ${label}`);
  }
  return failures;
}

function checkCurrentAuthor() {
  const ident = String(runGit(['var', 'GIT_AUTHOR_IDENT']).stdout).trim();
  const { name, email } = parseGitIdent(ident);
  return checkMaintainerIdentity(name, email, 'current Git author');
}

function checkMessageFile(messagePath) {
  return [
    ...checkCurrentAuthor(),
    ...findBlockedText(readFileSync(messagePath, 'utf8'), 'commit message'),
  ];
}

/**
 * Commits that are already published on the public main line.
 *
 * The gate exists to keep a private value from *entering* public history. A commit that is
 * already on the canonical public main line has entered it, and refusing every later local push cannot
 * unpublish it — it only strands the working clone, because the merge commits GitHub writes
 * for a merged pull request carry whatever address that account publishes, and no local hook
 * ever saw them. Those are exempt here; everything a local push would actually add stays
 * checked. Removing a value from published history is a deliberate rewrite of a public branch,
 * not something a pre-push hook should be able to demand.
 *
 * Fork clones commonly call the fork `origin` and the canonical repository `upstream`, so the
 * remote name itself is not authority. Prefer a fetched `main` whose configured URL names the
 * canonical GitHub repository; fall back to `origin/main` for ordinary clones and CI checkouts.
 * If neither exists, exempt nothing and keep the strict reading.
 */
function publishedMainRef() {
  const remotes = runGit(['remote'], { allowFailure: true });
  if (remotes.status === 0) {
    for (const remote of String(remotes.stdout).split(/\r?\n/).filter(Boolean)) {
      const url = runGit(['remote', 'get-url', remote], { allowFailure: true });
      if (url.status !== 0 || !canonicalRepositoryRemote.test(String(url.stdout).trim())) continue;
      const candidate = `refs/remotes/${remote}/main`;
      const ref = runGit(['rev-parse', '--verify', '--quiet', candidate], { allowFailure: true });
      if (ref.status === 0) return candidate;
    }
  }

  const fallback = 'refs/remotes/origin/main';
  const origin = runGit(['rev-parse', '--verify', '--quiet', fallback], { allowFailure: true });
  return origin.status === 0 ? fallback : null;
}

function publishedCommits() {
  const ref = publishedMainRef();
  if (!ref) return new Set();
  const listed = runGit(['rev-list', ref], { allowFailure: true });
  if (listed.status !== 0) return new Set();
  return new Set(String(listed.stdout).split(/\r?\n/).filter(Boolean));
}

function checkHistory() {
  const failures = [];
  const published = publishedCommits();
  // Only history that can actually enter the releasable line. `--all` walks every local and
  // remote-tracking ref in the clone, so an unrelated fetched branch — someone else's fork, an
  // abandoned experiment — could fail verification for a clean checked-out branch that never
  // contains it. A fresh CI checkout has no such refs, which is why this passes there and
  // fails locally on a full clone.
  const head = runGit(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const commits =
    head.status === 0
      ? String(runGit(['rev-list', 'HEAD']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  // pull_request jobs default to a GitHub-generated merge object that can never enter
  // public history. Its identity belongs to GitHub's test ref, not to the proposed tree.
  const syntheticPullRequestCommit =
    process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.GITHUB_SHA?.trim() : '';

  for (const commit of commits) {
    if (syntheticPullRequestCommit && commit === syntheticPullRequestCommit) continue;
    if (published.has(commit)) continue;
    const record = String(
      runGit(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', commit]).stdout,
    );
    const [authorName = '', authorEmail = '', committerName = '', committerEmail = '', ...body] =
      record.split('\0');
    const location = `commit ${commit}`;
    failures.push(
      ...checkMaintainerIdentity(authorName, authorEmail, `${location} author`),
      ...checkMaintainerIdentity(committerName, committerEmail, `${location} committer`),
      ...findBlockedText(body.join('\0'), `${location} message`),
    );
  }

  // Same rule for tags: an annotated tag reachable from HEAD is part of this line's public
  // history and stays checked. One that is not reachable belongs to a different line.
  const tags =
    head.status === 0
      ? String(runGit(['tag', '--merged', 'HEAD', '--list']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  for (const tag of tags) {
    const type = String(runGit(['cat-file', '-t', tag]).stdout).trim();
    if (type !== 'tag') continue;
    const record = String(
      runGit([
        'for-each-ref',
        `refs/tags/${tag}`,
        '--format=%(taggername)%00%(taggeremail)%00%(contents)',
      ]).stdout,
    );
    const [taggerName = '', taggerEmail = '', ...body] = record.split('\0');
    failures.push(
      ...checkMaintainerIdentity(taggerName, taggerEmail, `tag ${tag} tagger`),
      ...findBlockedText(body.join('\0'), `tag ${tag} message`),
    );
  }

  if (head.status === 0) failures.push(...checkIndexedOrCommittedFiles('HEAD'));
  return { failures, commits: commits.length, tags: tags.length };
}

function fail(failures) {
  console.error('Public-history privacy check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--message') {
  if (!argument) throw new Error('--message requires the commit-message file path.');
  const failures = checkMessageFile(argument);
  if (failures.length > 0) fail(failures);
} else if (mode === '--staged') {
  const failures = [...checkCurrentAuthor(), ...checkIndexedOrCommittedFiles('--cached')];
  if (failures.length > 0) fail(failures);
} else if (mode) {
  throw new Error(`Unknown argument: ${mode}`);
} else {
  const { failures, commits, tags } = checkHistory();
  if (failures.length > 0) fail(failures);
  else console.log(`Public-history privacy check passed (${commits} commits, ${tags} tags).`);
}
