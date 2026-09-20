import type { Root } from '../shared/types.js';
import path from 'node:path';
import { approvedManagedSkillLink, sameSkillLink } from './skill-links.js';
import { rawPromises as fs } from './rawfs.js';
import { isAbsoluteVirtualPath, isContained, isNativeWindowsPath, resolvePath, SandboxError, type ResolveOptions, type Resolved } from './sandbox.js';
import { skillsDirectory } from './skills.js';
import { SKILL_ID_PATTERN } from '../shared/skills.js';

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

export function isSkillVirtualPath(virtual: string): boolean {
  const normalized = process.platform === 'win32' ? virtual.replace(/\\/g, '/') : virtual;
  return /^\/skills(?:\/|$)/i.test(normalized);
}

function virtualAliasCandidate(requested: string, base: string | null | undefined, managed: string): string | null {
  const normalizeVirtual = (value: string): string => process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
  // Preserve the spelling provenance of native paths that lexically enter the managed root.
  // resolvePath() normally canonicalizes a native path before choosing its root, which is right
  // for ordinary paths but would erase the /skills package boundary after following this link.
  if (path.isAbsolute(requested)) {
    const withoutRoot = process.platform === 'win32'
      ? requested.replace(/^[A-Za-z]:[\\/]+/, '').replace(/^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*/, '')
      : requested.replace(/^\/+/, '');
    if (!withoutRoot.split(/[/\\]+/).some(segment => segment === '.' || segment === '..')) {
      const native = path.resolve(requested);
      if (isContained(managed, native)) {
        const relative = path.relative(managed, native);
        return relative === '' ? '/skills' : `/skills/${relative.split(path.sep).join('/')}`;
      }
    }
  }
  const normalized = normalizeVirtual(requested);
  if (isAbsoluteVirtualPath(requested)) return normalized;
  if (isNativeWindowsPath(requested)) return null;
  if (base && isSkillVirtualPath(base)) {
    const baseNormalized = normalizeVirtual(base).replace(/\/+$/, '');
    const requestedNormalized = normalizeVirtual(requested).replace(/^\/+/, '');
    return `${baseNormalized}/${requestedNormalized}`;
  }
  return null;
}

function linkedAlias(requested: string, base: string | null | undefined, managed: string): { id: string; tail: string } | null {
  const candidate = virtualAliasCandidate(requested, base, managed);
  if (!candidate) return null;
  const match = /^\/skills\/([^/]+)(\/.*)?$/i.exec(candidate);
  if (!match) return null;
  const id = process.platform === 'win32' ? match[1]!.toLowerCase() : match[1]!;
  if (!SKILL_ID_PATTERN.test(id)) return null;
  return { id, tail: match[2] ?? '' };
}

/**
 * Resolve a symlinked managed package without weakening sandbox symlink handling generally.
 * The link target must already belong to an ordinary approved root. Its package then acts as a
 * narrow /skills/<id> alias: resources cannot traverse above that package, and every call
 * revalidates both the managed link and the user's root approval around path resolution.
 */
export async function resolveLinkedSkillAlias(
  roots: readonly Root[],
  requested: string,
  options: ResolveOptions = {}
): Promise<Resolved | null> {
  const managed = skillsDirectory();
  const alias = managed ? linkedAlias(requested, options.base, managed) : null;
  const skillRoot = roots.find(root => root.name.toLowerCase() === 'skills');
  if (!alias || !managed || !skillRoot) return null;

  // Revalidate the special root itself first. A replaced userData/skills directory never gets to
  // redirect resolution merely because one of its children looks like a valid link.
  const checkedRoot = await resolvePath([skillRoot], '/skills');
  const linkPath = path.join(checkedRoot.real, alias.id);
  let linkStat;
  try { linkStat = await fs.lstat(linkPath); }
  catch { return null; }
  if (!linkStat.isSymbolicLink()) return null;
  const before = await approvedManagedSkillLink(checkedRoot.real, alias.id, roots);
  if (!before) throw new SandboxError('Linked Skill target is outside the currently approved folders');

  const linkedRoot: Root = { name: 'linked-skill', path: before.real };
  const resolved = await resolvePath([linkedRoot], `/linked-skill${alias.tail}`, options);
  const after = await approvedManagedSkillLink(checkedRoot.real, alias.id, roots);
  if (!after || !sameSkillLink(before, after)) throw new SandboxError('Linked Skill changed while its path was being resolved');
  const relative = path.relative(before.real, resolved.real);
  const virtual = relative === ''
    ? `/skills/${alias.id}`
    : `/skills/${alias.id}/${relative.split(path.sep).join('/')}`;
  return { real: resolved.real, virtual, root: skillRoot };
}

/** The library is reachable explicitly; it can never choose where a task starts. */
export function firstTaskRoot(roots: readonly Root[]): Root | undefined {
  return roots.find(root => root.name.toLowerCase() !== 'skills' && !isSkillPath(root.path));
}
