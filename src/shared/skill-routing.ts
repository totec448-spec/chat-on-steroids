export interface SkillRoutingMetadata {
  id: string;
  revision: string;
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  allowImplicitInvocation: boolean;
}

export interface RoutedSkillSelection { id: string; revision: string }

export const MAX_AUTO_SELECTED_SKILLS = 1;

const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'with', 'your', 'my', 'please', 'task', 'work', 'use'
]);

function normalizedToken(value: string): string {
  const token = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokens(value: string): string[] {
  return [...new Set((value.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalizedToken)
    .filter(token => token.length >= 3 && !STOP.has(token)))];
}

function score(text: Set<string>, candidate: SkillRoutingMetadata): { score: number; strong: boolean } {
  const identity = tokens([candidate.id.replace(/[-_.]+/g, ' '), candidate.name, candidate.displayName ?? ''].join(' '));
  const descriptive = tokens([candidate.description, candidate.shortDescription ?? ''].join(' '));
  const all = new Set([...identity, ...descriptive]);
  const overlap = [...all].filter(token => text.has(token));
  const identityOverlap = identity.filter(token => text.has(token));
  const score = overlap.length + identityOverlap.length * 2;
  const exactIdentity = identity.length >= 2 && identity.every(token => text.has(token));
  // One generic word never routes a Skill. Require either the complete multi-word identity or
  // at least three distinct metadata terms from the authored task.
  return { score, strong: exactIdentity || overlap.length >= 3 };
}

/** Pure metadata-only routing. A close second candidate makes the result intentionally empty. */
export function routeSkillMetadata(authored: string, candidates: readonly SkillRoutingMetadata[]): RoutedSkillSelection[] {
  const text = new Set(tokens(authored));
  if (text.size === 0) return [];
  const ranked = candidates
    .filter(candidate => candidate.allowImplicitInvocation)
    .map(candidate => ({ id: candidate.id, revision: candidate.revision, ...score(text, candidate) }))
    .filter(candidate => candidate.strong)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (!ranked.length) return [];
  if (ranked[1] && ranked[0]!.score - ranked[1].score < 2) return [];
  return [{ id: ranked[0]!.id, revision: ranked[0]!.revision }].slice(0, MAX_AUTO_SELECTED_SKILLS);
}
