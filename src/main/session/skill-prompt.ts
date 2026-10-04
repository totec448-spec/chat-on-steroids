import { invokedSkills } from '../../shared/skill-invocation.js';
import { listSkillLibrary, readLibrarySkill, type SkillLibraryScope } from '../skill-library.js';
import { readSkillAtRevision } from '../skills.js';
import type { RoutedSkillSelection } from '../../shared/skill-routing.js';
import type { SkillLibrary } from '../../shared/skills.js';

/** Read once at the input owner's preparation boundary. deliveryText owns retries. */
export type SelectedSkill = { id: string; text: string; path?: string };
export async function selectedSkillInstructions(authored: string, scope: SkillLibraryScope = {}, library?: SkillLibrary, autoSkills: readonly RoutedSkillSelection[] = []): Promise<SelectedSkill[]> {
  const sections: SelectedSkill[] = [];
  const ids = invokedSkills(authored);
  if (!ids.length && autoSkills.length) {
    for (const selection of autoSkills) {
      const skill = await readSkillAtRevision(selection.id, selection.revision);
      sections.push({ id: selection.id, path: skill.summary.path, text: skill.text.replace(/\r\n?/g, '\n') });
    }
    return sections;
  }
  if (!ids.length) return sections;
  const current = library ?? await listSkillLibrary(scope);
  for (const id of ids) {
    const skill = await readLibrarySkill(id, scope, current);
    sections.push({ id, path: skill.summary.path, text: skill.text.replace(/\r\n?/g, '\n') });
  }
  return sections;
}
