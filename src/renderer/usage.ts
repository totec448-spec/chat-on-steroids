import { ui, t } from './i18n.js';
import { $, el, run } from './dom.js';
import { DEFAULT_USAGE_FORMULA, usageEstimate, usageModelGroups, usageRate, type UsageFormula, type UsageOverview } from '../shared/usage.js';
let snapshot: UsageOverview | null = null;
let loadGeneration = 0;
const FORMULA_KEY = 'usage-formula-v1';
let formula: UsageFormula = { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates } };
function saveFormula(): void {
  try { localStorage.setItem(FORMULA_KEY, JSON.stringify(formula)); } catch { /* Read-only storage still permits an in-memory comparison. */ }
}

const count = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const featureLabels: Record<string, string> = { deep_research: "Deep research", file_upload: "File uploads", paste_text_to_file: "Pasted text files", image_gen: "Image generation" };
function usageHint(node: HTMLElement, text: string | (() => string)): void {
  ui(node, 'data-usage-hint', typeof text === 'function' ? text : () => text);
  node.setAttribute('tabindex', '0');
  const hide = () => document.getElementById('usageTooltip')?.remove();
  const show = () => {
    hide();
    const tip = el('div', 'session-tooltip', node.dataset.usageHint ?? ''); tip.id = 'usageTooltip'; tip.setAttribute('role', 'tooltip');
    const bounds = node.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 290))}px`;
    tip.style.top = `${Math.max(8, bounds.top - 64)}px`;
    document.body.append(tip);
  };
  node.addEventListener('pointerenter', show); node.addEventListener('pointerleave', hide);
  node.addEventListener('focus', show); node.addEventListener('blur', hide);
  node.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
}
function dateKey(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
export async function refreshUsage(): Promise<void> {
  document.getElementById('usageTooltip')?.remove();
  const generation = ++loadGeneration;
  $('refreshUsage').setAttribute('disabled', '');
  const status = $('usageStatus');
  ui(status, 'textContent', () => snapshot ? t("Updating…") : t("Calculating recorded tool usage…"));
  status.setAttribute('role', 'status');
  try {
    const [value, catalog] = await Promise.all([run(window.api.getUsage()), run(window.api.getChatModels())]);
    if (generation !== loadGeneration) return;
    if (!value) { ui(status, 'textContent', () => t("Usage could not be loaded. Try Refresh.")); return; }
    snapshot = value;
    const summary = $('usageSummary'); summary.replaceChildren();
    for (const [label, number] of [['Processed tokens · est.', value.tokens], ['Peak daily tokens', Math.max(0, ...value.days.map((day) => day.tokens))], ['Conversations', value.sessions], ['Active days', value.days.filter((day) => day.tokens > 0).length]] as const) {
      const item = el('div'); item.dataset.usageMetric = label; usageHint(item, () => `${Math.round(number).toLocaleString()} ${t(label).toLowerCase()}`); item.append(el('strong', '', count.format(number)), el('span', '', () => t(label))); summary.append(item);
    }
    const limits = $('modelUsage'); limits.replaceChildren();
    const modelRows = value.limits.filter((row) => row.scope === 'model');
    const knownModels = catalog?.models ?? [];
    for (const model of knownModels.filter((item) => !modelRows.some((row) => row.model === item.id))) {
      const row = el('div', 'usage-limit'); row.append(el('strong', '', model.label), el('span', 'muted', () => t("Not reported by ChatGPT"))); limits.append(row);
    }
    for (const entry of [...modelRows, ...value.limits.filter((row) => row.scope !== 'model')]) {
      const stale = Date.now() - entry.observedAt > 10 * 60000 || (entry.resetAt !== null && entry.resetAt <= Date.now());
      const row = el('div', 'usage-limit');
      const featureLabel = featureLabels[entry.model];
      const displayName = () => entry.scope === 'feature' && featureLabel ? t(featureLabel) : entry.model;
      const name = el('div'); name.append(el('strong', '', displayName));
      if (entry.scope !== 'model') name.append(el('small', 'muted', () => entry.scope === 'shared' ? t("Shared usage pool") : t("Feature quota")));
      const detail = el('div');
      detail.append(el('b', '', () => stale ? t("Refresh needed") : entry.remaining !== null ? t("{0} remaining", [entry.remaining.toLocaleString()]) : entry.remainingPercent !== null ? t("{0}% remaining", [Math.round(entry.remainingPercent)]) : t("Not reported")));
      const window = () => entry.windowSeconds === 604800 ? t("Weekly · ") : entry.windowSeconds ? t("{0}h window · ", [Math.round(entry.windowSeconds / 3600)]) : '';
      detail.append(el('small', 'muted', () => window() + (entry.resetAt ? t("Resets {0}", [new Date(entry.resetAt).toLocaleString()]) : t("Reset not reported"))));
      if (entry.remainingPercent !== null && !stale) { const progress = document.createElement('progress'); progress.max = 100; progress.value = entry.remainingPercent; ui(progress, 'aria-label', () => t("{0}: {1}% remaining", [displayName(), entry.remainingPercent])); detail.append(progress); }
      row.append(name, detail); limits.append(row);
    }
    if (!modelRows.length) limits.append(el('p', 'muted', () => t("ChatGPT has not reported per-model message balances. Shared usage and feature quotas do not establish a model-specific balance.")));
    const totalCost = el('div'); totalCost.append(el('strong', '', '—'), el('span', '', () => t("Estimated equivalent · USD"))); totalCost.id = 'usageTotalCost'; usageHint(totalCost, ''); summary.prepend(totalCost);
    paintRates();
    paintCost();
    ui(status, 'textContent', () => t("Recorded model attribution; missing history assumes GPT-5.6 High. Unchanged recordings reuse saved totals."));
  } finally { if (generation === loadGeneration) $('refreshUsage').removeAttribute('disabled'); }
}
function paintRates(): void {
  if (!snapshot) return;
  const host = $('usageRates'); host.replaceChildren();
  for (const model of [...new Set(snapshot.models.map(row => row.model))].sort()) {
    const label = el('label', 'setting'); const text = el('span', 'setting-text');
    text.append(el('b', '', model), el('em', '', () => usageRate(model, DEFAULT_USAGE_FORMULA) !== undefined ? t("USD / 1M cached input · editable official baseline, checked 7 September 2026") : t("USD / 1M cached input · enter a verified comparison rate")));
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = '0.01'; ui(input, 'placeholder', () => t("Unknown rate")); input.value = usageRate(model, formula)?.toString() ?? '';
    ui(input, 'aria-label', () => t("{0} cached-input USD per million tokens", [model]));
    input.addEventListener('input', () => {
      if (input.value === '') formula.rates[model] = null;
      else if (input.validity.valid && Number.isFinite(input.valueAsNumber)) formula.rates[model] = input.valueAsNumber;
      else return;
      saveFormula(); paintCost();
    });
    label.append(text, input); host.append(label);
  }
}
function paintCost(): void {
  if (!snapshot) return;
  const total = usageEstimate(snapshot.models, formula);
  const costText = (estimate: ReturnType<typeof usageEstimate>) => estimate.unpricedTokens > 0 ? t("{0} + unpriced", [money.format(estimate.cost)]) : money.format(estimate.cost);
  const costSummary = document.getElementById('usageTotalCost');
  if (costSummary) {
    ui(costSummary.querySelector('strong')!, 'textContent', () => costText(total));
    ui(costSummary, 'data-usage-hint', () => t('{0} estimated tokens; {1} have no comparison rate. Cached-input equivalent, not a bill.', [Math.round(total.tokens).toLocaleString(), Math.round(total.unpricedTokens).toLocaleString()]));
  }
  const daily = snapshot.days.map(day => ({ ...day, ...usageEstimate(day.models, formula) }));
  for (const [label, number] of [['Processed tokens · est.', total.tokens], ['Peak daily tokens', Math.max(0, ...daily.map(day => day.tokens))]] as const) {
    const item = [...$('usageSummary').children].find(node => (node as HTMLElement).dataset.usageMetric === label) as HTMLElement | undefined;
    if (item) { item.querySelector('strong')!.textContent = count.format(number); ui(item, 'data-usage-hint', () => `${Math.round(number).toLocaleString()} ${t(label).toLowerCase()}`); }
  }
  const heat = $('usageHeatmap'); heat.replaceChildren();
  const byDay = new Map(daily.map(day => [day.date, day.tokens])); const peak = Math.max(1, ...daily.map(day => day.tokens));
  for (let ago = 363; ago >= 0; ago--) {
    const date = new Date(); date.setDate(date.getDate() - ago); const key = dateKey(date), tokens = byDay.get(key) ?? 0;
    const cell = el('span', 'heat-cell'); cell.dataset.level = String(tokens ? Math.max(1, Math.ceil(tokens / peak * 4)) : 0); const hint = () => t("{0}: {1} estimated tokens", [key, Math.round(tokens).toLocaleString()]); usageHint(cell, hint); ui(cell, 'aria-label', hint); heat.append(cell);
  }
  ui($('usageFormula'), 'textContent', () => t("Final frontend context (capped at {2} tokens for this estimate) × unique tool calls ÷ {0} × each model’s cached-input rate ÷ 1M × {1}.", [formula.divisor, formula.multiplier, snapshot!.contextTokenCap.toLocaleString()]));
  ui($('usageCost'), 'textContent', () => t("{0} estimated equivalent. {1}This is a comparison, not a bill.", [costText(total), total.unpricedTokens ? t("{0} tokens have no rate. ", [Math.round(total.unpricedTokens).toLocaleString()]) : '']));
  const modelTable = el('table', 'usage-table'); const modelHead = el('tr');
  for (const title of ['Recorded model / effort', 'Estimated tokens', 'Estimated equivalent']) modelHead.append(el('th', '', () => t(title)));
  modelTable.append(modelHead);
  for (const entry of usageModelGroups(snapshot.models)) {
    const estimate = usageEstimate(entry.sources, formula); const row = el('tr');
    const name = el('td', '', () => `${entry.model} · ${entry.reasoningEffort ?? t("effort unknown")}${entry.assumed ? t(" (assumed)") : ''}`);
    usageHint(name, () => t("Recorded IDs: {0}", [[...new Set(entry.sources.map(source => source.model))].join(', ')]));
    row.append(name, el('td', '', Math.round(estimate.tokens).toLocaleString()), el('td', '', () => estimate.unpricedTokens > 0 && estimate.unpricedTokens === estimate.tokens ? t("Rate unknown") : costText(estimate))); modelTable.append(row);
  }
  const table = el('table', 'usage-table'); const head = el('tr');
  head.append(el('th', '', () => t("Day")), el('th', '', () => t("Estimated tokens")), el('th', '', () => t("Cached × {0}", [formula.multiplier]))); table.append(head);
  for (const day of [...daily].reverse()) { const row = el('tr'); row.append(el('td', '', day.date), el('td', '', Math.round(day.tokens).toLocaleString()), el('td', '', costText(day))); table.append(row); }
  if (!snapshot.days.length) { const row = el('tr'); const cell = el('td', 'muted', () => t("No recorded tool calls yet.")); cell.setAttribute('colspan', '3'); row.append(cell); table.append(row); }
  $('usageDays').replaceChildren(modelTable, table);
}
export function initUsage(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(FORMULA_KEY) ?? 'null');
    if (saved && Number.isFinite(saved.divisor) && saved.divisor > 0 && Number.isFinite(saved.multiplier) && saved.multiplier >= 0 && saved.rates && typeof saved.rates === 'object' && !Array.isArray(saved.rates)) {
      formula = { divisor: saved.divisor, multiplier: saved.multiplier, rates: { ...DEFAULT_USAGE_FORMULA.rates, ...Object.fromEntries(Object.entries(saved.rates).filter(([key, value]) => key.length <= 100 && (value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0))) } as UsageFormula['rates'] };
    }
  } catch { /* Invalid display preferences use the documented default. */ }
  for (const [key, id] of [['divisor', 'usageDivisor'], ['multiplier', 'usageMultiplier']] as const) {
    const input = $<HTMLInputElement>(id); input.value = String(formula[key]);
    input.addEventListener('input', () => { if (input.value !== '' && input.validity.valid && Number.isFinite(input.valueAsNumber)) { formula[key] = input.valueAsNumber; saveFormula(); paintCost(); } });
  }
  $('refreshUsage').addEventListener('click', () => void refreshUsage());
}
