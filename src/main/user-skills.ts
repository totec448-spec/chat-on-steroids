/**
 * Read-only access to the user's own Skill folders outside the approved folders.
 *
 * Claude Code, Codex and the shared `~/.agents` keep Skills in the user's home: `skills/` and,
 * for plugins, `plugins/cache/<marketplace>/<plugin>/<version>/skills/`. Those homes also hold
 * credentials, settings and history, so approving the whole folder only to read a SKILL.md
 * would expose all of that. Instead the Skill trees alone are readable, under the virtual
 * `/user-skills/<area>/…` path, by read tools only (`resolveIn(…, { access: 'read' })`).
 *
 * Two levels, both bounded to the areas below:
 * - **served**: what a read tool may open. Only Skill trees.
 * - **discoverable**: what the app itself reads to build the catalog. The Skill trees, plus the
 *   few metadata files discovery needs (Claude Code's installed/enabled plugin lists, the Codex
 *   config and plugin manifests). Never served to a tool.
 *
 * A path is checked lexically and again after following links: a link may only land in a tree of
 * the same level, so `~/.claude/skills/x → ~/.agents/skills/x` works and a link out does not.
 */
import os from 'node:os';
import path from 'node:path';
import { rawPromises as fs } from './rawfs.js';
import { isContained, SandboxError, type Resolved } from './sandbox.js';

export const USER_SKILLS_ROOT = 'user-skills';
export type UserSkillAreaName = 'claude' | 'codex' | 'agents' | 'admin';
export interface UserSkillArea { name: UserSkillAreaName; base: string }

function home(): string {
  return path.resolve((process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir());
}

export function userSkillAreas(): UserSkillArea[] {
  return [
    { name: 'claude', base: path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home(), '.claude')) },
    { name: 'codex', base: path.resolve(process.env.CODEX_HOME?.trim() || path.join(home(), '.codex')) },
    { name: 'agents', base: path.join(home(), '.agents') },
    { name: 'admin', base: process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex') : '/etc/codex' }
  ];
}

/** Claude Code's account file, read only for the signed-in account's synced Skills folder. */
function claudeAccountFile(claudeBase: string): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() ? path.join(claudeBase, '.claude.json') : path.join(path.dirname(claudeBase), '.claude.json');
}

const same = (a: string, b: string): boolean => isContained(a, b) && isContained(b, a);

/** `skills/…`, or a cached plugin package's `skills/…` (`plugins/cache/<m>/<p>/<v>/skills/…`). */
function served(segments: readonly string[]): boolean {
  return segments[0] === 'skills' ||
    (segments[0] === 'plugins' && segments[1] === 'cache' && segments.length >= 6 && segments[5] === 'skills');
}

function discoverable(area: UserSkillAreaName, segments: readonly string[]): boolean {
  if (served(segments)) return true;
  const joined = segments.join('/');
  // A cached plugin package folder (`plugins/cache/<m>/<p>/<v>`), checked before its skills/ is read.
  const pluginPackage = segments[0] === 'plugins' && segments[1] === 'cache' && segments.length === 5;
  if (area === 'claude') return pluginPackage || joined === 'settings.json' || joined === 'plugins/installed_plugins.json' || joined === 'plugins/cache';
  if (area === 'codex') {
    // The home itself only gates running `codex plugin list`; its manifest names the package owning the Skills.
    return segments.length === 0 || pluginPackage || joined === 'config.toml' || joined === 'plugins/cache' ||
      (segments[0] === 'plugins' && segments[1] === 'cache' && (
        (segments.length === 6 && (segments[5] === 'plugin.json' || segments[5] === '.codex-plugin')) ||
        (segments.length === 7 && segments[5] === '.codex-plugin' && segments[6] === 'plugin.json')));
  }
  if (area === 'admin') return joined === 'config.toml';
  return false;
}

function segmentsOf(relative: string): string[] | null {
  if (relative === '') return [];
  const segments = relative.split(/[\\/]+/);
  return segments.some(segment => !segment || segment === '.' || segment === '..') ? null : segments;
}

/** Real path of `file`, or, when it is missing and `allowMissing`, of its nearest existing ancestor plus the rest. */
async function realOf(file: string, allowMissing: boolean): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await realOf(parent, true), path.basename(file));
  }
}

