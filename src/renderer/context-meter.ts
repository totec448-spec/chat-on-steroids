import { currentLanguage, ui, t } from './i18n.js';
import type { Config } from '../shared/types.js';
import type { SessionSummary } from '../shared/session.js';
import type { ReasoningEffort } from '../shared/session.js';
import { isProModel } from '../shared/chat-models.js';

/**
 * A short token count in the interface language, beside the translated "est.". Some locales
 * (German, for one) do not abbreviate thousands in compact notation, which turned the chip
 * into "6992 / 533.333"; those fall back to a translated thousands unit.
 */
export function compactTokens(value: number, language: string): string {
  const compact = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 0 }).format(value);
  if (value < 10_000 || value >= 1_000_000 || /[^\d\s.,\u00a0\u202f']/.test(compact)) return compact;
  return t('{0}K', [new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(Math.round(value / 1000))]);
}

/** Recorder estimates, never a claim about the provider's exact context window. */
export function paintContextMeter(session: SessionSummary | null, config: Config, composer: { model: string; reasoningEffort: ReasoningEffort } | null = null): void {
  const button = document.getElementById('contextMeterButton');
  const panel = document.getElementById('contextMeterInfo');
  const arc = document.getElementById('contextMeterArc');
  if (!button || !panel || !arc) return;
  const used = Math.max(0, session?.contextTokens ?? 0);
  // The picker owns the next send choice; the recording may still describe the
  // preceding turn (or not exist yet in a new chat).
  const observed = session?.selectedModel;
  const selection = composer ?? (observed?.conversationId === session?.conversationId ? observed : null);
  const pro = isProModel(selection?.model, selection?.reasoningEffort);
  const limit = config.sessions.limitTokens;
  const percent = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
  arc.setAttribute('stroke-dasharray', `${pro ? 0 : percent * 0.377} 37.7`);
  const tokens = new Intl.NumberFormat().format(used);
  const compact = document.getElementById('contextMeterCompact');
  if (compact) {
    const short = (value: number) => compactTokens(value, currentLanguage());
    ui(compact, 'textContent', () => pro ? `${short(used)} ${t('est.')}` : `${short(used)} / ${short(limit)} ${t('est.')}`);
  }
  const description = () => [t('Session context · estimated'), pro
    ? t('{0} tokens used', [tokens])
    : t('{0} / {1} tokens · {2}% of configured limit', [tokens, new Intl.NumberFormat().format(limit), percent]),
    pro ? t('Auto-compaction off for Pro') : config.compaction.auto
      ? t('Auto-compaction at {0} tokens', [new Intl.NumberFormat().format(config.compaction.autoTokens)])
      : t('Auto-compaction off')].join('\n');
  ui(panel, 'textContent', description);
  ui(button, 'aria-label', () => description().replaceAll('\n', '. '));
}

export function initContextMeter(): void {
  const root = document.getElementById('contextMeter');
  const button = document.getElementById('contextMeterButton');
  if (!root || !button) return;
  const close = () => { root.classList.remove('pinned'); button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => { const open = root.classList.toggle('pinned'); button.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', event => { if (event.target instanceof Node && !root.contains(event.target)) close(); });
  button.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); button.blur(); } });
}
