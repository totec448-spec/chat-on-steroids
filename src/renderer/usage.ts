import { currentLanguage, ui, t } from './i18n.js';
import { $, el, run } from './dom.js';
import { DEFAULT_USAGE_FORMULA, usageDateKey as dateKey, usageEstimate, usageMessageTotals, usageModelGroups, usageRate, usageWeekStart, type UsageFormula, type UsageOverview } from '../shared/usage.js';
let snapshot: UsageOverview | null = null;
let loadGeneration = 0;
const FORMULA_KEY = 'usage-formula-v1';
const WEEK_START_KEY = 'cos.usage.weekStart';
let weekStart = 1;
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
/** Weekday names come from the calendar, never a word list: Monday 21 September 2026 onwards. */
function weekdayName(weekday: number): string {
  return new Date(2026, 8, 20 + (weekday === 0 ? 7 : weekday)).toLocaleDateString(currentLanguage(), { weekday: 'long' });
}
function paintMessages(): void {
  const through = snapshot?.messages.through ?? Date.now();
  const from = usageWeekStart(weekStart, through);
  const select = $<HTMLSelectElement>('usageWeekStart');
  select.value = String(weekStart);
  if (!snapshot) return;
  const totals = usageMessageTotals(snapshot.messages, weekStart);
  ui($('usageMessages56'), 'textContent', () => totals.gpt56.toLocaleString(currentLanguage()));
  ui($('usageMessages6'), 'textContent', () => totals.gpt6.toLocaleString(currentLanguage()));
  const period = () => {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
    return t('Local time · {0} → {1}', [format.format(from), format.format(through)]);
  };
  ui($('usageMessagePeriod'), 'textContent', period);
  ui(select, 'title', () => `${t('Change start day')}\n${period()}`);
}
export async function refreshUsage(): Promise<void> {
  document.getElementById('usageTooltip')?.remove();
  const generation = ++loadGeneration;
  $('refreshUsage').setAttribute('disabled', '');
  const status = $('usageStatus');
  ui(status, 'textContent', () => t("Updating usage in the background. After an update, this can take a few minutes. You can keep using the app."));
  status.setAttribute('role', 'status');
  try {
    const value = await run(window.api.getUsage());
    if (generation !== loadGeneration) return;
    if (!value) { ui(status, 'textContent', () => t("Usage could not be loaded. Try Refresh.")); return; }
    snapshot = value;
    paintMessages();
    const summary = $('usageSummary'); summary.replaceChildren();
    for (const [label, number] of [['Processed tokens · est.', value.tokens], ['Peak daily tokens', Math.max(0, ...value.days.map((day) => day.tokens))], ['Conversations', value.sessions], ['Active days', value.days.filter((day) => day.tokens > 0).length]] as const) {
      const item = el('div'); item.dataset.usageMetric = label; usageHint(item, () => `${Math.round(number).toLocaleString()} ${t(label).toLowerCase()}`); item.append(el('strong', '', count.format(number)), el('span', '', () => t(label))); summary.append(item);
    }
    const limits = $('usageLimits'); limits.replaceChildren();
    const modelRows = value.limits.filter((row) => row.scope === 'model');
    for (const entry of [...modelRows, ...value.limits.filter((row) => row.scope !== 'model')]) {
      const stale = Date.now() - entry.observedAt > 10 * 60000 || (entry.resetAt !== null && entry.resetAt <= Date.now());
      const row = el('div', 'usage-limit');
      const featureLabel = featureLabels[entry.model];
      // Shared pools are told apart by their window; "Shared usage" twice said nothing.
      const sharedName = () => entry.windowSeconds === 604800 ? t("Weekly limit") : entry.windowSeconds ? t("{0}-hour limit", [Math.round(entry.windowSeconds / 3600)]) : entry.model;
      const displayName = () => entry.scope === 'feature' && featureLabel ? t(featureLabel) : entry.scope === 'shared' ? sharedName() : entry.model;
      const name = el('div'); name.append(el('strong', '', displayName));
      if (entry.scope !== 'model') name.append(el('small', 'muted', () => entry.scope === 'shared' ? t("Shared across all models") : t("Feature quota")));
      const detail = el('div');
      detail.append(el('b', '', () => stale ? t("Refresh needed") : entry.remaining !== null ? t("{0} remaining", [entry.remaining.toLocaleString()]) : entry.remainingPercent !== null ? t("{0}% remaining", [Math.round(entry.remainingPercent)]) : t("Not reported")));
      const window = () => entry.scope === 'shared' ? '' : entry.windowSeconds === 604800 ? t("Weekly · ") : entry.windowSeconds ? t("{0}h window · ", [Math.round(entry.windowSeconds / 3600)]) : '';
      detail.append(el('small', 'muted', () => window() + (entry.resetAt ? t("Resets {0}", [new Date(entry.resetAt).toLocaleString()]) : t("Reset not reported"))));
      if (entry.remainingPercent !== null && !stale) { const progress = document.createElement('progress'); progress.max = 100; progress.value = entry.remainingPercent; ui(progress, 'aria-label', () => t("{0}: {1}% remaining", [displayName(), entry.remainingPercent])); detail.append(progress); }
      row.append(name, detail); limits.append(row);
    }
    const totalCost = el('div'); totalCost.append(el('strong', '', '—'), el('span', '', () => t("Estimated equivalent · USD"))); totalCost.id = 'usageTotalCost'; usageHint(totalCost, ''); summary.prepend(totalCost);
    paintRates();
    paintCost();
    ui(status, 'textContent', () => '');
  } catch {
    if (generation === loadGeneration) ui(status, 'textContent', () => t("Usage could not be loaded. Try Refresh."));
  } finally { if (generation === loadGeneration) $('refreshUsage').removeAttribute('disabled'); }
}
function paintRates(): void {
  if (!snapshot) return;
  const host = $('usageRates'); host.replaceChildren();
  for (const model of [...new Set(snapshot.models.map(row => row.model))].sort()) {
    const label = el('label', 'setting'); const text = el('span', 'setting-text');
    text.append(el('b', '', model), el('em', '', () => usageRate(model, DEFAULT_USAGE_FORMULA) !== undefined ? t("USD / 1M cached input · editable official baseline, checked 27 September 2026") : t("USD / 1M cached input · enter a verified comparison rate")));
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
/** A recorded day key (YYYY-MM-DD) as a short local date, e.g. "Sun, Sep 27". */
function dayLabel(key: string): string {
  const date = new Date(`${key}T00:00:00`);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString(currentLanguage(), { weekday: 'short', month: 'short', day: 'numeric' });
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
  // Keep a stable annual window even with sparse history; activity must not change the axis.
  const weeks = 52;
  // A calendar: one column per week starting on Monday, one row per weekday, today in the
  // last column. Days after today stay as empty slots so the rows keep their weekday.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - (today.getDay() + 6) % 7 - (weeks - 1) * 7);
  // Weekday labels and months share the cell grid. CSS owns its responsive width.
  const grid = el('div', 'heat-grid'); grid.setAttribute('role', 'group');
  grid.style.gridTemplateColumns = `var(--heat-label) repeat(${weeks}, minmax(0, 1fr))`;
  const place = (node: HTMLElement, row: number, column: string) => { node.style.gridRow = String(row); node.style.gridColumn = column; grid.append(node); };
  for (let row = 0; row < 7; row += 2) {
    const label = el('span', 'heat-day'); label.setAttribute('aria-hidden', 'true');
    ui(label, 'textContent', () => new Date(2026, 8, 21 + row).toLocaleDateString(currentLanguage(), { weekday: 'short' }));
    place(label, row + 2, '1');
  }
  // Label each of the twelve months, including a month starting in the current week.
  // Use UTC calendar ordinals only for day distances, avoiding local DST hour shifts.
  const ordinal = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  for (let offset = 11; offset >= 0; offset--) {
    const date = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    const week = Math.max(0, Math.floor((ordinal(date) - ordinal(start)) / 7));
    const month = el('span', 'heat-month'); month.setAttribute('aria-hidden', 'true');
    ui(month, 'textContent', () => date.toLocaleDateString(currentLanguage(), { month: 'short' }));
    // Reserve at least three columns for the final label without adding implicit grid tracks.
    const column = Math.min(week, weeks - 3);
    if (column !== week) month.classList.add('is-end');
    place(month, 1, `${column + 2} / span 3`);
  }
  for (let week = 0; week < weeks; week++) {
    const monday = new Date(start); monday.setDate(start.getDate() + week * 7);
    for (let row = 0; row < 7; row++) {
      const date = new Date(monday); date.setDate(monday.getDate() + row);
      if (date > today) { place(el('span', 'heat-cell is-future'), row + 2, String(week + 2)); continue; }
      const key = dateKey(date), tokens = byDay.get(key) ?? 0;
      const cell = el('span', 'heat-cell'); cell.dataset.level = String(tokens ? Math.max(1, Math.ceil(tokens / peak * 4)) : 0);
      const hint = () => t("{0}: {1} estimated tokens", [dayLabel(key), Math.round(tokens).toLocaleString()]); usageHint(cell, hint); ui(cell, 'aria-label', hint);
      place(cell, row + 2, String(week + 2));
    }
  }
  const legend = el('div', 'heat-legend'); legend.setAttribute('aria-hidden', 'true');
  legend.append(el('span', '', () => t('Less')));
  for (let level = 0; level <= 4; level++) { const swatch = el('span', 'heat-cell'); swatch.dataset.level = String(level); legend.append(swatch); }
  legend.append(el('span', '', () => t('More')));
  heat.append(grid, legend);
  ui($('usageHeatmapCaption'), 'textContent', () => t("Estimated context processed per tool call · last 52 weeks"));
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
  // The last 30 days as bars, one glance instead of a long table; the table stays one click away.
  const recent = daily.slice(-30);
  const chart = el('div', 'usage-bars'); chart.setAttribute('role', 'img');
  ui(chart, 'aria-label', () => t("Estimated cost per day, last {0} days", [recent.length]));
  const top = Math.max(0, ...recent.map(day => day.cost));
  for (const day of recent) {
    const bar = el('span', 'usage-bar');
    bar.style.height = `${top > 0 ? Math.max(2, Math.round(day.cost / top * 100)) : 2}%`;
    if (day.cost === top && top > 0) bar.classList.add('is-peak');
    usageHint(bar, () => `${dayLabel(day.date)} · ${costText(day)} · ${t("{0} estimated tokens", [Math.round(day.tokens).toLocaleString()])}`);
    chart.append(bar);
  }
  // Scale and range at a glance: the peak day's amount on top, the first and last day below.
  const scale = el('div', 'usage-bars-scale', money.format(top));
  const axis = el('div', 'usage-bars-axis');
  if (recent.length) axis.append(el('span', '', () => dayLabel(recent[0]!.date)), el('span', '', () => dayLabel(recent[recent.length - 1]!.date)));
  const breakdown = el('details', 'usage-breakdown');
  breakdown.append(el('summary', '', () => t("Daily breakdown")));
  const table = el('table', 'usage-table'); const head = el('tr');
  head.append(el('th', '', () => t("Day")), el('th', '', () => t("Estimated tokens")), el('th', '', () => t("Cached × {0}", [formula.multiplier]))); table.append(head);
  for (const day of [...daily].reverse()) { const row = el('tr'); row.append(el('td', '', () => dayLabel(day.date)), el('td', '', Math.round(day.tokens).toLocaleString()), el('td', '', costText(day))); table.append(row); }
  if (!snapshot.days.length) { const row = el('tr'); const cell = el('td', 'muted', () => t("No recorded tool calls yet.")); cell.setAttribute('colspan', '3'); row.append(cell); table.append(row); }
  breakdown.append(table);
  const modelSection = el('section', 'usage-days-model');
  modelSection.append(el('h3', 'usage-cost-subhead', () => t('By model')), modelTable);
  const daySection = el('section', 'usage-days-daily');
  daySection.append(el('h3', 'usage-cost-subhead', () => t('By day')));
  if (recent.length) daySection.append(scale, chart, axis);
  daySection.append(breakdown);
  $('usageDays').replaceChildren(modelSection, daySection);
}
export function initUsage(): void {
  try {
    const saved = localStorage.getItem(WEEK_START_KEY);
    if (saved !== null && /^[0-6]$/.test(saved)) weekStart = Number(saved);
  } catch { /* The weekday can still be changed in this window. */ }
  // A real choice of seven days instead of a button that silently cycles through them.
  const select = $<HTMLSelectElement>('usageWeekStart');
  select.replaceChildren();
  for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
    const option = document.createElement('option'); option.value = String(weekday);
    ui(option, 'textContent', () => t('Since {0}', [weekdayName(weekday)]));
    select.append(option);
  }
  ui(select, 'aria-label', () => t('Change start day'));
  paintMessages();
  usageHint($('usageMessagesTitle'), () => t('Counts recorded native messages with verified model selection. Tool injections and messages without model evidence are excluded.'));
  select.addEventListener('change', () => {
    const next = Number(select.value);
    if (!Number.isInteger(next) || next < 0 || next > 6) return;
    weekStart = next;
    try { localStorage.setItem(WEEK_START_KEY, String(weekStart)); } catch { /* Keep the current in-memory choice. */ }
    paintMessages();
  });
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
