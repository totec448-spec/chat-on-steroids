import { currentLanguage, onLanguageChange, t, tn } from './i18n.js';
import type { ScheduleRepeat, ScheduledRunListItem } from '../shared/schedule.js';
import { initCardMenuDismissal } from './dom.js';

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
  // The next-run field already contains the clock time. Do not repeat it in recurrence.
  if (repeat.kind === 'daily') return t('Every day');
  if (repeat.kind === 'weekdays') return t('Weekdays');
  const weekday = new Intl.DateTimeFormat(currentLanguage(), { weekday: 'long' }).format(new Date(2024, 0, 7 + repeat.day));
  return `${t('Every week')} · ${weekday}`;
}

/** A projection of scheduled-runs; this view never stores tasks or sends messages itself. */
export function initScheduled(controller: ScheduledController): { refresh: () => Promise<void> } {
  initCardMenuDismissal();
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
    const active = document.activeElement as HTMLElement | null;
    if (!active?.dataset.scheduledAction || !active.dataset.sessionId || !list.contains(active)) return null;
    const row = [...list.querySelectorAll<HTMLElement>('.scheduled-index-row')].indexOf(active.closest<HTMLElement>('.scheduled-index-row')!);
    return { sessionId: active.dataset.sessionId, action: active.dataset.scheduledAction, row };
  };
  const restoreFocus = (saved: ActionFocus | null): void => {
    if (!saved) return;
    const buttons = [...list.querySelectorAll<HTMLElement>('[data-scheduled-action]')];
    // A closed overflow menu cannot receive focus; return to its visible summary instead.
    const action = saved.action === 'open' ? 'open' : 'menu';
    const exact = buttons.find(node => node.dataset.sessionId === saved.sessionId && node.dataset.scheduledAction === action);
    if (exact) { exact.focus(); return; }
    const rows = [...list.querySelectorAll<HTMLElement>('.scheduled-index-row')];
    const row = rows[Math.min(Math.max(saved.row, 0), rows.length - 1)];
    (row?.querySelector<HTMLElement>('[data-scheduled-action="open"]') ?? refreshButton).focus();
  };
  const applyDisabled = (): void => {
    for (const action of list.querySelectorAll<HTMLButtonElement>('button[data-scheduled-action]'))
      action.disabled = busy || action.dataset.scheduledDisabled === 'true';
    refreshButton.disabled = busy;
    refreshButton.setAttribute('aria-busy', String(refreshInFlight !== null));
  };

  const confirmDelete = (record: ScheduledRunListItem, returnFocus: HTMLElement): void => {
    const dialog = element('dialog', 'plugin-dialog pet-delete-dialog');
    const title = element('h2', '', t('Delete the schedule for {0}?', [record.sessionTitle || t('Untitled chat')]));
    title.id = 'scheduledDeleteTitle';
    dialog.setAttribute('aria-labelledby', title.id);
    const head = element('div', 'plugin-dialog-head');
    head.append(title);
    const body = element('div', 'plugin-dialog-body');
    const actions = element('div', 'pet-delete-actions');
    const dismiss = (): void => {
      if (typeof dialog.close === 'function') dialog.close();
      else { dialog.remove(); if (returnFocus.isConnected) returnFocus.focus(); }
    };
    const cancel = button(t('Cancel'), dismiss, 'btn btn-solid pet-delete-cancel');
    const remove = button(t('Delete'), () => {
      dismiss();
      if (returnFocus.isConnected) returnFocus.focus();
      void mutate(() => controller.delete(record.sessionId));
    }, 'btn plugin-destructive pet-delete-confirm');
    actions.append(cancel, remove); body.append(actions); dialog.append(head, body);
    dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus.isConnected) returnFocus.focus(); });
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    cancel.focus();
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
      const meta = element('p', 'scheduled-index-meta', record.deliveryBlock === 'unconfirmed' ? t('Delivery not confirmed') :
        record.deliveryBlock === 'pending' ? t('Delivery confirmation pending') : record.paused ? t('Paused') :
          record.retryDueAt !== undefined ? t('Retrying the run due {0}', [dateTime(record.retryDueAt)]) :
            record.nextRunAt === null ? t('ended') : t('next {0}', [dateTime(record.nextRunAt)]));
      if (record.deliveryBlock && record.paused) meta.append(document.createTextNode(' · ' + t('Paused')));
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
      const menu = element('details', 'plugin-menu scheduled-index-menu');
      const summary = element('summary');
      summary.dataset.scheduledAction = 'menu';
      summary.dataset.sessionId = record.sessionId;
      summary.setAttribute('aria-label', t('Actions for {0}', [record.sessionTitle || t('Untitled chat')]));
      const dots = element('i', 'ico ph ph-dots-three');
      dots.setAttribute('aria-hidden', 'true');
      summary.append(dots);
      menu.addEventListener('keydown', event => {
        // Keep focus on a visible control when Escape dismisses a keyboard-opened menu.
        if (event.key === 'Escape' && menu.open) {
          menu.open = false;
          summary.focus();
          event.stopPropagation();
        }
      });
      const options = element('div', 'plugin-menu-actions');
      options.append(
        action(record.paused ? t('Resume') : t('Pause'), 'pause', () => void mutate(() => controller.pause(record.sessionId, !record.paused))),
        action(t('Run now'), 'run-now', () => void mutate(() => controller.runNow(record.sessionId), queued => queued ? 'Queued' : 'Skipped'),
          'btn', record.retryDueAt !== undefined || record.deliveryBlock !== undefined),
        action(t('Delete'), 'delete', () => confirmDelete(record, summary), 'btn plugin-destructive')
      );
      menu.append(summary, options);
      actions.append(action(t('Open chat'), 'open', () => controller.openChat(record.sessionId)), menu);
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
