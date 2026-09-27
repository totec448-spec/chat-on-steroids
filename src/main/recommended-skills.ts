import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RECOMMENDED_SKILLS } from '../shared/recommended-skills.js';
import type { ManagedSkill } from '../shared/skills.js';
import { importSkillPackage, listManagedSkills } from './skills.js';

export interface RecommendedSkillEntry { id: string; name: string; description: string; installed: boolean }

export async function listRecommendedSkills(): Promise<RecommendedSkillEntry[]> {
  const installed = new Set((await listManagedSkills()).map(skill => skill.id));
  return RECOMMENDED_SKILLS.map(({ id, name, description }) => ({ id, name, description, installed: installed.has(id) }));
}

/** Installs through the ordinary validated package import, from a private temporary folder. */
export async function installRecommendedSkill(id: string): Promise<ManagedSkill[]> {
  const skill = RECOMMENDED_SKILLS.find(entry => entry.id === id);
  if (!skill) throw new Error('Unknown recommended skill');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-recommended-skill-'));
  try {
    const folder = path.join(temporary, skill.id);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'SKILL.md'), skill.markdown, { flag: 'wx', mode: 0o600 });
    await importSkillPackage(folder);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return listManagedSkills();
}