async function realAreas(): Promise<Array<UserSkillArea & { real: string }>> {
  const out: Array<UserSkillArea & { real: string }> = [];
  for (const area of userSkillAreas()) {
    try { out.push({ ...area, real: await fs.realpath(area.base) }); } catch { /* An area that does not exist has nothing to offer. */ }
  }
  return out;
}

type Level = 'served' | 'discoverable';

/** Where `real` lands, if inside an area at the given level. */
function placeOf(areas: Array<UserSkillArea & { real: string }>, real: string, level: Level): { area: UserSkillArea & { real: string }; segments: string[] } | null {
  for (const area of areas) {
    if (!isContained(area.real, real)) continue;
    const segments = segmentsOf(path.relative(area.real, real));
    if (segments && (level === 'served' ? served(segments) : discoverable(area.name, segments))) return { area, segments };
  }
  return null;
}

/**
 * The catalog's read of a host path inside a user Skill area, or null when the path is not one.
 * Throws when the path is in an area but leaves what may be read (by name or by link).
 */
export async function discoverUserSkillPath(file: string, allowMissing = false): Promise<{ real: string; virtual: string } | null> {
  let lexical: string;
  if (isUserSkillVirtualPath(file)) {
    // The catalog's own `/user-skills/<area>/…` path, read back when a Skill is selected.
    const [, , areaName, ...rest] = (process.platform === 'win32' ? file.replace(/\\/g, '/') : file).replace(/\/+$/, '').split('/');
    const area = userSkillAreas().find(candidate => candidate.name === areaName);
    if (!area || rest.some(segment => !segment || segment === '.' || segment === '..')) return null;
    lexical = path.join(area.base, ...rest);
  } else lexical = path.resolve(file);
  const areas = await realAreas();
  for (const area of userSkillAreas()) {
    const account = area.name === 'claude' && same(lexical, claudeAccountFile(area.base));
    if (!account && !isContained(area.base, lexical)) continue;
    const segments = account ? [] : segmentsOf(path.relative(area.base, lexical));
    if (!segments || (!account && !discoverable(area.name, segments))) continue;
    const real = await realOf(lexical, allowMissing);
    if (account) {
      const stat = await fs.lstat(real).catch(() => null);
      if (stat && !stat.isFile()) throw new SandboxError('Claude Code account file must be a regular file');
      return { real, virtual: '' };
    }
    const place = placeOf(areas, real, 'discoverable');
    if (!place) throw new SandboxError('A linked Skill path leaves the Skill folders');
    return { real, virtual: `/${USER_SKILLS_ROOT}/${place.area.name}${place.segments.length ? `/${place.segments.join('/')}` : ''}` };
  }
  return null;
}

export function isUserSkillVirtualPath(virtual: string): boolean {
  const normalized = process.platform === 'win32' ? virtual.replace(/\\/g, '/') : virtual;
  return new RegExp(`^/${USER_SKILLS_ROOT}(?:/|$)`, 'i').test(normalized);
}

/**
 * A read tool's `/user-skills/<area>/…` path, resolved to the Skill file or folder it names.
 * Null for any other path. Only Skill trees are served, and only for reading.
 */
export async function resolveUserSkillPath(requested: string): Promise<Resolved | null> {
  if (!isUserSkillVirtualPath(requested)) return null;
  const normalized = (process.platform === 'win32' ? requested.replace(/\\/g, '/') : requested).replace(/\/+$/, '');
  const [, , areaName, ...rest] = normalized.split('/');
  const area = userSkillAreas().find(candidate => candidate.name === areaName);
  if (!area || rest.some(segment => !segment || segment === '.' || segment === '..') || !served(rest)) {
    throw new SandboxError(`Not found: ${requested}. /${USER_SKILLS_ROOT} holds only the Skill folders listed in the Skills catalog.`);
  }
  let real: string;
  try { real = await fs.realpath(path.join(area.base, ...rest)); }
  catch { throw new SandboxError(`Not found: ${requested}`); }
  const place = placeOf(await realAreas(), real, 'served');
  if (!place) throw new SandboxError('A linked Skill path leaves the Skill folders');
  const virtual = `/${USER_SKILLS_ROOT}/${place.area.name}/${place.segments.join('/')}`;
  return { real, virtual, root: { name: USER_SKILLS_ROOT, path: place.area.real } };
}
