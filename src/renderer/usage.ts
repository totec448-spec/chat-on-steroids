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
const featureLabels: Record<string, string> = { deep_research: 'Deep research', file_upload: 'File uploads', paste_text_to_file: 'Pasted text files', image_gen: 'Image generation' };
function usageHint(node: HTMLElement, text: string): void {
  node.dataset.usageHint = text;
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
  status.textContent = snapshot ? 'Updating…' : 'Calculating recorded tool usage…';
  status.setAttribute('role', 'status');
  try {
    const [value, catalog] = await Promise.all([run(window.api.getUsage()), run(window.api.getChatModels())]);
    if (generation !== loadGeneration) return;
    if (!value) { status.textContent = 'Usage could not be loaded. Try Refresh.'; return; }
    snapshot = value;
    const summary = $('usageSummary'); summary.replaceChildren();
    for (const [label, number] of [['Processed tokens · est.', value.tokens], ['Peak daily tokens', Math.max(0, ...value.days.map((day) => day.tokens))], ['Conversations', value.sessions], ['Active days', value.days.filter((day) => day.tokens > 0).length]] as const) {
      const item = el('div'); item.dataset.usageMetric = label; usageHint(item, `${Math.round(number).toLocaleString()} ${label.toLowerCase()}`); item.append(el('strong', '', count.format(number)), el('span', '', label)); summary.append(item);
    }
    const limits = $('modelUsage'); limits.replaceChildren();
    const modelRows = value.limits.filter((row) => row.scope === 'model');
    const knownModels = catalog?.models ?? [];
    for (const model of knownModels.filter((item) => !modelRows.some((row) => row.model === item.id))) {
      const row = el('div', 'usage-limit'); row.append(el('strong', '', model.label), el('span', 'muted', 'Not reported by ChatGPT')); limits.append(row);
    }
    for (const entry of [...modelRows, ...value.limits.filter((row) => row.scope !== 'model')]) {
      const stale = Date.now() - entry.observedAt > 10 * 60000 || (entry.resetAt !== null && entry.resetAt <= Date.now());
      const row = el('div', 'usage-limit');
      const displayName = entry.scope === 'feature' ? featureLabels[entry.model] ?? entry.model : entry.model;
      const name = el('div'); name.append(el('strong', '', displayName));
      if (entry.scope !== 'model') name.append(el('small', 'muted', entry.scope === 'shared' ? 'Shared usage pool' : 'Feature quota'));
      const detail = el('div');
      detail.append(el('b', '', stale ? 'Refresh needed' : entry.remaining !== null ? `${entry.remaining.toLocaleString()} remaining` : entry.remainingPercent !== null ? `${Math.round(entry.remainingPercent)}% remaining` : 'Not reported'));
      const window = entry.windowSeconds === 604800 ? 'Weekly · ' : entry.windowSeconds ? `${Math.round(entry.windowSeconds / 3600)}h window · ` : '';
      detail.append(el('small', 'muted', window + (entry.resetAt ? `Resets ${new Date(entry.resetAt).toLocaleString()}` : 'Reset not reported')));
      if (entry.remainingPercent !== null && !stale) { const progress = document.createElement('progress'); progress.max = 100; progress.value = entry.remainingPercent; progress.setAttribute('aria-label', `${displayName}: ${entry.remainingPercent}% remaining`); detail.append(progress); }
      row.append(name, detail); limits.append(row);
    }
    if (!modelRows.length) limits.append(el('p', 'muted', 'ChatGPT has not reported per-model message balances. Shared usage and feature quotas do not establish a model-specific balance.'));
    const totalCost = el('div'); totalCost.append(el('strong', '', '—'), el('span', '', 'Estimated equivalent · USD')); totalCost.id = 'usageTotalCost'; usageHint(totalCost, ''); summary.prepend(totalCost);
    paintRates();
    paintCost();
    status.textContent = 'Recorded model attribution; missing history assumes GPT-5.6 High. Unchanged recordings reuse saved totals.';
  } finally { if (generation === loadGeneration) $('refreshUsage').removeAttribute('disabled'); }
}
function paintRates(): void {
  if (!snapshot) return;
  const host = $('usageRates'); host.replaceChildren();
  for (const model of [...new Set(snapshot.models.map(row => row.model))].sort()) {
    const label = el('label', 'setting'); const text = el('span', 'setting-text');
    text.append(el('b', '', model), el('em', '', usageRate(model, DEFAULT_USAGE_FORMULA) !== undefined ? 'USD / 1M cached input · editable official baseline, checked 7 September 2026' : 'USD / 1M cached input · enter a verified comparison rate'));
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = '0.01'; input.placeholder = 'Unknown rate'; input.value = usageRate(model, formula)?.toString() ?? '';
    input.setAttribute('aria-label', `${model} cached-input USD per million tokens`);
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
  const costText = (estimate: ReturnType<typeof usageEstimate>) => estimate.unpricedTokens > 0 ? `${money.format(estimate.cost)} + unpriced` : money.format(estimate.cost);
  const costSummary = document.getElementById('usageTotalCost');
  if (costSummary) {
    costSummary.querySelector('strong')!.textContent = costText(total);
    costSummary.dataset.usageHint = `${Math.round(total.tokens).toLocaleString()} estimated tokens; ${Math.round(total.unpricedTokens).toLocaleString()} have no comparison rate. Cached-input equivalent, not a bill.`;
  }
  const daily = snapshot.days.map(day => ({ ...day, ...usageEstimate(day.models, formula) }));
  for (const [label, number] of [['Processed tokens · est.', total.tokens], ['Peak daily tokens', Math.max(0, ...daily.map(day => day.tokens))]] as const) {
    const item = [...$('usageSummary').children].find(node => (node as HTMLElement).dataset.usageMetric === label) as HTMLElement | undefined;
    if (item) { item.querySelector('strong')!.textContent = count.format(number); item.dataset.usageHint = `${Math.round(number).toLocaleString()} ${label.toLowerCase()}`; }
  }
  const heat = $('usageHeatmap'); heat.replaceChildren();
  const byDay = new Map(daily.map(day => [day.date, day.tokens])); const peak = Math.max(1, ...daily.map(day => day.tokens));
  for (let ago = 363; ago >= 0; ago--) {
    const date = new Date(); date.setDate(date.getDate() - ago); const key = dateKey(date), tokens = byDay.get(key) ?? 0;
    const cell = el('span', 'heat-cell'); cell.dataset.level = String(tokens ? Math.max(1, Math.ceil(tokens / peak * 4)) : 0); const hint = `${key}: ${Math.round(tokens).toLocaleString()} estimated tokens`; usageHint(cell, hint); cell.setAttribute('aria-label', hint); heat.append(cell);
  }
  $('usageFormula').textContent = `Final frontend context × unique tool calls ÷ ${formula.divisor} × each model’s cached-input rate ÷ 1M × ${formula.multiplier}.`;
  $('usageCost').textContent = `${costText(total)} estimated equivalent. ${total.unpricedTokens ? `${Math.round(total.unpricedTokens).toLocaleString()} tokens have no rate. ` : ''}This is a comparison, not a bill.`;
  const modelTable = el('table', 'usage-table'); const modelHead = el('tr');
  for (const title of ['Recorded model / effort', 'Estimated tokens', 'Estimated equivalent']) modelHead.append(el('th', '', title));
  modelTable.append(modelHead);
  for (const entry of usageModelGroups(snapshot.models)) {
    const estimate = usageEstimate(entry.sources, formula); const row = el('tr');
    const name = el('td', '', `${entry.model} · ${entry.reasoningEffort ?? 'effort unknown'}${entry.assumed ? ' (assumed)' : ''}`);
    usageHint(name, `Recorded IDs: ${[...new Set(entry.sources.map(source => source.model))].join(', ')}`);
    row.append(name, el('td', '', Math.round(estimate.tokens).toLocaleString()), el('td', '', estimate.unpricedTokens > 0 && estimate.unpricedTokens === estimate.tokens ? 'Rate unknown' : costText(estimate))); modelTable.append(row);
  }
  const table = el('table', 'usage-table'); const head = el('tr');
  head.append(el('th', '', 'Day'), el('th', '', 'Estimated tokens'), el('th', '', `Cached × ${formula.multiplier}`)); table.append(head);
  for (const day of [...daily].reverse()) { const row = el('tr'); row.append(el('td', '', day.date), el('td', '', Math.round(day.tokens).toLocaleString()), el('td', '', costText(day))); table.append(row); }
  if (!snapshot.days.length) { const row = el('tr'); const cell = el('td', 'muted', 'No recorded tool calls yet.'); cell.setAttribute('colspan', '3'); row.append(cell); table.append(row); }
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
