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

const wordStart = /^[\p{L}\p{M}\p{N}]/u;
const wordEnd = /[\p{L}\p{M}\p{N}]$/u;
// Japanese particles can touch a complete name. Do not split arbitrary compounds such as
// コードレビュー支援, or English words such as code-reviewer, into shorter Skill names.
const particleBefore = /(?:ではなく|じゃなく|から|なら|では|には|とは|を|で|に|は|が|と|も|の|へ)$/u;
const particleAfter = /^(?:から|なら|では|には|とは|を|で|に|は|が|と|も|の|へ)/u;

function phrasePattern(phrase: readonly string[]): RegExp {
  let pattern = '';
  for (let index = 0; index < phrase.length; index += 1) {
    const part = phrase[index]!;
    if (index) {
      const previous = phrase[index - 1]!;
      // Two word parts still need a separator: CodeReview is not Code Review. Literal
      // punctuation, as in C++ Review, retains the existing whitespace/hyphen normalization.
      pattern += wordEnd.test(previous) && wordStart.test(part) ? '[\\s-]+' : '[\\s-]*';
    }
    pattern += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern, 'gu');
}

function literalBoundary(before: string, after: string): boolean {
  // Internal hyphens normalize like spaces; an adjoining hyphenated word outside the
  // complete name is a different, longer identity (pre-code-review/code-review-helper).
  if (/[\p{L}\p{M}\p{N}]-+$/u.test(before) || /^-+[\p{L}\p{M}\p{N}]/u.test(after)) return false;
  return (!wordEnd.test(before) || particleBefore.test(before)) &&
    (!wordStart.test(after) || particleAfter.test(after));
}

function directlyExcluded(before: string, after: string): boolean {
  // Recognize direct exclusions next to this name, not unrelated negation elsewhere in the
  // task ("use Code Review to check why tests do not pass") or a semantic topic classifier.
  const englishBefore = /(?:\b(?:do\s+not|don['’]t|never)\s+(?:use|invoke|run|apply|select)|\bavoid\s+(?:using|invoking|running|applying|selecting)|\bwithout(?:\s+(?:using|invoking|running|applying|selecting))?)\s+(?:the\s+)?[\s"'`「『(]*$/u;
  const japaneseAfter = /^[\s"'`」』)]*(?:(?:には|だけは|だけを|は|を|も)\s*)?(?:使わ(?:ない|ず|なく)|使うな|使って(?:は)?いけない|(?:使用|利用|適用|実行|選択)(?:し(?:ない|ません|なく)|せず|するな)|呼び出さ(?:ない|ず|なく)|不要|禁止)|^[\s"'`」』)]*(?:では|じゃ)なく/u;
  const englishAfter = /^[\s"'`」』)]*(?:(?:should|must|will|can)\s+not\s+be\s+(?:used|invoked|run|applied|selected)\b|(?:is|are)\s+(?:not\s+(?:needed|required)|forbidden)\b)/u;
  return englishBefore.test(before) || japaneseAfter.test(after) || englishAfter.test(after);
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

interface SkillMention { id: string; start: number; end: number; excluded: boolean }

function skillMentions(authored: string, candidate: SkillRoutingMetadata): SkillMention[] {
  const mentions: SkillMention[] = [];
  for (const phrase of identityPhrases(candidate)) {
    for (const match of authored.matchAll(phrasePattern(phrase))) {
      const before = authored.slice(0, match.index), after = authored.slice(match.index + match[0].length);
      if (!literalBoundary(before, after)) continue;
      mentions.push({ id: candidate.id, start: match.index, end: match.index + match[0].length,
        excluded: directlyExcluded(before, after) });
    }
  }
  return mentions;
}

function namedSkills(authored: string, candidates: readonly SkillRoutingMetadata[]): Set<string> {
  const mentions = candidates.flatMap(candidate => skillMentions(authored, candidate))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  // Overlapping aliases still describe one mention. Keep different candidate ids so name
  // collisions remain ambiguous rather than choosing the first candidate in catalog order.
  const groups: { start: number; end: number; mentions: SkillMention[] }[] = [];
  for (const mention of mentions) {
    const previous = groups.at(-1);
    if (previous && mention.start < previous.end) {
      previous.end = Math.max(previous.end, mention.end);
      previous.mentions.push(mention);
    } else groups.push({ start: mention.start, end: mention.end, mentions: [mention] });
  }
  const included = new Set<string>(), excluded = new Set<string>();
  const listJoin = /^[\s"'`「」『』()]*(?:,(?:\s*(?:and|or))?|and(?:\/or)?|or|[、とやも/&]|または)[\s"'`「」『』()]*$/u;
  for (let start = 0; start < groups.length;) {
    let end = start + 1;
    while (end < groups.length && listJoin.test(authored.slice(groups[end - 1]!.end, groups[end]!.start))) end += 1;
    const list = groups.slice(start, end).flatMap(group => group.mentions);
    // A direct exclusion applies to a coordinated list in either direction: "don't use A
    // or B", "AとBは使わない". A new invocation clause does not inherit that exclusion.
    const destination = list.some(mention => mention.excluded) ? excluded : included;
    for (const mention of list) destination.add(mention.id);
    start = end;
  }
  // Conflicting mentions do not authorize automatic invocation. Explicit /id directives
  // retain their precedence at the existing input-owner boundary.
  for (const id of excluded) included.delete(id);
  return included;
}

/** Pure exact-name metadata routing. Ambiguity intentionally produces no automatic selection. */
export function routeSkillMetadata(authored: string, candidates: readonly SkillRoutingMetadata[]): RoutedSkillSelection[] {
  const text = authored.normalize('NFC').toLowerCase();
  if (!text.length) return [];
  const named = namedSkills(text, candidates);
  const matched = candidates
    .filter(candidate => candidate.allowImplicitInvocation)
    .filter(candidate => named.has(candidate.id));
  if (matched.length !== 1) return [];
  return [{ id: matched[0]!.id, revision: matched[0]!.revision }].slice(0, MAX_AUTO_SELECTED_SKILLS);
}
