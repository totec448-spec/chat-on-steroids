import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGitHubSkillUrl } from '../src/shared/skills.js';
import { checkGitHubSkillUpdates, importGitHubSkill, linkGitHubSkill, updateGitHubSkill } from '../src/main/skill-github.js';
import { importSkillPackage, initSkillsPath, listManagedSkills, removeSkill } from '../src/main/skills.js';

let userData = '';
const json = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const blobSha = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function githubFixture() {
  let version = 0;
  let blocked: (() => void) | null = null;
  let release: (() => void) | null = null;
  let blockTree: (() => void) | null = null;
  let releaseTree: (() => void) | null = null;
  let truncated = false;
  const review = Buffer.from('---\nname: Review\ndescription: Read the change.\n---\nReview carefully.\n');
  const contents = [
    { skill: Buffer.from('---\nname: Test Pet\ndescription: Version one.\n---\nUse guide.\n'), guide: Buffer.from('First guide') },
    { skill: Buffer.from('---\nname: Test Pet\ndescription: Version two.\n---\nUse updated guide.\n'), guide: Buffer.from('Second guide') },
    { skill: Buffer.from('---\nname: Test Pet\ndescription: Version one.\n---\nUse guide.\n'), guide: Buffer.from('Changed resource only') }
  ];
  const request = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.origin === 'https://raw.githubusercontent.com') {
      const pinned = ['a', 'b', 'c'][version]!.repeat(40);
      expect(url.pathname).toContain(`/acme/skills/${pinned}/`);
      if (url.pathname.endsWith('/pet/SKILL.md')) return new Response(contents[version]!.skill);
      if (url.pathname.endsWith('/pet/references/guide.md')) return new Response(contents[version]!.guide);
      if (url.pathname.endsWith('/review/SKILL.md')) return new Response(review);
      return new Response('Not found', { status: 404 });
    }
    expect(url.origin).toBe('https://api.github.com');
    const files = contents[version]!;
    if (url.pathname.endsWith('/commits/main')) {
      if (blocked) { blocked(); await new Promise<void>(resolve => { release = resolve; }); blocked = null; }
      return json({ sha: ['a', 'b', 'c'][version]!.repeat(40) });
    }
    if (url.pathname.endsWith('/git/trees/main') || /^\/repos\/acme\/skills\/git\/trees\/[abc]{40}$/.test(url.pathname)) {
      if (url.pathname.endsWith('/git/trees/main') && blockTree) {
        blockTree(); await new Promise<void>(resolve => { releaseTree = resolve; }); blockTree = null;
      }
      return json({ sha: 'd'.repeat(40), truncated, tree: [
        { path: 'pet', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
        { path: 'pet/SKILL.md', type: 'blob', mode: '100644', sha: blobSha(files.skill), size: files.skill.length },
        { path: 'pet/references', type: 'tree', mode: '040000', sha: 'f'.repeat(40) },
        { path: 'pet/references/guide.md', type: 'blob', mode: '100644', sha: blobSha(files.guide), size: files.guide.length },
        { path: 'review', type: 'tree', mode: '040000', sha: '1'.repeat(40) },
        { path: 'review/SKILL.md', type: 'blob', mode: '100644', sha: blobSha(review), size: review.length }
      ] });
    }
    if (url.pathname.endsWith('/contents/pet')) return json([
      { name: 'SKILL.md', path: 'pet/SKILL.md', type: 'file', sha: blobSha(files.skill), size: files.skill.length },
      { name: 'references', path: 'pet/references', type: 'dir', sha: 'c'.repeat(40), size: 0 }
    ]);
    if (url.pathname.endsWith('/contents/pet/references')) return json([
      { name: 'guide.md', path: 'pet/references/guide.md', type: 'file', sha: blobSha(files.guide), size: files.guide.length }
    ]);
    if (url.pathname.endsWith('/contents/review')) return json([
      { name: 'SKILL.md', path: 'review/SKILL.md', type: 'file', sha: blobSha(review), size: review.length }
    ]);
    const sha = url.pathname.split('/').at(-1);
    for (const bytes of [files.skill, files.guide, review]) {
      if (sha === blobSha(bytes)) return json({ content: bytes.toString('base64'), encoding: 'base64', sha, size: bytes.length });
    }
    return new Response('Not found', { status: 404 });
  });
  return {
    request,
    next: () => { version = 1; },
    resourceOnly: () => { version = 2; },
    pauseCommit: () => new Promise<void>(resolve => { blocked = resolve; }),
    resume: () => { release?.(); release = null; },
    pauseTree: () => new Promise<void>(resolve => { blockTree = resolve; }),
    resumeTree: () => { releaseTree?.(); releaseTree = null; },
    truncateTree: () => { truncated = true; }
  };
}

