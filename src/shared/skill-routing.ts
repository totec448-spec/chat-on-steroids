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

/** Pure exact-name metadata routing. Ambiguity intentionally produces no automatic selection. */
export function routeSkillMetadata(authored: string, candidates: readonly SkillRoutingMetadata[]): RoutedSkillSelection[] {
  const text = normalizedParts(authored);
  if (!text.length) return [];
  const matched = candidates
    .filter(candidate => candidate.allowImplicitInvocation)
    .filter(candidate => namesSkill(text, candidate));
  if (matched.length !== 1) return [];
  return [{ id: matched[0]!.id, revision: matched[0]!.revision }].slice(0, MAX_AUTO_SELECTED_SKILLS);
}
