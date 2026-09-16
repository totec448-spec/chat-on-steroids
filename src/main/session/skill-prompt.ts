import { invokedSkills } from '../../shared/skill-invocation.js';
import { readSkill } from '../skills.js';

/** Read once at the input owner's preparation boundary. deliveryText owns retries. */
export type SelectedSkill = { id: string; text: string };
export async function selectedSkillInstructions(authored: string): Promise<SelectedSkill[]> {
  const sections: SelectedSkill[] = [];
  for (const id of invokedSkills(authored)) {
    const skill = await readSkill(id);
    sections.push({ id, text: skill.text.replace(/\r\n?/g, '\n') });
  }
  return sections;
}