/** A realistic size for one genealogy Skill: metadata remains on the GitHub API,
 * while dozens of resource files must not exhaust its unauthenticated quota. */
function largeGithubFixture(fileCount = 92, folder = 'kinship') {
  const skill = Buffer.from('---\nname: Kinship\ndescription: Research family history.\n---\nUse the included references.\n');
  const commit = 'a'.repeat(40);
  const resources = Array.from({ length: fileCount - 1 }, (_, index) => ({
    name: `resource-${String(index).padStart(3, '0')}.md`,
    content: Buffer.from(`Family history reference ${index}\n`)
  }));
  const files = [{ name: 'SKILL.md', content: skill }, ...resources];
  const fileForSha = new Map(files.map(file => [blobSha(file.content), file]));
  const fileForName = new Map(files.map(file => [file.name, file]));
  const request = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === '/repos/acme/skills') return json({ default_branch: 'main' });
      if (url.pathname === '/repos/acme/skills/commits/main') return json({ sha: commit });
      if (url.pathname === `/repos/acme/skills/contents/${folder}`) return json(files.map(file => ({
        name: file.name, path: `${folder}/${file.name}`, type: 'file', sha: blobSha(file.content), size: file.content.length
      })));
      if (url.pathname === '/repos/acme/skills/git/trees/main' || url.pathname === `/repos/acme/skills/git/trees/${commit}`) return json({
        sha: commit, truncated: false, tree: [
          ...folder.split('/').map((_, index, segments) => ({
            path: segments.slice(0, index + 1).join('/'), type: 'tree', mode: '040000', sha: 'e'.repeat(40)
          })),
          ...files.map(file => ({ path: `${folder}/${file.name}`, type: 'blob', mode: '100644',
            sha: blobSha(file.content), size: file.content.length }))
        ]
      });
      if (url.pathname === '/repos/acme/skills/contents' && folder.includes('/')) return json([
        { name: folder.split('/')[0], path: folder.split('/')[0], type: 'dir', sha: 'e'.repeat(40), size: 0 }
      ]);
      const file = fileForSha.get(url.pathname.split('/').at(-1)!);
      if (file) return json({ content: file.content.toString('base64'), encoding: 'base64',
        sha: blobSha(file.content), size: file.content.length });
    }
    if (url.origin === 'https://raw.githubusercontent.com' && url.pathname.startsWith(`/acme/skills/${commit}/${folder}/`)) {
      const file = fileForName.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
      if (file) return new Response(file.content);
    }
    return new Response('Not found', { status: 404 });
  });
  return { request, skill, files };
}

beforeEach(async () => {
  userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-github-skills-test-')));
  await initSkillsPath(userData);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (userData) await fs.rm(userData, { recursive: true, force: true });
});

it('accepts only explicit GitHub skill folders or SKILL.md links', () => {
  expect(parseGitHubSkillUrl('https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet')).toEqual({
    owner: 'openai', repository: 'skills', ref: 'main', directory: 'skills/.curated/hatch-pet'
  });
  expect(parseGitHubSkillUrl('https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md').directory)
    .toBe('skills/.curated/hatch-pet');
  for (const url of [
    'http://github.com/acme/skills/tree/main/pet',
    'https://github.com.evil.test/acme/skills/tree/main/pet',
    'https://github.com/acme/skills/tree/main/%2e%2e/pet',
    'https://github.com/acme/skills/tree/main/pet?raw=1',
    'https://github.com/acme/skills/blob/main/pet/README.md'
  ]) expect(() => parseGitHubSkillUrl(url)).toThrow();
});

