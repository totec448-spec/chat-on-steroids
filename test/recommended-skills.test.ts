import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initSkillsPath, listManagedSkills } from '../src/main/skills.js';
import { installRecommendedSkill, listRecommendedSkills } from '../src/main/recommended-skills.js';
import { RECOMMENDED_SKILLS } from '../src/shared/recommended-skills.js';
import { MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_NAME_CHARS, SKILL_ID_PATTERN } from '../src/shared/skills.js';

let root: string;
beforeEach(async () => { root = await makeTempDir(); await initSkillsPath(root); });
afterEach(async () => { await removeTempDir(root); });

it('ships well-formed recommended skills with unique ids', () => {
  expect(new Set(RECOMMENDED_SKILLS.map(skill => skill.id)).size).toBe(RECOMMENDED_SKILLS.length);
  for (const skill of RECOMMENDED_SKILLS) {
    expect(skill.id).toMatch(SKILL_ID_PATTERN);
    expect(skill.name.length).toBeLessThanOrEqual(MAX_SKILL_NAME_CHARS);
    expect(skill.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
    expect(skill.markdown.startsWith(`---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n`)).toBe(true);
  }
});

it('installs a recommended skill only on request, with its own metadata, and reports it as installed', async () => {
  expect((await listRecommendedSkills()).every(entry => !entry.installed)).toBe(true);
  expect(await listManagedSkills()).toEqual([]);
  const skills = await installRecommendedSkill('code-review');
  expect(skills.map(skill => [skill.id, skill.name])).toEqual([['code-review', 'Code review']]);
  expect((await listRecommendedSkills()).find(entry => entry.id === 'code-review')?.installed).toBe(true);
  await expect(installRecommendedSkill('code-review')).rejects.toThrow();
  await expect(installRecommendedSkill('not-a-skill')).rejects.toThrow('Unknown recommended skill');
});

it('installs every recommended skill with its exact name and description (#561)', async () => {
  // Six descriptions contain ": ", which unquoted YAML read as a nested mapping, so their
  // Install button failed with "bad indentation of a mapping entry".
  for (const recommended of RECOMMENDED_SKILLS) await installRecommendedSkill(recommended.id);
  const installed = new Map((await listManagedSkills()).map(skill => [skill.id, skill]));
  for (const recommended of RECOMMENDED_SKILLS) {
    expect(installed.get(recommended.id)).toMatchObject({ name: recommended.name, description: recommended.description });
  }
});
