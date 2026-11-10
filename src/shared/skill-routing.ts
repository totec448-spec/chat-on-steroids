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
// Finite English/Japanese vocabulary, not a general language parser. Discuss additional
// languages or phrasings in an issue first, as requested in the review of #2123.
// Japanese particles can touch a complete name. Do not split arbitrary compounds such as
// コードレビュー支援, or English words such as code-reviewer, into shorter Skill names.
const particles = /から|なら|では|には|とは|を|で|に|は|が|と|も|の|へ/u;
const particleBefore = new RegExp(`(?:ではなく|じゃなく|${particles.source})$`, 'u');
const particleAfter = new RegExp(`^(?:${particles.source})`, 'u');

// Keep all three forms together so prefix, verb-leading names and passive exclusions agree.
const usageVerbs = [
  ['use', 'using', 'used'], ['invoke', 'invoking', 'invoked'], ['run', 'running', 'run'],
  ['apply', 'applying', 'applied'], ['select', 'selecting', 'selected']
] as const;
const baseVerbs = new Set<string>(usageVerbs.map(([base]) => base));
const gerundVerbs = new Set<string>(usageVerbs.map(([, gerund]) => gerund));
const leadingUsageVerb = new RegExp(
  `^(${usageVerbs.flatMap(([base, gerund]) => [base, gerund]).join('|')})(?=[\\s-]|$)`, 'u');
const passiveVerbs = usageVerbs.map(([, , passive]) => passive).join('|');

