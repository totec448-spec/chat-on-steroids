import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Root } from '../shared/types.js';
import { listSkills, skillsDirectory } from './skills.js';

/** Only the managed skills directory joins Core's existing filesystem boundary. */
export function withSkillsRoot<T extends { roots: Root[] }>(context: T): T {
  const base = context.roots.some(root => root.name === 'skills')
    ? { ...context, roots: context.roots.filter(root => root.name !== 'skills') } : context;
  const directory = skillsDirectory();
  if (!directory) return base;
  try {
    const stat = lstatSync(directory);
    const canonical = realpathSync.native(directory);
    const identity = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!stat.isDirectory() || stat.isSymbolicLink() || identity(canonical) !== identity(directory)) return base;
    return { ...base, roots: [...base.roots, { name: 'skills', path: directory }] };
  } catch { return base; }
}

/** Metadata is a directory index; skill bodies are loaded only when selected or read. */
export async function skillIndexInstructions(): Promise<string> {
  if (!skillsDirectory()) return '';
  const library = await listSkills();
  const lines = ['# Available skills',
    'Skills are text instructions stored at /skills/<id>/SKILL.md. Use the existing Core read tool to list /skills and read a relevant skill before following it. The directory can change during a chat; list it again when the user mentions a newly installed skill.',
    'To install a skill requested by the user, use the existing file or command tools to create /skills/<id>/SKILL.md with UTF-8 Markdown. Prefer YAML frontmatter with name and description. Skill files do not install tools, enable plugins, grant permissions, or execute scripts and hooks. Only use tools actually available in this chat.',
    'The user can select skills through + → Skills or a leading /<id> command. Selected skill instructions appear below the main prompt and above project instructions. No skills are preinstalled.'];
  if (!library.skills.length) lines.push('No skills installed.');
  // Keep every supported id discoverable while bounding descriptions in the start prompt.
  for (const skill of library.skills) lines.push(`- /${skill.id}: ${JSON.stringify(skill.description.slice(0, 96))}`);
  if (library.errors.length) lines.push('Some skill files could not be indexed. The Skills window shows the errors; do not assume this index is complete.');
  return lines.join('\n');
}
