import { currentLanguage, onLanguageChange, t, tn } from './i18n.js';
import type { ScheduleRepeat, ScheduledRunListItem } from '../shared/schedule.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ScheduledController {
  list: () => Promise<Reply<ScheduledRunListItem[]>>;
  pause: (sessionId: string, paused: boolean) => Promise<Reply<unknown>>;
  runNow: (sessionId: string) => Promise<Reply<boolean>>;
  delete: (sessionId: string) => Promise<Reply<unknown>>;
  openChat: (sessionId: string) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', value = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function button(label: string, action: () => void, className = 'btn'): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

const dateTime = (instant: number): string => new Intl.DateTimeFormat(currentLanguage(), {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
}).format(new Date(instant));

const SCHEDULED_MESSAGE_PREVIEW_CHARS = 320;

/** Keep a broken or older IPC projection from putting an unbounded prompt into the DOM. */
function messagePreview(text: string): string {
  if (text.length <= SCHEDULED_MESSAGE_PREVIEW_CHARS) return text;
  // Do not leave half of a UTF-16 surrogate pair at the end of the visible preview.
  const preview = text.slice(0, SCHEDULED_MESSAGE_PREVIEW_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${preview}…`;
}

function repeatText(repeat: ScheduleRepeat): string {
  if (repeat.kind === 'hours') return repeat.every === 1 ? t('every hour') : tn('every {0} hour', 'every {0} hours', repeat.every);
  const [hour, minute] = repeat.at.split(':').map(Number) as [number, number];
  const at = new Date(2024, 0, 1, hour, minute).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit' });
  if (repeat.kind === 'daily') return t('every day at {0}', [at]);
  if (repeat.kind === 'weekdays') return t('every weekday at {0}', [at]);
  const weekday = new Intl.DateTimeFormat(currentLanguage(), { weekday: 'long' }).format(new Date(2024, 0, 7 + repeat.day));
  return t('every {0} at {1}', [weekday, at]);
}

/** A projection of scheduled-runs; this view never stores tasks or sends messages itself. */
export function initScheduled(controller: ScheduledController): { refresh: () => Promise<void> } {
  const list = document.getElementById('scheduledList')!;
  const status = document.getElementById('scheduledStatus')!;
  const description = document.getElementById('scheduledDescription')!;
  const refreshButton = document.getElementById('scheduledRefresh') as HTMLButtonElement;
  let records: ScheduledRunListItem[] = [];
  let recordsSignature = '';
  let busy = false;
  let refreshInFlight: Promise<void> | null = null;
  let refreshDirty = false;
  let refreshEpoch = 0;
  let refreshWaiters: Array<{ after: number; resolve: () => void }> = [];
  let feedback = '';
  let feedbackError = false;
  let actionFeedback: { message: string; error: boolean } | null = null;
  let loadFeedback: { message: string; error: boolean } | null = null;
  let feedbackLoadError = false;

  const setStatus = (message: string, error = false, loadError = false): void => {
    const next = message ? { message, error } : null;
    if (loadError) loadFeedback = next;
    else actionFeedback = next;
    const visible = actionFeedback ?? loadFeedback;
    feedback = visible?.message ?? '';
    feedbackError = visible?.error ?? false;
    feedbackLoadError = loadFeedback !== null;
    status.hidden = !feedback;
    status.textContent = feedback ? t(feedback) : '';
    status.classList.toggle('is-error', feedbackError);
  };
  description.textContent = t('Manage the messages scheduled in your chats.');

  type ActionFocus = { sessionId: string; action: string; row: number };
  const focusedAction = (): ActionFocus | null => {
    const active = document.activeElement as HTMLButtonElement | null;
    if (!active?.dataset.scheduledAction || !active.dataset.sessionId || !list.contains(active)) return null;
    const row = [...list.querySelectorAll<HTMLElement>('.scheduled-index-row')].indexOf(active.closest<HTMLElement>('.scheduled-index-row')!);
    return { sessionId: active.dataset.sessionId, action: active.dataset.scheduledAction, row };
  };
  const restoreFocus = (saved: ActionFocus | null): void => {
    if (!saved) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button[data-scheduled-action]')];
    const exact = buttons.find(node => node.dataset.sessionId === saved.sessionId && node.dataset.scheduledAction === saved.action);
    if (exact) { exact.focus(); return; }
    const rows = [...list.querySelectorAll<HTMLElement>('.scheduled-index-row')];
    const row = rows[Math.min(Math.max(saved.row, 0), rows.length - 1)];
    (row?.querySelector<HTMLButtonElement>('button[data-scheduled-action]') ?? refreshButton).focus();
  };
  const applyDisabled = (): void => {
    for (const action of list.querySelectorAll<HTMLButtonElement>('button[data-scheduled-action]'))
      action.disabled = busy || action.dataset.scheduledDisabled === 'true';
    refreshButton.disabled = busy;
    refreshButton.setAttribute('aria-busy', String(refreshInFlight !== null));
  };

  const render = (): void => {
    const focus = focusedAction();
    list.replaceChildren();
    if (records.length === 0) {
      const empty = element('div', 'scheduled-index-empty');
      empty.append(element('i', 'ico ph ph-clock'), element('h2', '', t('No scheduled messages yet')),
        element('p', '', t('Open a chat and choose Schedule… from its menu to add one.')));
      list.append(empty);
      applyDisabled();
      restoreFocus(focus);
      return;
    }
    for (const record of records) {
      const row = element('article', 'scheduled-index-row');
      const title = element('h2', '', record.sessionTitle || t('Untitled chat'));
      title.dir = 'auto';
      const meta = element('p', 'scheduled-index-meta', record.paused ? t('Paused') :
        record.retryDueAt !== undefined ? t('Retrying the run due {0}', [dateTime(record.retryDueAt)]) :
          record.nextRunAt === null ? t('ended') : t('next {0}', [dateTime(record.nextRunAt)]));
      if (record.missedDueAt !== undefined) meta.append(document.createTextNode(' · ' + t('missed {0}', [dateTime(record.missedDueAt)])));
      meta.append(document.createTextNode(' · ' + repeatText(record.repeat)));
      const body = element('div', 'scheduled-index-body');
      const message = element('p', 'scheduled-index-message', messagePreview(record.text));
      message.dir = 'auto';
      body.append(title, meta, message);
      const actions = element('div', 'scheduled-index-actions');
      const action = (label: string, name: string, run: () => void, className = 'btn', unavailable = false) => {
        const node = button(label, run, className);
        node.dataset.scheduledAction = name;
        node.dataset.sessionId = record.sessionId;
        node.dataset.scheduledDisabled = String(unavailable);
        return node;
      };
      actions.append(
        action(t('Open chat'), 'open', () => controller.openChat(record.sessionId)),
        action(record.paused ? t('Resume') : t('Pause'), 'pause', () => void mutate(() => controller.pause(record.sessionId, !record.paused))),
        action(t('Run now'), 'run-now', () => void mutate(() => controller.runNow(record.sessionId), queued => queued ? 'Queued' : 'Skipped'),
          'btn btn-solid', record.retryDueAt !== undefined),
        action(t('Delete'), 'delete', () => {
          if (window.confirm(t('Delete the schedule for {0}?', [record.sessionTitle || t('Untitled chat')]))) {
            void mutate(() => controller.delete(record.sessionId));
          }
        }, 'btn scheduled-index-delete')
      );
      row.append(body, actions);
      list.append(row);
    }
    applyDisabled();
    restoreFocus(focus);
  };

  const readOnce = async (): Promise<void> => {
    try {
      const result = await controller.list();
      if (!result.ok) throw new Error(result.error);
      const signature = JSON.stringify(result.data);
      if (feedbackLoadError) setStatus('', false, true);
      if (signature !== recordsSignature) {
        records = result.data;
        recordsSignature = signature;
        render();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('Could not load schedules'), true, true);
    }
  };

  const startRefresh = (): Promise<void> => {
    const epoch = ++refreshEpoch;
    let task: Promise<void>;
    task = readOnce().finally(() => {
      if (refreshInFlight === task) refreshInFlight = null;
      const ready = refreshWaiters.filter(waiter => waiter.after <= epoch);
      refreshWaiters = refreshWaiters.filter(waiter => waiter.after > epoch);
      ready.forEach(waiter => waiter.resolve());
      if (refreshDirty) {
        refreshDirty = false;
        void startRefresh();
      }
      applyDisabled();
    });
    refreshInFlight = task;
    applyDisabled();
    return task;
  };
  const refresh = (): Promise<void> => {
    if (refreshInFlight) {
      refreshDirty = true;
      return refreshInFlight;
    }
    return startRefresh();
  };
  // A mutation waits for one read requested after it, not for the push stream to become quiet.
  const refreshAfterMutation = (): Promise<void> => {
    if (!refreshInFlight) return refresh();
    const after = refreshEpoch + 1;
    refreshDirty = true;
    return new Promise(resolve => refreshWaiters.push({ after, resolve }));
  };

  const mutate = async <T>(work: () => Promise<Reply<T>>, success?: (data: T) => string): Promise<void> => {
    if (busy) return;
    const focus = focusedAction();
    busy = true;
    applyDisabled();
    try {
      const result = await work();
      if (!result.ok) throw new Error(result.error);
      // A successful mutation clears an older action error. A load error remains visible
      // until a successful read clears it, because setStatus keeps the two sources separate.
      if (!success) setStatus('');
      await refreshAfterMutation();
      if (success) setStatus(success(result.data));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('Operation failed'), true);
    } finally {
      busy = false;
      applyDisabled();
      restoreFocus(focus);
    }
  };
  refreshButton.addEventListener('click', () => void refresh());
  onLanguageChange(() => {
    description.textContent = t('Manage the messages scheduled in your chats.');
    if (feedback) status.textContent = t(feedback);
    render();
  });
  return { refresh };
}