const openingPadding = /[\s"'`「『(]/u;
const closingPadding = /[\s"'`」』)]*/u;
const japaneseExclusion = /(?:(?:には|だけは|だけを|は|を|も)\s*)?(?:使わ(?:ない|ず|なく)|使うな|使って(?:は)?いけない|(?:使用|利用|適用|実行|選択)(?:し(?:ない|ません|なく)|せず|するな)|呼び出さ(?:ない|ず|なく)|不要|禁止)|(?:では|じゃ)なく/u;
const englishExclusion = new RegExp(
  `(?:should|must|will|can)\\s+not\\s+be\\s+(?:${passiveVerbs})\\b|(?:is|are)\\s+(?:not\\s+(?:needed|required)|forbidden)\\b`, 'u');
const exclusionAfter = new RegExp(
  `^${closingPadding.source}(?:${japaneseExclusion.source}|${englishExclusion.source})`, 'u');
const listJoin = /^[\s"'`「」『』()]*(?:,(?:\s*(?:and|or))?|and(?:\/or)?|or|[、とやも/&]|または)[\s"'`「」『』()]*$/u;
const aliasClauseJoin = /^[\s"'`」』)]*[,、]\s*(?:and\s+)?["'`「『(]*$/u;

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

function literalBoundary(text: string, start: number, end: number): boolean {
  // Internal hyphens normalize like spaces; an adjoining hyphenated word outside the
  // complete name is a different, longer identity (pre-code-review/code-review-helper).
  let left = start, right = end;
  while (left && text[left - 1] === '-') left -= 1;
  while (text[right] === '-') right += 1;
  if ((left < start && wordEnd.test(text.slice(Math.max(0, left - 2), left))) ||
    (right > end && wordStart.test(text.slice(right, right + 2)))) return false;
  // Only the adjoining code point/particle can establish a boundary, not an ever-growing
  // prefix. Two UTF-16 units retain supplementary characters; eight cover every particle.
  const before = text.slice(Math.max(0, start - 8), start), after = text.slice(end, end + 8);
  return (!wordEnd.test(before) || particleBefore.test(before)) &&
    (!wordStart.test(after) || particleAfter.test(after));
}

function englishExclusionBefore(text: string, start: number, end: number): boolean {
  let cursor = start;
  while (cursor && openingPadding.test(text[cursor - 1]!)) cursor -= 1;
  // Inspect a fixed number of adjoining words. Do not run a suffix regex over the whole prefix
  // for every repeated mention; whitespace between these few words is scanned only once.
  const word = (): string => {
    while (cursor && /\s/u.test(text[cursor - 1]!)) cursor -= 1;
    const wordEndIndex = cursor;
    while (cursor && /[a-z'’]/u.test(text[cursor - 1]!)) cursor -= 1;
    if (wordEnd.test(text.slice(Math.max(0, cursor - 2), cursor))) return '';
    return text.slice(cursor, wordEndIndex);
  };
  const excluded = (verb: string): boolean => {
    if (baseVerbs.has(verb)) {
      const negative = word();
      return negative === 'never' || negative === "don't" || negative === 'don’t' ||
        (negative === 'not' && word() === 'do');
    }
    if (gerundVerbs.has(verb)) {
      const negative = word();
      return negative === 'avoid' || negative === 'without';
    }
    return verb === 'without';
  };
  const preceding = cursor;
  let verb = word();
  if (verb === 'the') verb = word();
  if (excluded(verb)) return true;
  // In the supported "using X" → "use X" alias, the invocation verb is already part
  // of the mention. Also keep an external verb authoritative ("don't use Use Cases").
  cursor = preceding;
  const ownVerb = leadingUsageVerb.exec(text.slice(start, Math.min(end, start + 12)));
  return ownVerb ? excluded(ownVerb[1]!) : false;
}

function directlyExcluded(text: string, start: number, end: number): boolean {
  // These suffix checks are anchored at this mention; unlike a full-prefix search, they
  // stop at the next unrelated word. This is direct usage wording, not topic inference.
  return englishExclusionBefore(text, start, end) || exclusionAfter.test(text.slice(end));
}

function identityPhrases(candidate: SkillRoutingMetadata): { parts: string[]; invocationAlias: boolean }[] {
  const seen = new Set<string>();
  const phrases: { parts: string[]; invocationAlias: boolean }[] = [];
  for (const raw of [candidate.id, candidate.name, candidate.displayName ?? '']) {
    const phrase = normalizedParts(raw);
    if (!phrase.length) continue;
    const key = phrase.join('\u0000');
    if (!seen.has(key)) { seen.add(key); phrases.push({ parts: phrase, invocationAlias: false }); }
    // Maintainer-suggested literal naming convention: `using-git-worktrees` may be invoked as
    // "use git worktrees". Keep the complete suffix contiguous; this is not general stemming.
    if (phrase.length > 1 && phrase[0] === 'using') {
      const alias = ['use', ...phrase.slice(1)];
      const aliasKey = alias.join('\u0000');
      if (!seen.has(aliasKey)) { seen.add(aliasKey); phrases.push({ parts: alias, invocationAlias: true }); }
    }
  }
  return phrases;
}

interface SkillMention { id: string; start: number; end: number; excluded: boolean; invocationAlias: boolean }

function skillMentions(authored: string, candidate: SkillRoutingMetadata): SkillMention[] {
  const mentions: SkillMention[] = [];
  for (const { parts: phrase, invocationAlias } of identityPhrases(candidate)) {
    for (const match of authored.matchAll(phrasePattern(phrase))) {
      const start = match.index, end = start + match[0].length;
      if (!literalBoundary(authored, start, end)) continue;
      mentions.push({ id: candidate.id, start, end, excluded: directlyExcluded(authored, start, end),
        invocationAlias: invocationAlias && /^use\s/u.test(match[0]) });
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
  for (let start = 0; start < groups.length;) {
    let end = start + 1;
    while (end < groups.length) {
      const join = authored.slice(groups[end - 1]!.end, groups[end]!.start);
      if (!listJoin.test(join)) break;
      // A generated "use X" alias includes its invocation verb. After a comma (optionally
      // "and"), that starts a new clause, unlike a literal "Using X"/"Use Cases" list item.
      if (aliasClauseJoin.test(join) &&
        groups[end]!.mentions.some(mention => mention.invocationAlias)) break;
      end += 1;
    }
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
