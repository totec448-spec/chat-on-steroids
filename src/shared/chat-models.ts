import type { ReasoningEffort } from './session.js';
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|(?:gpt-?)?6(?:\.0)?-(?:pro|astra))$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[];
  /** Native captions are presentation only: e.g. max may be labelled Extra High. */
  effortLabels?: Partial<Record<ReasoningEffort, string>> };
/** Disambiguate the shell's numeric captions without rewriting execution identities. */
export function chatModelName(model: ChatModelOption): string {
  if (!/^\d+(?:\.\d+)*$/.test(model.label)) return model.label;
  const lane = /-pro$/i.test(model.id) ? 'Pro' : /-thinking$/i.test(model.id) ? 'Thinking'
    : model.efforts.length === 1 && model.efforts[0] === 'none' ? 'Instant' : '';
  return `GPT-${model.label}${lane ? ` ${lane}` : ''}`;
}
/** Pro silence policy follows the selected provider identity, including the older generation. */
export function isProModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return effort === 'pro' || isAstraModel(model, effort) || /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
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
