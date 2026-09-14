import { isSafeSkillId, listSkills, readSkill, skillsDirectory } from '../skills.js';
import { MAX_CHATGPT_MESSAGE_CHARS } from '../../shared/user-prompt.js';

/** Slash commands are recognized only in the leading command block, never in task prose. */
export function leadingSkillIds(text: string): string[] {
  const ids = new Set<string>();
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const explicit = /^\/prompt(?:[ \t]+([^\s]+))?[ \t]*$/.exec(line);
    if (explicit) {
      if (!explicit[1]) throw new Error('Choose a skill after /prompt before sending.');
      if (!isSafeSkillId(explicit[1])) throw new Error('Choose a valid skill command after /prompt.');
      ids.add(explicit[1]);
      continue;
    }
    const direct = /^\/([a-z0-9][a-z0-9._-]{0,63})[ \t]*$/.exec(line);
    if (!direct) break;
    if (!isSafeSkillId(direct[1])) throw new Error('Choose a valid installed skill command.');
    ids.add(direct[1]!);
  }
  return [...ids];
}

/** Bodies remain complete. The existing delivery ledger freezes the returned text. */
export async function selectedSkillInstructions(commands: readonly string[]): Promise<string> {
  const ids = [...new Set(commands.flatMap(leadingSkillIds))];
  if (!ids.length) return '';
  if (!skillsDirectory()) throw new Error('The skills library is not ready. Open Skills and try again.');
  const library = await listSkills();
  const available = new Set(library.skills.map(skill => skill.id));
  const lines = ['# Selected skills', 'Use these user-selected skill instructions for the task, subject to the main instructions and available tools.'];
  for (const id of ids) {
    if (!available.has(id)) throw new Error(`Skill /${id} is unavailable. Select an installed skill from Skills or remove the command.`);
    const skill = await readSkill(id);
    lines.push(`## ${id}\nSource: /skills/${id}/SKILL.md\n\n<SKILL_INSTRUCTIONS>\n${skill.text.replace(/\r\n?/g, '\n')}\n</SKILL_INSTRUCTIONS>`);
    if (lines.join('\n\n').length > MAX_CHATGPT_MESSAGE_CHARS) throw new Error('Selected skills exceed the 96,000-character message limit. Select fewer or shorter skills.');
  }
  return lines.join('\n\n');
}