it('imports a bounded 92-file GitHub skill without one API blob request per file', async () => {
  const github = largeGithubFixture();
  vi.stubGlobal('fetch', github.request);
  const installed = await importGitHubSkill('https://github.com/acme/skills/tree/main/kinship');
  expect(installed[0]).toMatchObject({ id: 'kinship', origin: { kind: 'github', ref: 'main' } });
  expect((await fs.readdir(path.join(userData, 'skills', 'kinship'))).length).toBe(github.files.length + 1); // origin metadata
  expect(github.request.mock.calls.filter(([input]) => new URL(input).pathname.includes('/git/blobs/'))).toHaveLength(0);
  expect(github.request.mock.calls.filter(([input]) => new URL(input).host === 'raw.githubusercontent.com')).toHaveLength(92);
  expect(await checkGitHubSkillUpdates('kinship')).toMatchObject([{ state: 'current' }]);
});

it('links a locally installed SKILL.md against a 92-file GitHub package without copying resources', async () => {
  const github = largeGithubFixture();
  vi.stubGlobal('fetch', github.request);
  const local = path.join(userData, 'sources', 'kinship');
  await fs.mkdir(local, { recursive: true });
  await fs.writeFile(path.join(local, 'SKILL.md'), github.skill);
  await importSkillPackage(local);
  const linked = await linkGitHubSkill('kinship', 'https://github.com/acme/skills/tree/main/kinship');
  expect(linked[0]).toMatchObject({ id: 'kinship', origin: { kind: 'github', ref: 'main' } });
  expect((await fs.readdir(path.join(userData, 'skills', 'kinship'))).sort()).toEqual(['.cos-github.json', 'SKILL.md']);
  expect(github.request.mock.calls.filter(([input]) => new URL(input).pathname.includes('/git/blobs/'))).toHaveLength(1);
  expect(await checkGitHubSkillUpdates('kinship')).toMatchObject([{ state: 'available' }]);
});

it('resolves a repository root containing exactly one nested SKILL.md and imports all 190 resources', async () => {
  const github = largeGithubFixture(190, 'skills/last30days');
  vi.stubGlobal('fetch', github.request);
  const linked = await importGitHubSkill('https://github.com/acme/skills');
  expect(linked).toHaveLength(1);
  expect(linked[0]).toMatchObject({
    id: 'last30days', origin: { kind: 'github', url: 'https://github.com/acme/skills/tree/main/skills/last30days',
      directory: 'skills/last30days' }
  });
  expect((await fs.readdir(path.join(userData, 'skills', 'last30days'))).length).toBe(191);
  const metadataCalls = github.request.mock.calls.map(([input]) => new URL(input)).filter(url => url.host === 'api.github.com');
  expect(metadataCalls).toHaveLength(3); // repo default branch, commit, one recursive tree
  expect(metadataCalls.filter(url => url.pathname.includes('/contents'))).toHaveLength(0);
  expect(await checkGitHubSkillUpdates('last30days')).toMatchObject([{ state: 'current' }]);
});

it('links a differently named local skill by identical SKILL.md and updates without changing its ID', async () => {
  const github = githubFixture();
  vi.stubGlobal('fetch', github.request);
  const local = path.join(userData, 'sources', 'personal-name');
  await fs.mkdir(local, { recursive: true });
  await fs.writeFile(path.join(local, 'SKILL.md'), Buffer.from('---\nname: Test Pet\ndescription: Version one.\n---\nUse guide.\n'));
  await importSkillPackage(local);
  const linked = await linkGitHubSkill('personal-name', 'https://github.com/acme/skills/tree/main/pet');
  expect(linked[0]).toMatchObject({ id: 'personal-name', origin: { kind: 'github', directory: 'pet' } });
  expect(await checkGitHubSkillUpdates('personal-name')).toMatchObject([{ state: 'available' }]);
  github.next();
  const update = await updateGitHubSkill('personal-name', async backup => {
    await fs.rename(backup, path.join(userData, 'previous-personal-name'));
  });
  expect(update.status).toBe('updated');
  expect((await listManagedSkills())[0]).toMatchObject({ id: 'personal-name', origin: { kind: 'github', directory: 'pet' } });
  expect(await fs.readFile(path.join(userData, 'skills', 'personal-name', 'SKILL.md'), 'utf8')).toContain('Version two');
  expect(await fs.readFile(path.join(userData, 'previous-personal-name', 'SKILL.md'), 'utf8')).toContain('Version one');
});

