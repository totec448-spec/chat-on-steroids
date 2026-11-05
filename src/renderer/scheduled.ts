import { currentLanguage, onLanguageChange, t, tn } from './i18n.js';
import type { ScheduleRepeat, ScheduledRunListItem } from '../shared/schedule.js';

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ScheduledController {
  list: () => Promise<Reply<ScheduledRunListItem[]>>;
  pause: (sessionId: string, paused: boolean) => Promise<Reply<unknown>>;
  runNow: (sessionId: string) => Promise<Reply<unknown>>;
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

function repeatText(repeat: ScheduleRepeat): string {
  if (repeat.kind === 'hours') return repeat.every === 1 ? t('every hour') : tn('every {0} hour', 'every {0} hours', repeat.every);
  const at = repeat.at;
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
  let busy = false;
  let reading = 0;
  let feedback = '';

  const setStatus = (message: string, error = false): void => {
    feedback = message;
    status.hidden = !message;
    status.textContent = message ? t(message) : '';
    status.classList.toggle('is-error', error);
  };
  description.textContent = t('Manage the messages scheduled in your chats.');

  const render = (): void => {
    list.replaceChildren();
    if (records.length === 0) {
      const empty = element('div', 'scheduled-index-empty');
      empty.append(element('i', 'ico ph ph-clock'), element('h2', '', t('No scheduled messages yet')),
        element('p', '', t('Open a chat and choose Schedule… from its menu to add one.')));
      list.append(empty);
      return;
    }
    for (const record of records) {
      const row = element('article', 'scheduled-index-row');
      const title = element('h2', '', record.sessionTitle || t('Untitled chat'));
      const meta = element('p', 'scheduled-index-meta', record.paused ? t('Paused') :
        record.nextRunAt === null ? t('ended') : t('next {0}', [dateTime(record.nextRunAt)]));
      meta.append(document.createTextNode(' · ' + repeatText(record.repeat)));
      const body = element('div', 'scheduled-index-body');
      body.append(title, meta, element('p', 'scheduled-index-message', record.text));
      const actions = element('div', 'scheduled-index-actions');
      actions.append(
        button(t('Open chat'), () => controller.openChat(record.sessionId)),
        button(record.paused ? t('Resume') : t('Pause'), () => void mutate(() => controller.pause(record.sessionId, !record.paused))),
        button(t('Run now'), () => void mutate(() => controller.runNow(record.sessionId)), 'btn btn-solid'),
        button(t('Delete'), () => {
          if (window.confirm(t('Delete the schedule for {0}?', [record.sessionTitle || t('Untitled chat')]))) {
            void mutate(() => controller.delete(record.sessionId));
          }
        }, 'btn scheduled-index-delete')
      );
      for (const action of actions.querySelectorAll('button')) action.disabled = busy;
      row.append(body, actions);
      list.append(row);
    }
  };

  const refresh = async (): Promise<void> => {
    const own = ++reading;
    refreshButton.disabled = true;
    try {
      const result = await controller.list();
      if (own !== reading) return;
      if (!result.ok) throw new Error(result.error);
      records = result.data;
      setStatus('');
      render();
    } catch (error) {
      if (own === reading) setStatus(error instanceof Error ? error.message : t('Could not load schedules'), true);
    } finally {
      if (own === reading) refreshButton.disabled = false;
    }
  };

  const mutate = async (work: () => Promise<Reply<unknown>>): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await work();
      if (!result.ok) throw new Error(result.error);
      await refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('Operation failed'), true);
    } finally {
      busy = false;
      render();
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
