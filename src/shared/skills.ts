/** Safe catalog metadata. Skill bodies remain main-process data until prompt preparation. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  /** Stable model-facing path in the managed library or an approved project/root. */
  path: string;
}

/** Provenance for a managed package; never part of the model-facing Skills catalog. */
export interface GitHubSkillOrigin {
  kind: 'github';
  url: string;
  ref: string;
  directory: string;
  commit: string;
  revision: string;
  skillSha256: string;
}

export interface ManagedSkill extends SkillSummary {
  origin: GitHubSkillOrigin | null;
}

/** Read-only GitHub observation, scoped to the installed package revision it checked. */
export interface GitHubSkillUpdateCheck {
  id: string;
  originRevision: string;
  state: 'current' | 'available' | 'error';
  checkedAt: number;
  error?: string;
}

export interface GitHubSkillLocation {
  owner: string;
  repository: string;
  ref: string | null;
  directory: string;
}

const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_SEGMENT = /^[^\\/:*?"<>|\u0000-\u001f]+$/;

/** Accept a public repository root, a tree folder, or a blob link to SKILL.md. */
export function parseGitHubSkillUrl(input: string): GitHubSkillLocation {
  if (input.length > 2048) throw new Error('GitHub skill URL is too long');
  if (/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(input)) throw new Error('GitHub skill URL contains an unsafe path');
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error('Enter a GitHub skill folder or SKILL.md link'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash)
    throw new Error('Use a public https://github.com skill link without query parameters');
  let parts: string[];
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error('GitHub skill URL has invalid encoding'); }
  if (parts.length < 2 || !GITHUB_NAME.test(parts[0]!) || !GITHUB_NAME.test(parts[1]!) || parts[1] === '.' || parts[1] === '..')
    throw new Error('GitHub skill URL needs an owner and repository');
  if (parts.some(part => part === '.' || part === '..' || !SAFE_SEGMENT.test(part) || /[. ]$/.test(part)))
    throw new Error('GitHub skill URL contains an unsafe path');
  const [owner, repository, kind, ref, ...remainder] = parts;
  if (kind === undefined) return { owner: owner!, repository: repository!, ref: null, directory: '' };
  if (!['tree', 'blob'].includes(kind) || !ref) throw new Error('Use a GitHub folder or SKILL.md link');
  if (kind === 'blob') {
    if (remainder.at(-1) !== 'SKILL.md') throw new Error('The GitHub file link must point to SKILL.md');
    remainder.pop();
  }
  return { owner: owner!, repository: repository!, ref, directory: remainder.join('/') };
}

export function githubSkillUrl(location: GitHubSkillLocation & { ref: string }): string {
  const path = location.directory ? `/${location.directory.split('/').map(encodeURIComponent).join('/')}` : '';
  return `https://github.com/${location.owner}/${location.repository}/tree/${encodeURIComponent(location.ref)}${path}`;
}

export function validGitHubSkillOrigin(value: unknown): value is GitHubSkillOrigin {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<GitHubSkillOrigin>;
  if (source.kind !== 'github' || typeof source.url !== 'string' || typeof source.ref !== 'string' ||
      typeof source.directory !== 'string' || !/^[a-f0-9]{40,64}$/.test(source.commit ?? '') ||
      !/^[a-f0-9]{64}$/.test(source.revision ?? '') || !/^[a-f0-9]{64}$/.test(source.skillSha256 ?? '')) return false;
  try {
    const location = parseGitHubSkillUrl(source.url);
    return location.ref === source.ref && location.directory === source.directory &&
      githubSkillUrl({ ...location, ref: source.ref }) === source.url;
  } catch { return false; }
}

export type SkillScope = 'managed' | 'repo' | 'user' | 'system' | 'admin';
export type SkillSource = 'managed' | 'repo-agents' | 'project-codex' | 'user-agents' | 'codex-home' | 'bundled' | 'admin';
export interface SkillMetadata {
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  allowImplicitInvocation: boolean;
  /** Descriptive only: these declarations never register tools or enable plugins. */
  dependencies?: Array<{ type: string; value: string; description?: string }>;
}
export interface LibrarySkill extends SkillSummary, SkillMetadata {
  scope: SkillScope;
  source: SkillSource;
  managed: boolean;
}
export interface SkillLibrary {
  skills: LibrarySkill[];
  errors: string[];
  roots: Array<{ path: string; scope: SkillScope; source: SkillSource }>;
  includeInstructions: boolean;
  maxContextTokens?: number;
}
export interface SkillsDraftScope { sessionId?: string | null; projectId?: string | null }

export const MAX_SKILLS = 64;
export const SKILL_ORIGIN_FILENAME = '.cos-github.json';
export const MAX_SKILL_BYTES = 128_000;
export const MAX_SKILL_CHARS = 96_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
