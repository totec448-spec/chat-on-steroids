import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  importSkillFile, initSkillsPath, listManagedSkills, listSkills, readSkill, readSkillAtRevision,
  removeSkill, setManagedSkillEnabled, skillCatalogSnapshot, skillCatalogInstructions
} from '../src/main/skills.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-managed-activation-');
  await initSkillsPath(directory);
  await fs.writeFile(path.join(directory, 'review.md'), '# Review\n\nReview source changes carefully.\n');
  await importSkillFile(path.join(directory, 'review.md'));
});
afterEach(async () => { await removeTempDir(directory); });

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

it('permanently removes the full imported package and clears the last activation-state file', async () => {
  await setManagedSkillEnabled('review', false);
  const packagePath = path.join(directory, 'skills/review');
  await fs.mkdir(path.join(packagePath, 'references'), { recursive: true });
  await fs.writeFile(path.join(packagePath, 'references/guide.txt'), 'example');
  await removeSkill('review', folder => fs.rm(folder, { recursive: true, force: false }));
  await expect(fs.lstat(packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(path.join(directory, 'skills/.cos-disabled-skills.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await listManagedSkills()).toEqual([]);
});
