import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_USAGE_FORMULA, usageEstimate, usageModelGroups, usageRate, type UsageFormula, type UsageOverview } from '../../../shared/usage.js';
import { api, unwrap } from '../../state/app-store.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Icon } from '../ui/icon.js';
import { Input } from '../ui/input.js';

function compact(value: number): string { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
const featureLabels: Record<string, string> = { deep_research: 'Deep research', file_upload: 'File uploads', paste_text_to_file: 'Pasted text files', image_gen: 'Image generation' };

export function UsagePage() {
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [error, setError] = useState('');
  const [formula, setFormula] = useState<UsageFormula>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('usage-formula-v1') ?? 'null') as Partial<UsageFormula> | null;
      if (saved && Number.isFinite(saved.divisor) && (saved.divisor ?? 0) > 0 && Number.isFinite(saved.multiplier) && (saved.multiplier ?? -1) >= 0 && saved.rates && typeof saved.rates === 'object' && !Array.isArray(saved.rates)) {
        return { divisor: saved.divisor!, multiplier: saved.multiplier!, rates: { ...DEFAULT_USAGE_FORMULA.rates, ...saved.rates } };
      }
    } catch { /* local display preference only */ }
    return { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates } };
  });
  const refresh = () => void unwrap(api.getUsage()).then(setUsage).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  useEffect(refresh, []);
  const daily = useMemo(() => usage?.days.map((day) => ({ ...day, ...usageEstimate(day.models, formula) })) ?? [], [formula, usage]);
  const estimate = useMemo(() => usage ? usageEstimate(usage.models, formula) : null, [formula, usage]);
  const max = useMemo(() => Math.max(1, ...daily.map((day) => day.tokens)), [daily]);
  const saveFormula = (next: UsageFormula) => { setFormula(next); try { localStorage.setItem('usage-formula-v1', JSON.stringify(next)); } catch { /* in-memory is enough */ } };
  const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-panel="usage">
      <header className="flex h-12 items-center border-b border-border px-5"><h1 className="text-sm font-semibold">Usage</h1><Button className="ml-auto" size="sm" variant="ghost" onClick={refresh}><Icon name="i-retry" className="size-3.5" />Refresh</Button></header>
      <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-4xl px-6 py-8">
        <div className="grid gap-3 sm:grid-cols-4"><Card className="p-4"><div className="text-xs text-muted-foreground">Processed tokens · est.</div><strong className="mt-1 block text-xl">{estimate ? compact(estimate.tokens) : '—'}</strong></Card><Card className="p-4"><div className="text-xs text-muted-foreground">Equivalent · USD</div><strong className="mt-1 block text-xl">{estimate ? `${money(estimate.cost)}${estimate.unpricedTokens ? '+' : ''}` : '—'}</strong></Card><Card className="p-4"><div className="text-xs text-muted-foreground">Sessions</div><strong className="mt-1 block text-xl">{usage?.sessions ?? '—'}</strong></Card><Card className="p-4"><div className="text-xs text-muted-foreground">Reported limits</div><strong className="mt-1 block text-xl">{usage?.limits.length ?? '—'}</strong></Card></div>
        <h2 className="mt-8 text-sm font-semibold">Token activity</h2><div className="mt-3 grid grid-cols-[repeat(52,minmax(3px,1fr))] items-end gap-1 rounded-xl border border-border p-4">{usage?.days.slice(-52).map((day) => <div key={day.date} className="min-h-1 rounded-sm bg-foreground/70" style={{ height: `${Math.max(4, day.tokens / max * 72)}px` }} title={`${day.date}: ${compact(day.tokens)}`} />)}</div>
        <h2 className="mt-8 text-sm font-semibold">Remaining usage</h2><div className="mt-3 overflow-hidden rounded-xl border border-border">{usage?.limits.map((row) => <div key={`${row.scope}:${row.model}`} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0"><div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{row.scope === 'feature' ? featureLabels[row.model] ?? row.model : row.model}</div><div className="text-xs text-muted-foreground">{row.scope}</div></div><strong className="text-sm">{row.remainingPercent === null ? 'Not reported' : `${Math.round(row.remainingPercent)}%`}</strong></div>)}{usage && !usage.limits.length && <div className="px-4 py-8 text-center text-xs text-muted-foreground">No provider quota data was reported.</div>}</div>
        <h2 className="mt-8 text-sm font-semibold">Comparison formula</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Editable cached-input equivalent for comparing workloads. It is not a bill.</p><div className="mt-3 overflow-hidden rounded-xl border border-border"><label className="flex items-center gap-4 border-b border-border px-4 py-3"><div className="min-w-0 flex-1"><div className="text-[13px] font-medium">Context divisor</div><div className="text-xs text-muted-foreground">Final frontend context ÷ divisor</div></div><Input className="w-24" type="number" min={0.01} step={0.1} value={formula.divisor} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) saveFormula({ ...formula, divisor: value }); }} /></label><label className="flex items-center gap-4 border-b border-border px-4 py-3"><div className="min-w-0 flex-1"><div className="text-[13px] font-medium">Multiplier</div><div className="text-xs text-muted-foreground">Comparison multiplier after the cached-input rate</div></div><Input className="w-24" type="number" min={0} step={0.1} value={formula.multiplier} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) saveFormula({ ...formula, multiplier: value }); }} /></label>{usage && [...new Set(usage.models.map((row) => row.model))].sort().map((model) => <label key={model} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0"><div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{model}</div><div className="text-xs text-muted-foreground">USD per 1M cached-input tokens</div></div><Input className="w-28" type="number" min={0} step={0.01} value={usageRate(model, formula) ?? ''} placeholder="Unknown" onChange={(event) => { const value = event.target.value === '' ? null : Number(event.target.value); if (value === null || Number.isFinite(value) && value >= 0) saveFormula({ ...formula, rates: { ...formula.rates, [model]: value } }); }} /></label>)}</div>
        {usage && <div className="mt-8 overflow-x-auto rounded-xl border border-border"><table className="w-full text-left text-xs"><thead className="bg-muted"><tr><th className="px-3 py-2 font-medium">Recorded model / effort</th><th className="px-3 py-2 font-medium">Estimated tokens</th><th className="px-3 py-2 font-medium">Equivalent</th></tr></thead><tbody>{usageModelGroups(usage.models).map((group) => { const row = usageEstimate(group.sources, formula); return <tr key={`${group.model}:${group.reasoningEffort}:${group.assumed}`} className="border-t border-border" data-usage-hint={`Recorded IDs: ${group.sources.map((source) => source.model).join(', ')}`}><td className="px-3 py-2">{group.model} · {group.reasoningEffort ?? 'effort unknown'}{group.assumed ? ' (assumed)' : ''}</td><td className="px-3 py-2">{Math.round(row.tokens).toLocaleString()}</td><td className="px-3 py-2">{row.unpricedTokens === row.tokens && row.tokens ? 'Rate unknown' : `${money(row.cost)}${row.unpricedTokens ? ' + unpriced' : ''}`}</td></tr>; })}</tbody></table></div>}
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      </div></div>
    </section>
  );
}
