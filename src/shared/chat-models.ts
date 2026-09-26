import type { ReasoningEffort } from './session.js';
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|(?:gpt-?)?6(?:\.0)?-(?:pro|astra))$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[] };
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