it('still refuses GitHub packages over the 256-file bound', async () => {
  const github = largeGithubFixture(257);
  vi.stubGlobal('fetch', github.request);
  await expect(importGitHubSkill('https://github.com/acme/skills/tree/main/kinship')).rejects.toThrow('too many files');
  expect(await listManagedSkills()).toEqual([]);
});

it('does not silently choose a skill when a repository root contains multiple SKILL.md files', async () => {
  const commit = 'a'.repeat(40);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/repos/acme/skills') return json({ default_branch: 'main' });
    if (url.pathname === '/repos/acme/skills/commits/main') return json({ sha: commit });
    if (url.pathname === '/repos/acme/skills/contents') return json([{ name: 'skills', type: 'dir' }]);
    if (url.pathname === `/repos/acme/skills/git/trees/${commit}`) return json({
      truncated: false, tree: [
        { path: 'skills/one/SKILL.md', type: 'blob', mode: '100644', sha: 'b'.repeat(40), size: 1 },
        { path: 'skills/two/SKILL.md', type: 'blob', mode: '100644', sha: 'c'.repeat(40), size: 1 }
      ]
    });
    return new Response('Not found', { status: 404 });
  }));
  await expect(importGitHubSkill('https://github.com/acme/skills')).rejects.toThrow('multiple skills');
  expect(await listManagedSkills()).toEqual([]);
});

it('rejects tampered commit-pinned raw files without publishing a partial skill', async () => {
  const github = largeGithubFixture();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (new URL(input).pathname.endsWith('/kinship/SKILL.md') && new URL(input).host === 'raw.githubusercontent.com') {
      const tampered = Buffer.from(github.skill);
      tampered[0] = 0x58; // same size, different Git blob digest
      return new Response(tampered);
    }
    return github.request(input);
  }));
  await expect(importGitHubSkill('https://github.com/acme/skills/tree/main/kinship')).rejects.toThrow('checksum failed');
  expect(await listManagedSkills()).toEqual([]);
});

it('checks decoded raw bytes rather than compressed Content-Length headers', async () => {
  const github = githubFixture();
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const result = await github.request(input);
    if (new URL(input).host !== 'raw.githubusercontent.com' || !new URL(input).pathname.endsWith('SKILL.md'))
      return result;
    const decoded = Buffer.from(await result.arrayBuffer());
    // Real raw.githubusercontent.com may return Content-Length for compressed
    // transfer data even though fetch transparently delivers decoded bytes.
    return new Response(decoded, { headers: { 'content-length': String(decoded.length + 20) } });
  }));
  const installed = await importGitHubSkill('https://github.com/acme/skills/tree/main/pet');
  expect(installed).toMatchObject([{ id: 'pet', origin: { kind: 'github' } }]);
});

it('installs a complete public package, skips unchanged content and replaces changed content recoverably', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const installed = await importGitHubSkill('https://github.com/acme/skills/tree/main/pet');
  expect(installed).toHaveLength(1);
  expect(installed[0]).toMatchObject({ id: 'pet', origin: { kind: 'github', ref: 'main', url: 'https://github.com/acme/skills/tree/main/pet' } });
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('First guide');
  expect((await updateGitHubSkill('pet', async () => { throw new Error('unchanged skill should not be moved'); })).status).toBe('current');
  github.next();
  const moved: string[] = [];
  const result = await updateGitHubSkill('pet', async directory => {
    moved.push(directory);
    await fs.rename(directory, path.join(userData, 'previous-pet'));
  });
  expect(result.status).toBe('updated');
  expect(moved).toHaveLength(1);
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('Second guide');
  expect(await fs.readFile(path.join(userData, 'previous-pet/references/guide.md'), 'utf8')).toBe('First guide');
  expect((await listManagedSkills())[0]!.origin!.revision).not.toBe(installed[0]!.origin!.revision);
});

it('checks all skills from one repository with one metadata request and no downloads', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const pet = (await importGitHubSkill('https://github.com/acme/skills/tree/main/pet'))[0]!;
  await importGitHubSkill('https://github.com/acme/skills/tree/main/review');
  github.request.mockClear();
  expect(await checkGitHubSkillUpdates('pet')).toMatchObject([
    { id: 'pet', originRevision: pet.origin!.revision, state: 'current' },
    { id: 'review', state: 'current' }
  ]);
  expect(github.request).toHaveBeenCalledTimes(1);
  expect(new URL(github.request.mock.calls[0]![0]).pathname).toContain('/git/trees/main');
  github.next();
  expect((await checkGitHubSkillUpdates('review')).map(check => [check.id, check.state])).toEqual([
    ['pet', 'available'], ['review', 'current']
  ]);
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('First guide');
});

