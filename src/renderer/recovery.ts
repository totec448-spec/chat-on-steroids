import type { RecoveryCountdown } from '../shared/recovery.js';
import { el, icon } from './dom.js';
import { t, ui } from './i18n.js';

/** Only the displayed seconds tick here. Main owns every deadline and cancellation. */
/** `actionFor` may add one control to a row, e.g. the user's cancel for an interrupted-response reload. */
export function renderRecoveryCountdowns(host: HTMLElement, countdowns: readonly RecoveryCountdown[], now = Date.now(),
  actionFor?: (countdown: RecoveryCountdown) => HTMLElement | null): boolean {
  const key = JSON.stringify(countdowns);
  if (!countdowns.length) { delete host.dataset.countdowns; return false; }
  if (host.dataset.countdowns !== key) {
    host.replaceChildren(...countdowns.map(countdown => {
      const row = el('div', 'recovery-notice');
      const label = el('span', 'queue-label', () => {
        if (countdown.next) {
          const reason = countdown.kind === 'pickup-stopped' ? t('Recovery stopped') : countdown.kind === 'pickup' ? t('Waiting for delivery') : countdown.kind === 'post-reload'
            ? countdown.generating ? t('Reloaded · turn still marked generating') : t('Reloaded') :
            countdown.kind === 'thinking-failed' ? t('Thinking failed') : t('Turn still marked generating · extra wait');
          const next = countdown.next === 'continue' ? t('Automatic Continue') : countdown.next === 'queue' ? t('Queued message') : countdown.next === 'goal' ? t('Goal') : t('Loop');
          return t('{0} · next: {1}', [reason, next]);
        }
        return countdown.kind === 'unattributed' ? t('Unattributed call') :
        countdown.kind === 'unattributed-wait' ? t('Unattributed activity · awaiting attribution') :
        countdown.kind === 'assistant-error' ? t('Interrupted response') :
        countdown.kind === 'tab-recovery' ? t('Browser tab recovery') :
        countdown.kind === 'silence' ? t('No recent activity') :
        countdown.kind === 'post-reload' ? t('Reloaded · waiting for activity') :
        countdown.kind === 'thinking-failed' ? t('Thinking failed · waiting for activity') : t('Turn still marked generating · extra wait');
      });
      ui(row, 'title', () => countdown.kind === 'pickup-stopped'
        ? t('The browser did not collect the pending step after {0} automatic reload attempts. Its original queued input or Goal obligation remains saved. CoS will not reload this chat for this step again; open the chat to continue manually.', [String(countdown.attempts ?? 3)])
        : countdown.kind === 'native-busy' || countdown.generating
        ? t('Delivery was deferred because the turn is still marked generating. This is the remaining extra wait, not a new reload timer. Fresh work or a final answer cancels recovery.')
        : countdown.next === 'continue'
        ? t('New activity, a final answer or your Stop cancels automatic Continue. Stop is used only if ChatGPT is still generating.')
        : countdown.kind === 'unattributed-wait'
        ? t('An attributed MCP call clears this chat. The five-minute window starts with the first unattributed call.')
        : countdown.kind === 'unattributed'
        ? t('This chat is a possible source. An attributed MCP call cancels its reload.')
        : countdown.kind === 'silence' ? t('New activity cancels this countdown.')
        : countdown.kind === 'assistant-error'
        ? t("ChatGPT's page lost this answer's live stream. The answer may still be running: the reload reconnects the page without stopping it.")
        : t('New activity cancels recovery. The countdown shows the next check or delivery attempt.'));
      const timer = el('span', 'recovery-countdown');
      timer.setAttribute('role', 'timer');
      timer.setAttribute('aria-live', 'off');
      row.append(icon('i-pulse'), label, timer);
      const action = actionFor?.(countdown);
      if (action) row.append(action);
      return row;
    }));
    host.dataset.countdowns = key;
  }
  host.hidden = countdowns.every(countdown => (countdown.visibleAt ?? 0) > now);
  host.querySelectorAll<HTMLElement>('.recovery-countdown').forEach((timer, index) => {
    const countdown = countdowns[index]!;
    timer.closest<HTMLElement>('.recovery-notice')!.hidden = (countdown.visibleAt ?? 0) > now;
    const seconds = Math.max(0, Math.ceil((countdown.deadline - now) / 1000));
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const text = countdown.kind === 'pickup-stopped'
      ? t('Stopped after {0} attempts', [String(countdown.attempts ?? 3)])
      : countdown.kind === 'pickup'
      ? seconds ? t('Reload in {0}', [time]) : t('Reload pending…')
      : countdown.next === 'continue'
      ? seconds ? t('Continue in {0}', [time]) : t('Preparing Continue…')
      : countdown.kind === 'tab-recovery'
      ? seconds ? t('Recovery in {0}', [time]) : t('Recovery pending…')
      : countdown.kind === 'unattributed' || countdown.kind === 'silence' || countdown.kind === 'assistant-error' || countdown.reload
      ? seconds ? t('Reload in {0}', [time]) : t('Reload pending…')
      : seconds ? t('Check in {0}', [time]) : t('Checking for activity…');
    if (timer.textContent !== text) timer.textContent = text;
  });
  return true;
}
