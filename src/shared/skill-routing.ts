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

// These words still help describe a task, but alone cannot identify a specialized Skill.
// Normalize this vocabulary through the same stemmer so "testing" cannot evade "test".
const COMMON_IDENTITY = new Set(tokens(
  'add analyze analyzing build change check checking code create creating data debug debugging ' +
  'design develop development execute executing export feature file fix function git implement ' +
  'implementation input inspect manage message output plan planning plugin process profile profiling ' +
  'project read receive receiving refactor request review script source state store system systematic ' +
  'table test testing tool update user web workflow write'
));

function score(text: Set<string>, candidate: SkillRoutingMetadata): { score: number; strong: boolean } {
  const names = [candidate.id, candidate.name, candidate.displayName ?? ''].map(tokens);
  const identity = [...new Set(names.flat())];
  const descriptive = tokens([candidate.description, candidate.shortDescription ?? ''].join(' '));
  const identityOverlap = identity.filter(token => text.has(token));
  // Repeating the same name word in the description is not a second piece of evidence.
  const descriptiveOverlap = descriptive.filter(token => text.has(token) && !identity.includes(token));
  const score = identityOverlap.length * 3 + descriptiveOverlap.length;
  const distinctiveIdentity = identityOverlap.some(token => !COMMON_IDENTITY.has(token));
  const fullName = names.some(name => name.length > 1 && name.every(token => text.has(token)));
  // A generic word such as "test" must not select testing-dags. Prefer no injection unless a
  // distinctive identity (or a complete multiword name) AND separate description support agree.
  return { score, strong: (distinctiveIdentity || fullName) && descriptiveOverlap.length > 0 };
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
