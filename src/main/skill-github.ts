/** Explicit, bounded public-GitHub import/update for the canonical managed Skills library. */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { rawPromises as fs } from './rawfs.js';
import { importSkillPackage, linkSkillPackage, listManagedSkills, skillPackageRevision, updateSkillPackage } from './skills.js';
import {
  githubSkillUrl,
  MAX_GITHUB_SKILL_DIRECTORIES,
  MAX_GITHUB_SKILL_FILES,
  parseGitHubSkillUrl,
  type GitHubSkillLocation,
  type GitHubSkillOrigin,
  type GitHubSkillUpdateCheck,
  type ManagedSkill
} from '../shared/skills.js';

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/i;
type Entry = { name: string; path: string; type: string; sha: string; size: number };
type File = { relative: string; sha: string; size: number };
type Snapshot = { location: GitHubSkillLocation & { ref: string }; commit: string; revision: string; files: File[] };
type TreeEntry = { path: string; type: string; mode: string; sha: string; size?: number };

function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) && !WINDOWS_DEVICE.test(name);
}

/** A branch or tag name git accepts, "/" included; never a path segment of its own. */
function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 255 && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(ref) &&
    !ref.includes('..') && !ref.includes('//') && !ref.includes('@{') && !ref.startsWith('/') && !ref.endsWith('/') &&
    !ref.endsWith('.') && !ref.endsWith('.lock') && ref !== '@';
}

