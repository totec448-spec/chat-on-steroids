import { ui, t } from './i18n.js';
import type { Config } from '../shared/types.js';
import type { SessionSummary } from '../shared/session.js';
import type { ReasoningEffort } from '../shared/session.js';
import { isProModel } from '../shared/chat-models.js';

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
  const worker = session?.origin?.kind === 'worker' || session?.origin?.kind === 'helper';
  const limit = config.sessions.limitTokens;
  const percent = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
  arc.setAttribute('stroke-dasharray', `${pro ? 0 : percent * 0.377} 37.7`);
  const tokens = new Intl.NumberFormat().format(used);
  const description = () => [t('Session context · estimated'), pro
    ? t('{0} tokens used', [tokens])
    : t('{0} / {1} tokens · {2}% of configured limit', [tokens, new Intl.NumberFormat().format(limit), percent]),
    worker ? t('Automatic compaction is unavailable for worker and helper chats') : pro ? t('Auto-compaction off for Pro') : config.compaction.auto
      ? t('Auto-compaction at {0} tokens', [new Intl.NumberFormat().format(config.compaction.autoTokens)])
      : t('Auto-compaction off')].join('\n');
  ui(panel, 'textContent', description);
  ui(button, 'aria-label', () => description().replaceAll('\n', '. '));
  const explain = document.getElementById('contextMeterPolicy');
  if (explain) ui(explain, 'textContent', () => pro || worker
    ? t('The global automatic setting does not override this restriction. Manual Compact & resume remains a separate action.')
    : t('Automatic compaction watches active eligible chats, saves a handoff, and continues in a fresh conversation. The token count is a local estimate.'));
}

export function initContextMeter(): void {
  const root = document.getElementById('contextMeter');
  const button = document.getElementById('contextMeterButton');
  if (!root || !button) return;
  const close = () => { root.classList.remove('pinned'); button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => { const open = root.classList.toggle('pinned'); button.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', event => { if (event.target instanceof Node && !root.contains(event.target)) close(); });
  // Capture descendants as well as the trigger without relying on bubbling.
  // A closed panel must not consume Escape or steal focus from another control.
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && root.classList.contains('pinned')) {
      event.preventDefault(); event.stopPropagation(); close(); button.focus();
    }
  }, true);
}
