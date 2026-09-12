import type { SessionEvent } from '../shared/session.js';
import { t } from './i18n.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;

/** Presentation only: never infer send/reload authority from error prose. */
export function chatErrorPresentation(error: ChatError, history: readonly SessionEvent[] = []) {
  const text = error.message.text.trim();
  const thinking = text === 'Thinking failed';
  const stalled = text.startsWith('No visible progress for ten minutes.');
  const title = thinking ? t('Thinking failed') : stalled ? t('Response stalled') : t('ChatGPT reported a problem');
  // Older recordings described our open-turn bookkeeping as native generation.
  const message = thinking ? t('ChatGPT’s page reported a failure. This does not prove the work stopped.')
    : stalled ? t('No visible progress for ten minutes. The app could not confirm that this turn finished.') : error.message.text;
  let next = error.blocking === true
    ? t('Wait until ChatGPT allows requests again, then retry. Reloading cannot remove this limit.')
    : thinking
      ? t('You can send a follow-up. Automatic recovery, when allowed, refreshes the page and waits five minutes before a queued continuation; new work postpones it.')
      : error.recoverable === true || stalled
        ? t('The app will try to refresh this chat when recovery is eligible. A refresh does not resend your message. If it stays stuck, open ChatGPT and check the page before retrying.')
        : t('Open this chat in ChatGPT and check the error. If your message is already there, do not send it again; otherwise retry when the page is ready.');

  // Use the existing recorded repair row, bounded by the next question/error.
  // Never borrow another turn's recovery, or treat a reload receipt as completion.
  let repair: Extract<SessionEvent, { kind: 'progress' }> | undefined;
  let continued = false;
  let completed = false;
  for (const event of [...history].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= error.seq) continue;
    if (event.kind === 'user_message' || event.kind === 'chat_error' ||
        (event.kind === 'turn_start' && event.turnId !== error.turnId)) break;
    if (error.turnId && event.turnId === error.turnId && event.kind === 'turn_end' && event.outcome === 'completed') {
      completed = true;
    }
    if (error.turnId && event.turnId === error.turnId && event.time > error.time &&
        (event.kind === 'tool_call' || (event.kind === 'turn_start' && event.source === 'app'))) {
      continued = true;
      completed = false;
    }
    if (event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:') &&
        (!event.turnId || (!!error.turnId && event.turnId === error.turnId))) repair = event;
  }
  if (completed) return { title, message, next: t('This turn later completed. You can continue with a new message.') };
  if (continued) return { title, message, next: t('Work continued after this notice. Automatic continuation waits for work to settle; the failed page alone does not trigger another message.') };
  if (repair && error.blocking !== true) next = `${repair.message.text} ${thinking
    ? t('You can send a follow-up. After a confirmed refresh, automatic continuation waits five minutes and checks for new work before sending.')
    : t('Queued messages still wait until sending is safe. If the chat stays stuck, open ChatGPT and check the page before retrying.')}`;
  return { title, message, next };
}