async function githubJson(endpoint: string, signal: AbortSignal, limit = 1024 * 1024, missing: 'throw' | 'null' = 'throw'): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${endpoint}`, {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ChatOnSteroids-Skills' }
    });
  } catch {
    throw new Error(signal.aborted ? 'GitHub download timed out. Try again.' : 'Could not reach GitHub. Try again.');
  }
  if (!response.ok) {
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      throw new Error('GitHub API rate limit reached. Try again later.');
    if (response.status === 404) {
      if (missing === 'null') return null;
      throw new Error('GitHub skill folder was not found or is private.');
    }
    throw new Error(`GitHub request failed (${response.status}). Try again later.`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw new Error('GitHub response is too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('GitHub response is too large'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; }
  catch { throw new Error('GitHub returned invalid package metadata'); }
}

function repositoryEndpoint(location: GitHubSkillLocation): string {
  return `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}`;
}

async function inspectGitHubSkill(requested: GitHubSkillLocation, signal: AbortSignal): Promise<Snapshot> {
  const base = repositoryEndpoint(requested);
  let ref = requested.ref;
  let directory = requested.directory;
  let commitInfo: { sha?: unknown } | null = null;
  if (!ref) {
    const repository = await githubJson(base, signal) as { default_branch?: unknown };
    if (!validRef(repository.default_branch)) throw new Error('GitHub repository has no usable default branch');
    ref = repository.default_branch;
  } else {
    // A link cannot show where a branch like "dev/main" ends and the folder starts. Try the first
    // segment, then each longer prefix: git allows no branch beside one of its own prefixes, so
    // the first that resolves is the only one, and the usual "main" costs a single request.
    const segments = [ref, ...directory.split('/').filter(Boolean)];
    for (let take = 1; take <= Math.min(segments.length, 6); take++) {
      const candidate = segments.slice(0, take).join('/');
      if (!validRef(candidate)) break;
      const last = take === Math.min(segments.length, 6);
      commitInfo = await githubJson(`${base}/commits/${encodeURIComponent(candidate)}`, signal, undefined, last ? 'throw' : 'null') as { sha?: unknown } | null;
      if (commitInfo) { ref = candidate; directory = segments.slice(take).join('/'); break; }
    }
  }
  let location = { ...requested, ref, directory };
  commitInfo ??= await githubJson(`${base}/commits/${encodeURIComponent(ref)}`, signal) as { sha?: unknown };
  if (typeof commitInfo.sha !== 'string' || !SHA.test(commitInfo.sha)) throw new Error('GitHub commit could not be verified');
  const commit = commitInfo.sha;
  // A recursive tree contains the exact commit-pinned SHA/size of every file
  // in a single API request. The old contents BFS spent one API request per
  // directory and hit the 60/hour anonymous GitHub limit on large Skills.
  const payload = await githubJson(`${base}/git/trees/${encodeURIComponent(commit)}?recursive=1`,
    signal, 8 * 1024 * 1024) as { truncated?: unknown; tree?: unknown };
  const tree = payload.truncated === false && Array.isArray(payload.tree) && payload.tree.length <= 20_000 &&
    payload.tree.every(entry => entry && typeof entry === 'object' &&
      typeof (entry as TreeEntry).path === 'string' && typeof (entry as TreeEntry).type === 'string' &&
      typeof (entry as TreeEntry).mode === 'string' && typeof (entry as TreeEntry).sha === 'string')
    ? payload.tree as TreeEntry[] : null;
  // A repository root may contain exactly one Skill in a nested directory;
  // only auto-select it when unambiguous. Never import unrelated repo files.
  if (!location.directory) {
    if (!tree) throw new Error('GitHub repository tree is too large or incomplete; use a direct skill folder link');
    if (!tree.some(entry => entry.path === 'SKILL.md' && entry.type === 'blob')) {
      const candidates = tree.filter(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode) &&
        entry.path.endsWith('/SKILL.md') && entry.path.split('/').every(safeName));
      if (candidates.length !== 1)
        throw new Error(candidates.length ? 'GitHub repository contains multiple skills; choose a direct skill folder link' :
          'GitHub repository has no SKILL.md; choose a direct skill folder link');
      location = { ...location, directory: candidates[0]!.path.slice(0, -'/SKILL.md'.length) };
    }
  }
  if (tree) {
    const files = filesFromTree(tree, location.directory);
    return { location, commit, revision: skillPackageRevision(files), files };
  }
  // A truncated large repository can still provide a complete *explicitly
  // selected* Skill folder through the old bounded contents walk.
  const queue = [{ directory: location.directory, relative: '', depth: 0 }];
  const files: File[] = [];
  let directoryCount = 0, bytes = 0;
  while (queue.length) {
    const current = queue.shift()!;
    if (++directoryCount > MAX_GITHUB_SKILL_DIRECTORIES || current.depth > 10) throw new Error('GitHub skill has too many nested folders');
    const encoded = current.directory.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const listing = await githubJson(`${base}/contents${encoded ? `/${encoded}` : ''}?ref=${encodeURIComponent(commit)}`, signal);
    if (!Array.isArray(listing)) throw new Error('GitHub link must point to a skill folder');
    for (const value of listing) {
      const entry = value as Partial<Entry>;
      if (!safeName(entry.name) || typeof entry.path !== 'string' || entry.path !== [current.directory, entry.name].filter(Boolean).join('/'))
        throw new Error('GitHub skill contains an unsafe path');
      const relative = [current.relative, entry.name].filter(Boolean).join('/');
      if (entry.type === 'dir') { queue.push({ directory: entry.path, relative, depth: current.depth + 1 }); continue; }
      if (entry.type !== 'file' || typeof entry.sha !== 'string' || !SHA.test(entry.sha) ||
          !Number.isSafeInteger(entry.size) || entry.size! < 0)
        throw new Error('GitHub skill contains an unsupported file or link');
      if (files.length >= MAX_GITHUB_SKILL_FILES) throw new Error('GitHub skill has too many files');
      bytes += entry.size!;
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('GitHub skill exceeds 32 MiB');
      files.push({ relative, sha: entry.sha, size: entry.size! });
    }
  }
  if (!files.some(file => file.relative === 'SKILL.md')) throw new Error('GitHub skill folder needs SKILL.md');
  if (files.some(file => file.relative === '.cos-github.json')) throw new Error('GitHub skill uses a reserved CoS metadata filename');
  const revision = skillPackageRevision(files);
  return { location, commit, revision, files };
}

/** The recursive tree supplies both import/update file lists and revision checks. */
function filesFromTree(entries: TreeEntry[], directory: string): File[] {
  const prefix = directory ? `${directory}/` : '';
  if (directory && !entries.some(entry => entry.path === directory && entry.type === 'tree'))
    throw new Error('GitHub skill folder was not found');
  const files: File[] = [];
  let directories = 1, bytes = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || entry.path === directory) continue;
    const relative = entry.path.slice(prefix.length);
    const segments = relative.split('/');
    if (!segments.every(safeName)) throw new Error('GitHub skill contains an unsafe path');
    if (entry.type === 'tree' && entry.mode === '040000') {
      if (++directories > MAX_GITHUB_SKILL_DIRECTORIES || segments.length > 10) throw new Error('GitHub skill has too many nested folders');
      continue;
    }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) ||
        !SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size! < 0)
      throw new Error('GitHub skill contains an unsupported file or link');
    if (files.length >= MAX_GITHUB_SKILL_FILES) throw new Error('GitHub skill has too many files');
    bytes += entry.size!;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error('GitHub skill exceeds 32 MiB');
    files.push({ relative, sha: entry.sha, size: entry.size! });
  }
  if (!files.some(file => file.relative === 'SKILL.md')) throw new Error('GitHub skill folder needs SKILL.md');
  if (files.some(file => file.relative === '.cos-github.json')) throw new Error('GitHub skill uses a reserved CoS metadata filename');
  return files;
}

function revisionFromTree(entries: TreeEntry[], directory: string): string {
  return skillPackageRevision(filesFromTree(entries, directory));
}

/** A page visit checks sources, never installs them; each repository/ref is requested once. */
export async function checkGitHubSkillUpdates(id: string): Promise<GitHubSkillUpdateCheck[]> {
  const installed = await listManagedSkills();
  const selected = installed.find(skill => skill.id === id);
  if (!selected?.origin) throw new Error('Only GitHub-imported skills can be checked');
  const location = parseGitHubSkillUrl(selected.origin.url);
  const related = installed.filter(skill => {
    if (!skill.origin) return false;
    const candidate = parseGitHubSkillUrl(skill.origin.url);
    return candidate.owner.toLowerCase() === location.owner.toLowerCase() &&
      candidate.repository.toLowerCase() === location.repository.toLowerCase() && candidate.ref === location.ref;
  });
  const signal = AbortSignal.timeout(30_000);
  let entries: TreeEntry[] | null = null;
  let repositoryError: string | null = null;
  try {
    const payload = await githubJson(`${repositoryEndpoint(location)}/git/trees/${encodeURIComponent(location.ref!)}?recursive=1`, signal, 8 * 1024 * 1024) as
      { sha?: unknown; truncated?: unknown; tree?: unknown };
    if (typeof payload.sha !== 'string' || !SHA.test(payload.sha) || payload.truncated !== false ||
        !Array.isArray(payload.tree) || payload.tree.length > 20_000)
      throw new Error('GitHub repository tree is too large or incomplete to check safely');
    if (!payload.tree.every((entry: unknown) => entry && typeof entry === 'object' &&
        typeof (entry as TreeEntry).path === 'string' && typeof (entry as TreeEntry).type === 'string' &&
        typeof (entry as TreeEntry).mode === 'string' && typeof (entry as TreeEntry).sha === 'string'))
      throw new Error('GitHub returned invalid repository metadata');
    entries = payload.tree as TreeEntry[];
  } catch (error) {
    repositoryError = error instanceof Error ? error.message : 'Could not check GitHub';
  }
  const checkedAt = Date.now();
  const current = new Map((await listManagedSkills()).map(skill => [skill.id, skill]));
  return related.flatMap(skill => {
    const live = current.get(skill.id);
    if (!live?.origin || live.origin.url !== skill.origin!.url || live.origin.revision !== skill.origin!.revision) return [];
    let state: GitHubSkillUpdateCheck['state'] = 'error';
    let error = repositoryError ?? undefined;
    if (entries) {
      try { state = revisionFromTree(entries, skill.origin!.directory) === skill.origin!.revision ? 'current' : 'available'; }
      catch (cause) { error = cause instanceof Error ? cause.message : 'Could not check GitHub'; }
    }
    return [{ id: skill.id, originRevision: skill.origin!.revision, state, checkedAt, ...(error ? { error } : {}) }];
  });
}

async function downloadBlob(base: string, file: File, signal: AbortSignal): Promise<Buffer> {
  const payload = await githubJson(`${base}/git/blobs/${file.sha}`, signal, Math.min(MAX_PACKAGE_BYTES * 2, Math.ceil(file.size * 4 / 3) + 4096)) as
    { content?: unknown; encoding?: unknown; sha?: unknown; size?: unknown };
  if (payload.encoding !== 'base64' || payload.sha !== file.sha || payload.size !== file.size || typeof payload.content !== 'string')
    throw new Error(`GitHub file changed during download: ${file.relative}`);
  const encoded = payload.content.replace(/\s/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error(`GitHub returned invalid file content: ${file.relative}`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== file.size) throw new Error(`GitHub file size changed: ${file.relative}`);
  const algorithm = file.sha.length === 40 ? 'sha1' : 'sha256';
  const actual = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== file.sha) throw new Error(`GitHub file checksum failed: ${file.relative}`);
  return bytes;
}

/** Fetch immutable commit-pinned bytes from GitHub's raw host, not its metered
 * JSON API (one /git/blobs request per resource exceeds anonymous API quota
 * for legitimate 40+ file skills). Keep the independent Git blob hash check. */
async function downloadPinnedResource(snapshot: Snapshot, file: File, signal: AbortSignal): Promise<Buffer> {
  const relative = [snapshot.location.directory, file.relative].filter(Boolean).join('/');
  const url = 'https://raw.githubusercontent.com/' +
    [snapshot.location.owner, snapshot.location.repository, snapshot.commit, ...relative.split('/')]
      .map(encodeURIComponent).join('/');
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { 'User-Agent': 'ChatOnSteroids-Skills' } });
  } catch {
    throw new Error(signal.aborted ? 'GitHub download timed out. Try again.' : `Could not download GitHub skill file: ${file.relative}`);
  }
  if (!response.ok || !response.body) throw new Error(`GitHub skill resource could not be downloaded: ${file.relative} (${response.status})`);
  // Node fetch transparently decompresses raw GitHub responses: Content-Length
  // can describe the *compressed wire bytes*, not the decoded stream (e.g. 49
  // wire bytes for a 29-byte Python file). Bound decoded chunks and verify the
  // exact Git blob checksum below instead of trusting this response header.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > file.size) throw new Error(`GitHub file size changed: ${file.relative}`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (size !== file.size) throw new Error(`GitHub file size changed: ${file.relative}`);
  const bytes = Buffer.concat(chunks, size);
  const algorithm = file.sha.length === 40 ? 'sha1' : 'sha256';
  const actual = createHash(algorithm).update(`blob ${size}\0`).update(bytes).digest('hex');
  if (actual !== file.sha) throw new Error(`GitHub file checksum failed: ${file.relative}`);
  return bytes;
}

async function stageSkill(snapshot: Snapshot, signal: AbortSignal): Promise<{ folder: string; origin: GitHubSkillOrigin; cleanup: () => Promise<void> }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-github-skill-'));
  const folderName = snapshot.location.directory.split('/').filter(Boolean).at(-1) ?? snapshot.location.repository;
  const folder = path.join(temporary, folderName);
  let skillSha256 = '';
  try {
    await fs.mkdir(folder);
    // Small fixed worker pool: many files still finish within the bounded
    // import timeout, and all workers settle before a failed staging folder is
    // removed (no writes racing with cleanup).
    let next = 0, failure: unknown = null;
    await Promise.all(Array.from({ length: Math.min(4, snapshot.files.length) }, async () => {
      while (!failure) {
        const file = snapshot.files[next++];
        if (!file) return;
        try {
          const bytes = await downloadPinnedResource(snapshot, file, signal);
          const destination = path.join(folder, ...file.relative.split('/'));
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
          if (file.relative === 'SKILL.md') skillSha256 = createHash('sha256').update(bytes).digest('hex');
        } catch (error) { failure ??= error; return; }
      }
    }));
    if (failure) throw failure;
    const origin: GitHubSkillOrigin = {
      kind: 'github', url: githubSkillUrl(snapshot.location), ref: snapshot.location.ref,
      directory: snapshot.location.directory, commit: snapshot.commit, revision: snapshot.revision, skillSha256
    };
    return { folder, origin, cleanup: () => fs.rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function importGitHubSkill(url: string): Promise<ManagedSkill[]> {
  const signal = AbortSignal.timeout(120_000);
  const snapshot = await inspectGitHubSkill(parseGitHubSkillUrl(url), signal);
  const stage = await stageSkill(snapshot, signal);
  try { await importSkillPackage(stage.folder, stage.origin); }
  finally { await stage.cleanup(); }
  return listManagedSkills();
}

export async function linkGitHubSkill(id: string, url: string): Promise<ManagedSkill[]> {
  const installed = (await listManagedSkills()).find(skill => skill.id === id);
  if (!installed || installed.origin) throw new Error('Only local skills can be linked to GitHub');
  const signal = AbortSignal.timeout(120_000);
  const snapshot = await inspectGitHubSkill(parseGitHubSkillUrl(url), signal);
  const skillFile = snapshot.files.find(file => file.relative === 'SKILL.md')!;
  const remoteSkill = await downloadBlob(repositoryEndpoint(snapshot.location), skillFile, signal);
  const origin: GitHubSkillOrigin = {
    kind: 'github', url: githubSkillUrl(snapshot.location), ref: snapshot.location.ref,
    directory: snapshot.location.directory, commit: snapshot.commit, revision: snapshot.revision,
    skillSha256: createHash('sha256').update(remoteSkill).digest('hex')
  };
  await linkSkillPackage(id, origin);
  return listManagedSkills();
}

export async function updateGitHubSkill(
  id: string,
  moveToTrash: (directory: string) => Promise<void>
): Promise<{ status: 'current' | 'updated'; skills: ManagedSkill[]; warning?: string }> {
  const installed = (await listManagedSkills()).find(skill => skill.id === id);
  if (!installed?.origin) throw new Error('Only GitHub-imported skills can be updated');
  const signal = AbortSignal.timeout(120_000);
  const snapshot = await inspectGitHubSkill(parseGitHubSkillUrl(installed.origin.url), signal);
  if (snapshot.revision === installed.origin.revision) return { status: 'current', skills: await listManagedSkills() };
  const stage = await stageSkill(snapshot, signal);
  try {
    const result = await updateSkillPackage(id, installed.origin, stage.folder, stage.origin, moveToTrash);
    return { status: result.updated ? 'updated' : 'current', skills: await listManagedSkills(), warning: result.warning };
  } finally { await stage.cleanup(); }
}
