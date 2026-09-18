import type { SessionEvent } from '../shared/session.js';
import { positionOf } from '../shared/chronology.js';
import { chatErrorMessageKey } from '../shared/chat-error.js';
import { t } from './i18n.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;

/** Project legacy reload duplicates without rewriting their forensic history. */
export function duplicateChatErrors(history: readonly SessionEvent[]): Set<number> {
  const duplicates = new Set<number>();
  let question: number | undefined;
  const notices = new Map<string, number>();
  for (const event of [...history].sort((a, b) => positionOf(a) - positionOf(b))) {
    if (event.kind === 'user_message') { question = positionOf(event); notices.clear(); }
    if (event.kind !== 'chat_error' || event.recoverable !== true || question === undefined) continue;
    const key = chatErrorMessageKey(event.message.text, true);
    if (notices.has(key)) duplicates.add(event.seq);
    else notices.set(key, event.seq);
  }
  return duplicates;
}

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
  let continued = 0;
  let completed = 0;
  const duplicates = duplicateChatErrors(history);
  const question = history.filter(event => event.kind === 'user_message' && positionOf(event) < error.seq)
    .reduce((latest, event) => Math.max(latest, positionOf(event)), 0);
  // The error budget belongs to this question, including an earlier, different
  // transport notice. Only a confirmed app receipt can explain a spent reload.
  const earlierReload = question && error.recoverable === true ? history.find(event =>
    event.kind === 'progress' && event.source === 'app' && event.progressId?.startsWith('browser-repair:') &&
    positionOf(event) > question && event.seq < error.seq &&
    /^(?:Reloaded|Reopened) chat to recover an interrupted response\.$/.test(event.message.text)) : undefined;
  for (const event of [...history].sort((a, b) => positionOf(a) - positionOf(b))) {
    if ((event.kind === 'assistant_message' ? event.seq : positionOf(event)) <= error.seq || duplicates.has(event.seq)) continue;
    if (event.kind === 'user_message' || event.kind === 'chat_error' ||
        (!question && event.kind === 'turn_start' && event.turnId !== error.turnId)) break;
    if (error.turnId && event.turnId === error.turnId && event.kind === 'turn_end' && event.outcome === 'completed') {
      completed = Math.max(completed, event.seq);
    }
    if (question && event.kind === 'assistant_message' && positionOf(event) > question && event.final === true &&
        (event.finalContentSeq ?? event.seq) > error.seq) completed = Math.max(completed, event.finalContentSeq ?? event.seq);
    if ((question || (error.turnId && event.turnId === error.turnId)) && event.time > error.time &&
        (event.kind === 'tool_call' || (event.kind === 'turn_start' && event.source === 'app'))) {
      continued = Math.max(continued, positionOf(event));
    }
    if (event.source === 'app' && event.kind === 'progress' && event.progressId?.startsWith('browser-repair:') &&
        (question || !event.turnId || (!!error.turnId && event.turnId === error.turnId))) repair = event;
  }
  if (completed > continued) return { title: t('Recovered after interruption'), message, resolved: true, reloaded: false, next: t('This turn later completed. You can continue with a new message.') };
  const reloaded = error.blocking !== true && !!repair && /^(?:Reloaded|Reopened) chat\b/.test(repair.message.text);
  const errorReloaded = earlierReload || (reloaded && repair?.message.text.endsWith('an interrupted response.'));
  const reloadPolicy = errorReloaded && error.blocking !== true
    ? t('We reload on an error only once per chat and turn. Further errors wait for tool calls to stop and the silence window before another reload.') : '';
  if (repair && error.blocking !== true) next = `${repair.message.text} ${thinking
    ? t('You can send a follow-up. After a confirmed refresh, automatic continuation waits five minutes and checks for new work before sending.')
    : reloadPolicy || t('Queued messages still wait until sending is safe. If the chat stays stuck, open ChatGPT and check the page before retrying.')}`;
  else if (reloadPolicy) next = `${t('This turn already received its automatic error reload.')} ${reloadPolicy}`;
  if (continued) {
    const work = t('Work continued after this notice. Queued messages still wait until sending is safe.');
    next = repair || reloadPolicy ? `${next} ${work}` : t('Work continued after this notice. Automatic continuation waits for work to settle; the failed page alone does not trigger another message.');
  } else if (reloaded && reloadPolicy) next += ` ${t('Queued messages still wait until sending is safe.')}`;
  return { title: reloaded ? t('Chat automatically refreshed') : title, message, next, resolved: false, reloaded };
}
