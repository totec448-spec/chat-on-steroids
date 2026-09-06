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
  limits: ModelUsage[];
  days: Array<{ date: string; tokens: number; models: UsageModelTokens[] }>;
  models: UsageModelTokens[];
  tokens: number;
  sessions: number;
}
export interface UsageFormula {
  divisor: number;
  multiplier: number;
  rates: Record<string, number | null>;
}
// Standard short-context cached-input comparison rates verified 2026-09-06.
// GPT-6 Pro is ChatGPT's Astra label; Astra cached input is $1 per million tokens.
// Sources are linked next to the editable formula and in usage-model-attribution.md.
export const DEFAULT_USAGE_FORMULA: UsageFormula = {
  divisor: 2, multiplier: 1.2,
  rates: { 'gpt-5.6': 0.4, 'gpt-5.6-sol': 0.4, 'gpt-6-astra': 1, 'gpt-6-pro': 1, 'gpt-5.5': 0.5 }
};
export function usageModelKey(row: Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>): string {
  return JSON.stringify([row.model, row.reasoningEffort, row.assumed]);
}
/** Cache stores the baseline /2 estimate; formula edits are a cheap projection, never a transcript reread. */
export function usageEstimate(rows: readonly UsageModelTokens[], formula: UsageFormula): { tokens: number; cost: number; unpricedTokens: number } {
  let tokens = 0, cost = 0, unpricedTokens = 0;
  for (const row of rows) {
    const amount = row.tokens * 2 / formula.divisor;
    tokens += amount;
    const rate = formula.rates[row.model];
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) cost += amount / 1e6 * rate * formula.multiplier;
    else unpricedTokens += amount;
  }
  return { tokens, cost, unpricedTokens };
}
