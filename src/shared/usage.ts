export interface ModelUsage {
  model: string;
  scope: 'model' | 'feature' | 'shared';
  remaining: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  windowSeconds: number | null;
  observedAt: number;
}
export interface UsageModelTokens {
  model: string;
  reasoningEffort: string | null;
  /** Legacy rows with no recorded model use GPT-5.6 High, visibly marked as assumed. */
  assumed: boolean;
  tokens: number;
}
export interface UsageOverview {
  /** Account-wide comparison ceiling selected from the observed model catalog. */
  contextTokenCap: number;
  /** Verified native sends, independently of token estimates or provider quotas. */
  messages: { through: number; days: UsageMessageDay[] };
  limits: ModelUsage[];
  days: Array<{ date: string; tokens: number; models: UsageModelTokens[] }>;
  models: UsageModelTokens[];
  tokens: number;
  sessions: number;
}

export interface UsageMessageDay { date: string; gpt56: number; gpt6: number }
export type UsageMessageFamily = 'gpt-5.6' | 'gpt-6';

/** Explicit recorded version identities only; unknown suffixes remain unclassified. */
export function usageMessageFamily(model: string | undefined): UsageMessageFamily | null {
  const id = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (/^(?:gpt-?)?5[.-]6(?:-(?:thinking|pro|sol|terra|luna))?$/.test(id) || id === 'sol') return 'gpt-5.6';
  if (/^(?:gpt-?)?6(?:\.0)?(?:-(?:pro|astra))?$/.test(id) || id === 'astra') return 'gpt-6';
  return null;
}

export function usageDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Most recent selected weekday at local midnight, including today. Calendar days preserve DST. */
export function usageWeekStart(weekday: number, through: number): number {
  const date = new Date(through);
  date.setDate(date.getDate() - (date.getDay() - weekday + 7) % 7);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function usageMessageTotals(messages: UsageOverview['messages'], weekday: number): UsageMessageDay {
  const from = usageDateKey(new Date(usageWeekStart(weekday, messages.through)));
  const through = usageDateKey(new Date(messages.through));
  return messages.days.reduce((total, day) => day.date >= from && day.date <= through
    ? { ...total, gpt56: total.gpt56 + day.gpt56, gpt6: total.gpt6 + day.gpt6 } : total,
  { date: from, gpt56: 0, gpt6: 0 });
}
export interface UsageFormula {
  divisor: number;
  multiplier: number;
  rates: Record<string, number | null>;
}
// Standard short-context cached-input comparison rates verified 2026-09-07.
// GPT-6 Pro is ChatGPT's Astra label; Astra cached input is $1 per million tokens.
// Sources are linked next to the editable formula and in usage-model-attribution.md.
export const DEFAULT_USAGE_FORMULA: UsageFormula = {
  divisor: 2, multiplier: 1.2,
  rates: { 'gpt-5.6': 0.4, 'gpt-5.6-sol': 0.4, 'gpt-5.6-terra': 0.2, 'gpt-5.6-luna': 0.02, 'gpt-6-astra': 1, 'gpt-6-pro': 1, 'gpt-5.5': 0.5 }
};
// Exact historical/provider identities only. This is a reporting projection, not
// account availability or browser selection authority. Effort remains independent.
const usageAliases: Readonly<Record<string, string>> = {
  '5.6': 'gpt-5.6-sol', 'gpt-5.6': 'gpt-5.6-sol', 'gpt-5-6': 'gpt-5.6-sol',
  'gpt-5-6-thinking': 'gpt-5.6-sol', 'gpt-5-6-pro': 'gpt-5.6-sol',
  '6': 'gpt-6-astra', 'gpt-6-pro': 'gpt-6-astra'
};
export function usageModel(model: string): string { return Object.hasOwn(usageAliases, model) ? usageAliases[model]! : model; }
/** Group the display while retaining each raw source for its exact manual rate. */
export function usageModelGroups(rows: readonly UsageModelTokens[]): Array<{ model: string; reasoningEffort: string | null; assumed: boolean; sources: UsageModelTokens[] }> {
  const groups = new Map<string, { model: string; reasoningEffort: string | null; assumed: boolean; sources: UsageModelTokens[] }>();
  for (const row of rows) {
    const identity = { model: usageModel(row.model), reasoningEffort: row.reasoningEffort, assumed: row.assumed };
    const key = usageModelKey(identity);
    const group = groups.get(key) ?? { ...identity, sources: [] };
    group.sources.push(row); groups.set(key, group);
  }
  return [...groups.values()];
}
/** Explicit per-recorded-ID rates, including zero/null, override equivalent-model defaults. */
export function usageRate(model: string, formula: UsageFormula): number | null | undefined {
  if (Object.hasOwn(formula.rates, model)) return formula.rates[model];
  const canonical = usageModel(model);
  return Object.hasOwn(formula.rates, canonical) ? formula.rates[canonical] : undefined;
}
export function usageModelKey(row: Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>): string {
  return JSON.stringify([row.model, row.reasoningEffort, row.assumed]);
}
/** Cache stores the baseline /2 estimate; formula edits are a cheap projection, never a transcript reread. */
export function usageEstimate(rows: readonly UsageModelTokens[], formula: UsageFormula): { tokens: number; cost: number; unpricedTokens: number } {
  let tokens = 0, cost = 0, unpricedTokens = 0;
  for (const row of rows) {
    const amount = row.tokens * 2 / formula.divisor;
    tokens += amount;
    const rate = usageRate(row.model, formula);
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) cost += amount / 1e6 * rate * formula.multiplier;
    else unpricedTokens += amount;
  }
  return { tokens, cost, unpricedTokens };
}
