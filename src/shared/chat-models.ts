import type { ReasoningEffort } from './session.js';
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|(?:gpt-?)?6(?:\.0)?-(?:pro|astra))$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[] };
/**
 * The ChatGPT model Goal and Loop decisions run on unless Settings chose another. ChatGPT lists GPT-6
 * as two lanes, `gpt-6` (Instant, ChatGPT's automatic lane) and `gpt-6-thinking` (Medium, High); a decision wants the thinking
 * lane. An account without it falls back to ChatGPT's current selection (goal.ts).
 */
export const DEFAULT_HELPER_CHAT_MODEL = 'gpt-6-thinking';
/** The shipped default before GPT-6; a config still holding exactly this adopts the current one (config.ts). */
export const SUPERSEDED_HELPER_CHAT_MODELS: readonly string[] = ['gpt-5.6-sol'];
/** Pro silence policy follows the selected provider identity, including the older generation. */
export function isProModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return effort === 'pro' || isAstraModel(model, effort) || /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
}
/**
 * Whether this reasoning effort makes long silences normal.
 *
 * A model above `high` routinely goes minutes without touching the page between tool calls, and
 * the silence watchdog's two-minute window reads that as a dead tab. Pro is excluded here only
 * because it already has its own, wider window; `isProModel` covers it.
 *
 * `high` is deliberately **not** in this list. It is the ordinary effort for the current models —
 * the whole bridge suite uses it as the plain non-Pro case — and widening it would make a
 * genuinely dead page wait ten minutes instead of two. The harm this exists for was measured at
 * Extra high (#393): "An Extra-high turn that thinks longer than that between tool calls".
 *
 * Deliberately not "anything above medium as a number" either: the list is the vocabulary in
 * REASONING_EFFORTS, so a level added there has to be classified here on purpose rather than
 * inheriting a threshold nobody revisited.
 */
export function isDeliberateEffort(effort?: ReasoningEffort | null): boolean {
  return effort === 'xhigh' || effort === 'max' || effort === 'ultra';
}
const normalizeChatModelName = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '');
/**
 * Resolve a saved model value to one observed catalog entry.
 *
 * An exact execution id or lane alias wins. Otherwise a unique display-label match
 * resolves — settings saved before lanes had catalog ids, and labels the picker itself
 * shows (family "6" for gpt-6-pro), must round-trip or every saved default silently
 * falls back. An ambiguous label resolves to nothing: guessing a lane is not a
 * rounding decision.
 */
export function resolveChatModel(models: ChatModelOption[], value: string): ChatModelOption | undefined {
  const exact = models.filter(choice => choice.id === value || choice.aliases?.includes(value));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const name = normalizeChatModelName(value);
  const matches = name ? models.filter(choice => normalizeChatModelName(choice.label) === name) : [];
  return matches.length === 1 ? matches[0] : undefined;
}
/** Keep the selected generation intact; Pro is already a complete model label. */
export function chatModelDisplayLabel(label: string, effort: ReasoningEffort, effortLabel: string): string {
  if (effort === 'pro') return /\bpro$/i.test(label) ? label : `${label.replace(/\s+Sol$/i, '')} Pro`;
  return `${label} · ${effortLabel}`;
}
export type ChatModelCatalog = {
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: ChatModelOption[];
  /** Request progress is not an account observation and never grants Send permission. */
  waiting?: string;
  error?: string;
};