it('detects a changed resource even when SKILL.md has not changed', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const installed = (await importGitHubSkill('https://github.com/acme/skills/tree/main/pet'))[0]!;
  github.resourceOnly();
  expect(await checkGitHubSkillUpdates('pet')).toMatchObject([
    { id: 'pet', originRevision: installed.origin!.revision, state: 'available' }
  ]);
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('First guide');
});

it('links an older local copy without replacing files, then offers its missing GitHub resources', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const source = path.join(userData, 'sources/pet');
  await fs.mkdir(source, { recursive: true });
  const skill = Buffer.from('---\nname: Test Pet\ndescription: Version one.\n---\nUse guide.\n');
  await fs.writeFile(path.join(source, 'SKILL.md'), skill);
  await importSkillPackage(source);
  expect((await listManagedSkills())[0]!.origin).toBeNull();
  const linked = (await linkGitHubSkill('pet', 'https://github.com/acme/skills/tree/main/pet'))[0]!;
  expect(linked.origin?.url).toBe('https://github.com/acme/skills/tree/main/pet');
  expect(await fs.readFile(path.join(userData, 'skills/pet/SKILL.md'))).toEqual(skill);
  await expect(fs.stat(path.join(userData, 'skills/pet/references/guide.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await checkGitHubSkillUpdates('pet')).toMatchObject([{ id: 'pet', state: 'available' }]);
  const updated = await updateGitHubSkill('pet', directory => fs.rename(directory, path.join(userData, 'previous-pet')));
  expect(updated.status).toBe('updated');
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('First guide');
  expect(await checkGitHubSkillUpdates('pet')).toMatchObject([{ id: 'pet', state: 'current' }]);
});

it('marks a complete matching local package current immediately after linking', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const source = path.join(userData, 'sources/review');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Review\ndescription: Read the change.\n---\nReview carefully.\n');
  await importSkillPackage(source);
  await linkGitHubSkill('review', 'https://github.com/acme/skills/tree/main/review');
  expect(await checkGitHubSkillUpdates('review')).toMatchObject([{ id: 'review', state: 'current' }]);
  await expect(linkGitHubSkill('review', 'https://github.com/acme/skills/tree/main/review')).rejects.toThrow('Only local skills');
});

it('refuses a source with a different SKILL.md and does not attach metadata after removal', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const source = path.join(userData, 'sources/pet');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Other\ndescription: Different instructions.\n---\nDifferent instructions.\n');
  await importSkillPackage(source);
  await expect(linkGitHubSkill('pet', 'https://github.com/acme/skills/tree/main/pet')).rejects.toThrow('does not match');
  expect((await listManagedSkills())[0]!.origin).toBeNull();
  await fs.writeFile(path.join(userData, 'skills/pet/SKILL.md'), '---\nname: Test Pet\ndescription: Version one.\n---\nUse guide.\n');
  const reached = github.pauseCommit();
  const pending = linkGitHubSkill('pet', 'https://github.com/acme/skills/tree/main/pet');
  await reached;
  await removeSkill('pet', directory => fs.rename(directory, path.join(userData, 'removed-pet')));
  github.resume();
  await expect(pending).rejects.toThrow('removed or changed');
  expect(await listManagedSkills()).toEqual([]);
});

it('does not publish a stale check after removal and fails closed on a truncated tree', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/pet');
  const reached = github.pauseTree();
  const pending = checkGitHubSkillUpdates('pet');
  await reached;
  await removeSkill('pet', directory => fs.rename(directory, path.join(userData, 'removed-pet')));
  github.resumeTree();
  expect(await pending).toEqual([]);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/review');
  github.truncateTree();
  expect(await checkGitHubSkillUpdates('review')).toMatchObject([{ id: 'review', state: 'error' }]);
});

it('does not resurrect a skill removed while the GitHub check is in flight', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/pet');
  github.next();
  const reached = github.pauseCommit();
  const pending = updateGitHubSkill('pet', async () => { throw new Error('must not replace a removed skill'); });
  await reached;
  await removeSkill('pet', directory => fs.rename(directory, path.join(userData, 'removed-pet')));
  github.resume();
  await expect(pending).rejects.toThrow('changed while checking for updates');
  expect(await listManagedSkills()).toEqual([]);
});

