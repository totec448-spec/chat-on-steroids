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

function normalizedParts(value: string): string[] {
  // Only hyphens and whitespace are interchangeable name separators. Keep other punctuation
  // as literal parts and preserve accents; NFC only reconciles equivalent Unicode spellings.
  return value.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}\s-]/gu) ?? [];
}

function containsPhrase(authored: readonly string[], phrase: readonly string[]): boolean {
  if (!phrase.length || phrase.length > authored.length) return false;
  outer: for (let start = 0; start <= authored.length - phrase.length; start += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (authored[start + offset] !== phrase[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function identityPhrases(candidate: SkillRoutingMetadata): string[][] {
  const seen = new Set<string>();
  const phrases: string[][] = [];
  for (const raw of [candidate.id, candidate.name, candidate.displayName ?? '']) {
    const phrase = normalizedParts(raw);
    if (!phrase.length) continue;
    const key = phrase.join('\u0000');
    if (!seen.has(key)) { seen.add(key); phrases.push(phrase); }
    // Maintainer-suggested literal naming convention: `using-git-worktrees` may be invoked as
    // "use git worktrees". Keep the complete suffix contiguous; this is not general stemming.
    if (phrase.length > 1 && phrase[0] === 'using') {
      const alias = ['use', ...phrase.slice(1)];
      const aliasKey = alias.join('\u0000');
      if (!seen.has(aliasKey)) { seen.add(aliasKey); phrases.push(alias); }
    }
  }
  return phrases;
}

function namesSkill(authored: readonly string[], candidate: SkillRoutingMetadata): boolean {
  return identityPhrases(candidate).some(phrase => containsPhrase(authored, phrase));
}

/** Avoid picking a Skill from generic instruction boilerplate shared by most descriptions. */
const TASK_STOPWORDS = new Set(('a an and are as at be before but by can do does for from help how i in into is it me ' +
  'my of on or our please that the their these this to use using was we when where which while with you your ' +
  'any all after also should must will would could then than over under more make making get getting ' +
  'task tasks skill skills work working user users need needs about without if its one not').split(' '));

/** Case-preserving-accent tokens; light English plural/gerund folding, no translation or embeddings. */
function taskWords(value: string): string[] {
  const words = value.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return words.map(word => {
    if (!/^[a-z]+$/.test(word) || word.length < 5) return word;
    if (word.endsWith('ies') && word.length > 5) return `${word.slice(0, -3)}y`;
    if (word.endsWith('ing') && word.length > 6) {
      let stem = word.slice(0, -3);
      if (/([bdfgklmnprst])\1$/.test(stem)) stem = stem.slice(0, -1);
      return stem;
    }
    if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
  }).filter(word => word.length >= 3 && !TASK_STOPWORDS.has(word));
}

function phraseEvidence(words: readonly string[]): Set<string> {
  return new Set(words.slice(1).map((word, i) => `${words[i]}\0${word}`));
}

/** Conservative task-description evidence: at least three shared terms and an ordered pair.
 * A close second place means the metadata alone cannot make a responsible selection.
 */
function taskMatch(authored: string, candidates: readonly SkillRoutingMetadata[]): RoutedSkillSelection[] {
  // User-provided code/quotes are context, not instructions to run a named Skill.
  const prose = authored.slice(0, 2048).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const task = taskWords(prose);
  if (new Set(task).size < 3) return [];
  const taskSet = new Set(task), taskPairs = phraseEvidence(task);
  const ranked = candidates.filter(candidate => candidate.allowImplicitInvocation).map(candidate => {
    const fields = [candidate.id, candidate.name, candidate.displayName ?? '', candidate.description,
      candidate.shortDescription ?? ''];
    const words = fields.map(taskWords);
    const terms = new Set(words.flat());
    const matches = [...taskSet].filter(word => terms.has(word)).length;
    const pairs = new Set(words.flatMap(field => [...phraseEvidence(field)]));
    const paired = [...taskPairs].filter(pair => pairs.has(pair)).length;
    return { candidate, score: matches >= 3 && paired >= 1 ? matches + paired * 2 : 0 };
  }).sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  if (!winner || winner.score < 5 || winner.score - (ranked[1]?.score ?? 0) < 2) return [];
  return [{ id: winner.candidate.id, revision: winner.candidate.revision }];
}
/** Pure exact-name metadata routing. Ambiguity intentionally produces no automatic selection. */
export function routeSkillMetadata(authored: string, candidates: readonly SkillRoutingMetadata[], mode: 'exact' | 'task' = 'exact'): RoutedSkillSelection[] {
  const text = normalizedParts(authored);
  if (!text.length) return [];
  const named = candidates.filter(candidate => namesSkill(text, candidate));
  // A named but disallowed Skill is not permission to silently choose a different one.
  if (named.length) {
    if (named.length !== 1 || !named[0]!.allowImplicitInvocation) return [];
    return [{ id: named[0]!.id, revision: named[0]!.revision }].slice(0, MAX_AUTO_SELECTED_SKILLS);
  }
  return mode === 'task' ? taskMatch(authored, candidates) : [];
}
