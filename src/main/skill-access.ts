import type { Root } from '../shared/types.js';
import { isContained } from './sandbox.js';
import { skillsDirectory } from './skills.js';

/** Only the initialized canonical library is a managed root, never its userData parent. */
export function withManagedSkills<T extends { roots: Root[] }>(context: T): T {
  const directory = skillsDirectory();
  const roots = context.roots.filter(root => root.name.toLowerCase() !== 'skills');
  return { ...context, roots: directory ? [...roots, { name: 'skills', path: directory }] : roots };
}

export function isSkillPath(real: string): boolean {
  const directory = skillsDirectory();
  return !!directory && isContained(directory, real);
}

/** The library is reachable explicitly; it can never choose where a task starts. */
export function firstTaskRoot(roots: readonly Root[]): Root | undefined {
  return roots.find(root => root.name.toLowerCase() !== 'skills' && !isSkillPath(root.path));
}