it('keeps local edits and rejects untrusted origins or unsupported repository links', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/pet');
  await fs.appendFile(path.join(userData, 'skills/pet/SKILL.md'), '\nLocal note.\n');
  github.next();
  await expect(updateGitHubSkill('pet', async () => {})).rejects.toThrow('local edits');
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('First guide');
  await expect(importGitHubSkill('https://github.com.evil.test/acme/skills/tree/main/pet')).rejects.toThrow();
});

it('restores the previous GitHub package after an interrupted directory swap', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/pet');
  const backup = path.join(userData, 'skills', `.backup-pet-${randomUUID()}`);
  await fs.rename(path.join(userData, 'skills/pet'), backup);
  await initSkillsPath(userData);
  expect((await listManagedSkills())[0]).toMatchObject({ id: 'pet', origin: { kind: 'github' } });
  expect(await fs.readFile(path.join(userData, 'skills/pet/references/guide.md'), 'utf8')).toBe('First guide');
  await expect(fs.stat(backup)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not let a local package forge CoS GitHub origin metadata', async () => {
  const source = path.join(userData, 'sources', 'forged');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Forged\ndescription: Local skill.\n---\nHello.');
  await fs.writeFile(path.join(source, '.cos-github.json'), '{"kind":"github"}');
  await expect(importSkillPackage(source)).rejects.toThrow('cannot supply CoS origin metadata');
  expect(await listManagedSkills()).toEqual([]);
});

it('imports from a branch whose name contains a slash, as the default branch or in a pasted link', async () => {
  // GitHub allows "dev/main"; the default branch was refused as unusable, and a pasted
  // .../tree/dev/main/pet link was read as branch "dev" with folder "main/pet" (2.1.41 pass).
  const skill = Buffer.from('---\nname: Slash Pet\ndescription: From a slashed branch.\n---\nUse it.\n');
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    asked.push(url.pathname);
    if (url.origin === 'https://raw.githubusercontent.com' && url.pathname.endsWith('/pet/SKILL.md'))
      return new Response(skill);
    if (url.pathname === '/repos/acme/skills') return json({ default_branch: 'dev/main' });
    if (url.pathname === '/repos/acme/skills/commits/dev%2Fmain') return json({ sha: 'a'.repeat(40) });
    if (url.pathname === '/repos/acme/skills/contents') return json([]);
    if (url.pathname === `/repos/acme/skills/git/trees/${'a'.repeat(40)}`) return json({
      truncated: false, tree: [
        { path: 'pet', type: 'tree', mode: '040000', sha: 'f'.repeat(40) },
        { path: 'pet/SKILL.md', type: 'blob', mode: '100644', sha: blobSha(skill), size: skill.length }
      ]
    });
    if (url.pathname === '/repos/acme/skills/contents/pet') return json([
      { name: 'SKILL.md', path: 'pet/SKILL.md', type: 'file', sha: blobSha(skill), size: skill.length }
    ]);
    if (url.pathname.endsWith(`/${blobSha(skill)}`)) return json({ content: skill.toString('base64'), encoding: 'base64', sha: blobSha(skill), size: skill.length });
    return new Response('Not found', { status: 404 });
  }));
  const linked = await importGitHubSkill('https://github.com/acme/skills/tree/dev/main/pet');
  expect(linked[0]).toMatchObject({ id: 'pet', origin: { ref: 'dev/main', url: 'https://github.com/acme/skills/tree/dev/main/pet' } });
  // The link resolves its branch from the shortest prefix up, one request per candidate.
  expect(asked.filter(pathname => pathname.includes('/commits/'))).toEqual(['/repos/acme/skills/commits/dev', '/repos/acme/skills/commits/dev%2Fmain']);
  await removeSkill('pet', directory => fs.rename(directory, path.join(userData, 'removed-slash-pet')));
  const rootSkill = await importGitHubSkill('https://github.com/acme/skills');
  expect(rootSkill[0]).toMatchObject({ id: 'pet', origin: { ref: 'dev/main', directory: 'pet' } });
  expect(asked).toContain('/repos/acme/skills/commits/dev%2Fmain');
});
