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
    expect(url.origin).toBe('https://api.github.com');
    const files = contents[version]!;
    if (url.pathname.endsWith('/commits/main')) {
      if (blocked) { blocked(); await new Promise<void>(resolve => { release = resolve; }); blocked = null; }
      return json({ sha: ['a', 'b', 'c'][version]!.repeat(40) });
    }
    if (url.pathname.endsWith('/git/trees/main')) {
      if (blockTree) { blockTree(); await new Promise<void>(resolve => { releaseTree = resolve; }); blockTree = null; }
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
