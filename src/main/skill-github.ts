/** Explicit, bounded public-GitHub import/update for the canonical managed Skills library. */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { rawPromises as fs } from './rawfs.js';
import { importSkillPackage, linkSkillPackage, listManagedSkills, skillPackageRevision, updateSkillPackage } from './skills.js';
import {
  githubSkillUrl,
  parseGitHubSkillUrl,
  type GitHubSkillLocation,
  type GitHubSkillOrigin,
  type GitHubSkillUpdateCheck,
  type ManagedSkill
} from '../shared/skills.js';

const MAX_FILES = 40;
const MAX_DIRECTORIES = 12;
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

async function githubJson(endpoint: string, signal: AbortSignal, limit = 1024 * 1024): Promise<unknown> {
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
    if (response.status === 404) throw new Error('GitHub skill folder was not found or is private.');
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
  if (!ref) {
    const repository = await githubJson(base, signal) as { default_branch?: unknown };
    if (typeof repository.default_branch !== 'string' || !safeName(repository.default_branch))
      throw new Error('GitHub repository has no usable default branch');
    ref = repository.default_branch;
  }
  const location = { ...requested, ref };
  const commitInfo = await githubJson(`${base}/commits/${encodeURIComponent(ref)}`, signal) as { sha?: unknown };
  if (typeof commitInfo.sha !== 'string' || !SHA.test(commitInfo.sha)) throw new Error('GitHub commit could not be verified');
  const commit = commitInfo.sha;
  const queue = [{ directory: location.directory, relative: '', depth: 0 }];
  const files: File[] = [];
  let directoryCount = 0, bytes = 0;
  while (queue.length) {
    const current = queue.shift()!;
    if (++directoryCount > MAX_DIRECTORIES || current.depth > 10) throw new Error('GitHub skill has too many nested folders');
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
      if (files.length >= MAX_FILES) throw new Error('GitHub skill has too many files');
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

/** The recursive tree gives one bounded, metadata-only observation for all skills in a repository. */
function revisionFromTree(entries: TreeEntry[], directory: string): string {
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
      if (++directories > MAX_DIRECTORIES || segments.length > 10) throw new Error('GitHub skill has too many nested folders');
      continue;
    }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) ||
        !SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size! < 0)
      throw new Error('GitHub skill contains an unsupported file or link');
    if (files.length >= MAX_FILES) throw new Error('GitHub skill has too many files');
    bytes += entry.size!;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error('GitHub skill exceeds 32 MiB');
    files.push({ relative, sha: entry.sha, size: entry.size! });
  }
  if (!files.some(file => file.relative === 'SKILL.md')) throw new Error('GitHub skill folder needs SKILL.md');
  if (files.some(file => file.relative === '.cos-github.json')) throw new Error('GitHub skill uses a reserved CoS metadata filename');
  return skillPackageRevision(files);
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

async function stageSkill(snapshot: Snapshot, signal: AbortSignal): Promise<{ folder: string; origin: GitHubSkillOrigin; cleanup: () => Promise<void> }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-github-skill-'));
  const folderName = snapshot.location.directory.split('/').filter(Boolean).at(-1) ?? snapshot.location.repository;
  const folder = path.join(temporary, folderName);
  const base = repositoryEndpoint(snapshot.location);
  let skillSha256 = '';
  try {
    await fs.mkdir(folder);
    for (const file of snapshot.files) {
      const destination = path.join(folder, ...file.relative.split('/'));
      const bytes = await downloadBlob(base, file, signal);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      if (file.relative === 'SKILL.md') skillSha256 = createHash('sha256').update(bytes).digest('hex');
    }
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
