import { invokedSkills } from '../../shared/skill-invocation.js';
import { listSkillLibrary, readLibrarySkill, type SkillLibraryScope } from '../skill-library.js';
import type { SkillLibrary } from '../../shared/skills.js';

/** Read once at the input owner's preparation boundary. deliveryText owns retries. */
export type SelectedSkill = { id: string; text: string; path?: string };
export async function selectedSkillInstructions(authored: string, scope: SkillLibraryScope = {}, library?: SkillLibrary): Promise<SelectedSkill[]> {
  const sections: SelectedSkill[] = [];
  const ids = invokedSkills(authored);
  if (!ids.length) return sections;
  const current = library ?? await listSkillLibrary(scope);
  for (const id of ids) {
    const skill = await readLibrarySkill(id, scope, current);
    sections.push({ id, path: skill.summary.path, text: skill.text.replace(/\r\n?/g, '\n') });
  }
  return sections;
}
