import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  importSkillFile, initSkillsPath, listManagedSkills, listSkills, readSkill, readSkillAtRevision,
  removeSkill, setDiscoveredSkillEnabled, setManagedSkillEnabled, skillCatalogSnapshot, skillCatalogInstructions
} from '../src/main/skills.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-managed-activation-');
  await initSkillsPath(directory);
  await fs.writeFile(path.join(directory, 'review.md'), '# Review\n\nReview source changes carefully.\n');
  await importSkillFile(path.join(directory, 'review.md'));
});
afterEach(async () => { await removeTempDir(directory); });

/** Reproduce a process exit after the original folder was renamed into a marked stage. */
async function interruptRemoval(original: string): Promise<{ stageRoot: string; staged: string }> {
  const parent = path.dirname(original), name = path.basename(original);
  const identity = await fs.lstat(original);
  const stageRoot = path.join(parent, `.cos-removing-${randomUUID()}`);
  const staged = path.join(stageRoot, name);
  await fs.mkdir(stageRoot);
  await fs.writeFile(path.join(stageRoot, '.cos-removal.json'), JSON.stringify({
    version: 1, name, kind: 'directory',
    identity: { dev: identity.dev, ino: identity.ino, size: identity.size }
  }));
  await fs.rename(original, staged);
  return { stageRoot, staged };
}

it('defaults enabled, persists disabling without deleting files, and blocks catalog and prompt invocation', async () => {
  expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: true });
  expect((await listSkills()).map(skill => skill.id)).toEqual(['review']);
  const revision = skillCatalogSnapshot()[0]!.revision;
  await setManagedSkillEnabled('review', false);
  expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
  expect(await listSkills()).toEqual([]);
  expect(skillCatalogSnapshot()).toEqual([]);
  expect(skillCatalogInstructions()).not.toContain('"id":"review"');
  await expect(readSkill('review')).rejects.toThrow('disabled');
  await expect(readSkillAtRevision('review', revision)).rejects.toThrow('disabled');
  expect(await fs.readFile(path.join(directory, 'skills/review/SKILL.md'), 'utf8')).toContain('Review source changes');

  // An application restart must not silently re-enable an intentionally disabled Skill.
  await initSkillsPath(directory);
  expect((await listManagedSkills())[0]!.enabled).toBe(false);
  await setManagedSkillEnabled('review', true);
  expect((await listSkills()).map(skill => skill.id)).toEqual(['review']);
  expect((await readSkill('review')).text).toContain('Review source changes');
  expect((await listManagedSkills())[0]!.enabled).toBe(true);
});

it('rejects unknown Skill IDs and fails closed for corrupt activation state', async () => {
  await expect(setManagedSkillEnabled('not-installed', false)).rejects.toThrow('not installed');
  await setManagedSkillEnabled('review', false);
  await fs.writeFile(path.join(directory, 'skills/.cos-disabled-skills.json'), '{invalid-json');
  await expect(initSkillsPath(directory)).rejects.toThrow('Could not read Skills activation state');
  expect(await listSkills()).toEqual([]);
});

it('clears a removed Skill activation flag so importing it again uses the enabled default', async () => {
  await setManagedSkillEnabled('review', false);
  await removeSkill('review', async folder => {
    await fs.rename(folder, path.join(directory, 'removed-review'));
  });
  expect(await listManagedSkills()).toEqual([]);
  await importSkillFile(path.join(directory, 'review.md'));
  expect((await listManagedSkills())[0]!.enabled).toBe(true);
});

