import path from 'node:path';
import { rawPromises as fs, rawRealpathNative } from './rawfs.js';
import { isContained, resolvePath, toVirtualPath } from './sandbox.js';
import type { Root } from '../shared/types.js';
import { SKILL_ID_PATTERN } from '../shared/skills.js';

type LinkIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export interface ApprovedSkillLink {
  real: string;
  identity: LinkIdentity;
}

const canonicalRealpath = (target: string): Promise<string> =>
  process.platform === 'win32' ? rawRealpathNative(target) : fs.realpath(target);

const sameNativePath = (left: string, right: string): boolean =>
  isContained(left, right) && isContained(right, left);

const identityOf = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): LinkIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs
});

const sameIdentity = (left: LinkIdentity, right: LinkIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/**
 * Prove that a canonical host path is still reachable through one of the user's ordinary
 * approved roots. Managed /skills is deliberately excluded: a link cannot use the special
 * library root as authority to escape that root.
 */
async function approvedTarget(roots: readonly Root[], targetReal: string): Promise<boolean> {
  const ordinary = roots.filter(root => root.name.toLowerCase() !== 'skills');
  for (const root of ordinary) {
    try {
      const base = await resolvePath(ordinary, `/${root.name}`);
      if (!isContained(base.real, targetReal)) continue;
      const checked = await resolvePath(ordinary, toVirtualPath(root, base.real, targetReal));
      if (sameNativePath(checked.real, targetReal)) return true;
    } catch {
      // Another approved root may still own the target. Invalid/revoked roots grant nothing.
    }
  }
  return false;
}

/**
 * Inspect one child of the managed Skills directory. Directories remain ordinary managed
 * packages. A symbolic-link/junction child is accepted only while its final target is a
 * directory inside a currently approved user root, and the link identity/target survives the
 * asynchronous approval check.
 */
export async function approvedManagedSkillLink(
  managedRoot: string,
  id: string,
  roots: readonly Root[]
): Promise<ApprovedSkillLink | null> {
  if (!SKILL_ID_PATTERN.test(id)) return null;
  const directory = path.join(managedRoot, id);
  let before;
  try { before = await fs.lstat(directory); }
  catch { return null; }
  if (!before.isSymbolicLink()) return null;
  let target;
  try { target = await fs.stat(directory); }
  catch { return null; }
  if (!target.isDirectory()) return null;
  let real: string;
  try { real = await canonicalRealpath(directory); }
  catch { return null; }
  if (!(await approvedTarget(roots, real))) return null;
  try {
    const after = await fs.lstat(directory);
    const currentReal = await canonicalRealpath(directory);
    if (!after.isSymbolicLink() || !sameIdentity(identityOf(before), identityOf(after)) ||
        !sameNativePath(real, currentReal) || !(await approvedTarget(roots, currentReal))) return null;
  } catch { return null; }
  return { real, identity: identityOf(before) };
}

export function sameSkillLink(
  left: ApprovedSkillLink,
  right: ApprovedSkillLink
): boolean {
  return sameNativePath(left.real, right.real) && sameIdentity(left.identity, right.identity);
}
