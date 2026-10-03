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
  'that', 'the', 'this', 'to', 'with', 'your', 'my', 'please', 'task', 'work', 'use',
  'any', 'before', 'component', 'does', 'help', 'react', 'user', 'using', 'want', 'when', 'why'
]);

function normalizedToken(value: string): string {
  let token = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  if (STOP.has(token)) return '';
  const undouble = (stem: string): string => {
    const last = stem.at(-1), prior = stem.at(-2);
    return last && last === prior && !/[aeiou]/.test(last) ? stem.slice(0, -1) : stem;
  };
  if (token.length >= 7 && token.endsWith('ing')) token = undouble(token.slice(0, -3));
  else if (token.length >= 6 && token.endsWith('ed')) token = undouble(token.slice(0, -2));
  else if (token.length >= 6 && token.endsWith('er')) token = undouble(token.slice(0, -2));
  else if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) token = token.slice(0, -1);
  if (STOP.has(token)) return '';
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
  const identityOverlap = identity.filter(token => text.has(token));
  const descriptiveOverlap = descriptive.filter(token => text.has(token));
  const score = identityOverlap.length * 3 + descriptiveOverlap.length;
  const exactIdentity = identity.length > 0 && identityOverlap.length === identity.length;
  // Description words alone never route a Skill. A complete name/id match is already explicit
  // enough; a partial identity match also needs supporting overlap from the description.
  return { score, strong: identityOverlap.length > 0 && (exactIdentity || descriptiveOverlap.length > 0) };
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