it('trashes the full imported package and clears the last activation-state file', async () => {
  await setManagedSkillEnabled('review', false);
  const packagePath = path.join(directory, 'skills/review');
  await fs.mkdir(path.join(packagePath, 'references'), { recursive: true });
  await fs.writeFile(path.join(packagePath, 'references/guide.txt'), 'example');
  await removeSkill('review', folder => fs.rename(folder, path.join(directory, 'trashed-review')));
  await expect(fs.lstat(packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(directory, 'trashed-review/references/guide.txt'), 'utf8')).toBe('example');
  await expect(fs.lstat(path.join(directory, 'skills/.cos-disabled-skills.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await listManagedSkills()).toEqual([]);
});

it('restores a disabled imported package when Trash fails without changing its activation state', async () => {
  await setManagedSkillEnabled('review', false);
  await expect(removeSkill('review', async () => { throw new Error('Trash unavailable'); })).rejects.toThrow('Trash unavailable');
  expect(await fs.readFile(path.join(directory, 'skills/review/SKILL.md'), 'utf8')).toContain('Review source changes');
  expect((await listManagedSkills())[0]!.enabled).toBe(false);
  await initSkillsPath(directory);
  expect((await listManagedSkills())[0]!.enabled).toBe(false);
});

it('recovers a managed Skill after a crash between removal staging and Trash', async () => {
  const original = path.join(directory, 'skills/review');
  await fs.mkdir(path.join(original, 'references'));
  await fs.writeFile(path.join(original, 'references/guide.txt'), 'Keep this resource');
  await setManagedSkillEnabled('review', false);
  const { stageRoot } = await interruptRemoval(original);
  await expect(fs.lstat(original)).rejects.toMatchObject({ code: 'ENOENT' });

  await initSkillsPath(directory);
  expect(await fs.readFile(path.join(original, 'references/guide.txt'), 'utf8')).toBe('Keep this resource');
  expect((await listManagedSkills())[0]).toMatchObject({ id: 'review', enabled: false });
  await expect(fs.lstat(stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses to overwrite a replacement managed Skill during removal recovery', async () => {
  const original = path.join(directory, 'skills/review');
  const { stageRoot, staged } = await interruptRemoval(original);
  await fs.mkdir(original);
  await fs.writeFile(path.join(original, 'SKILL.md'), '# Replacement\n\nKeep the new package.');

  await initSkillsPath(directory);
  expect(await fs.readFile(path.join(original, 'SKILL.md'), 'utf8')).toBe('# Replacement\n\nKeep the new package.');
  expect(await fs.readFile(path.join(staged, 'SKILL.md'), 'utf8')).toContain('Review source changes');
  expect(await fs.readFile(path.join(stageRoot, '.cos-removal.json'), 'utf8')).toContain('"name":"review"');
});

it('refuses forged managed removal markers and keeps their staged contents untouched', async () => {
  const original = path.join(directory, 'skills/review');
  const { stageRoot, staged } = await interruptRemoval(original);
  const marker = path.join(stageRoot, '.cos-removal.json');
  const record = JSON.parse(await fs.readFile(marker, 'utf8')) as {
    version: number; name: string; kind: string; identity: { dev: number; ino: number; size: number };
  };
  record.identity.ino += 1_000_000; // Windows inode numbers can exceed Number.MAX_SAFE_INTEGER.
  await fs.writeFile(marker, JSON.stringify(record));
  const forgedStage = path.join(directory, 'skills', `.cos-removing-${randomUUID()}`);
  await fs.mkdir(forgedStage);
  await fs.writeFile(path.join(forgedStage, '.cos-removal.json'), JSON.stringify({
    ...record, name: '../review'
  }));
  await fs.writeFile(path.join(forgedStage, 'sentinel'), 'Do not touch');

  await initSkillsPath(directory);
  await expect(fs.lstat(original)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(staged, 'SKILL.md'), 'utf8')).toContain('Review source changes');
  expect(await fs.readFile(marker, 'utf8')).toContain('"ino":');
  expect(await fs.readFile(path.join(forgedStage, 'sentinel'), 'utf8')).toBe('Do not touch');
  expect(await listManagedSkills()).toEqual([]);
});

it('persists more than 128 disabled discovered Skills and reads the same state after restart', async () => {
  for (let index = 0; index < 130; index++)
    await setDiscoveredSkillEnabled(`external-${String(index).padStart(3, '0')}`, false);
  const filename = path.join(directory, 'skills/.cos-disabled-skills.json');
  expect((JSON.parse(await fs.readFile(filename, 'utf8')) as { disabled: string[] }).disabled).toHaveLength(130);
  await initSkillsPath(directory);
  expect((await listManagedSkills())[0]!.enabled).toBe(true);
  expect((JSON.parse(await fs.readFile(filename, 'utf8')) as { disabled: string[] }).disabled).toHaveLength(130);
});

it('refuses an over-limit activation change without replacing a valid saved state', async () => {
  const filename = path.join(directory, 'skills/.cos-disabled-skills.json');
  const valid = JSON.stringify({ version: 1, disabled: Array.from({ length: 512 }, (_, i) => `external-${String(i).padStart(3, '0')}`) }) + '\n';
  await fs.writeFile(filename, valid);
  await initSkillsPath(directory);
  await expect(setDiscoveredSkillEnabled('external-overflow', false)).rejects.toThrow('Too many disabled Skills');
  expect(await fs.readFile(filename, 'utf8')).toBe(valid);
  await initSkillsPath(directory);
  expect((await listManagedSkills())[0]!.enabled).toBe(true);
});
