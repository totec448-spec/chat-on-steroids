import type { AppApi } from '../preload/index.js';
import type { ScheduleRepeat } from '../shared/schedule.js';
import { currentLanguage, t, tn } from './i18n.js';

/**
 * A chat's schedule (#1826, Haz's review), opened from the chat's ⋯ menu: the message, how it
 * repeats (every n hours, daily, weekdays or weekly at a local time), until when, and whether a
 * run missed while the app was closed or asleep is caught up (off: skipped). One schedule per
 * chat, so opening it again edits that one and offers Delete. The main process checks everything
 * again; its refusals are sentences shown in the chosen language.
 */
export function initScheduleDialog(
  api: Pick<AppApi, 'getSchedule' | 'saveSchedule' | 'deleteSchedule'>,
  changed: (sessionId: string) => void
): { open(sessionId: string, draft: string): Promise<void> } {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('scheduleDialog');
  const form = $<HTMLFormElement>('scheduleForm');
  const text = $<HTMLTextAreaElement>('scheduleText');
  const repeat = $<HTMLSelectElement>('scheduleRepeat');
  const every = $<HTMLSelectElement>('scheduleEvery');
  const day = $<HTMLSelectElement>('scheduleDay');
  const at = $<HTMLInputElement>('scheduleAt');
  const untilKind = $<HTMLSelectElement>('scheduleUntilKind');
  const until = $<HTMLInputElement>('scheduleUntil');
  const catchUp = $<HTMLInputElement>('scheduleCatchUp');
  const error = $('scheduleError');
  const remove = $<HTMLButtonElement>('scheduleDelete');
  const submit = $<HTMLButtonElement>('scheduleSubmit');
  let sessionId = '';
  let busy = false;

  const close = () => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const showError = (message: string | null) => { error.hidden = !message; error.textContent = message ?? ''; };
  const setBusy = (next: boolean) => { busy = next; submit.disabled = next; remove.disabled = next; };

  const option = (label: string, value: string) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
  // The lists are written in the chosen language each time the dialog opens.
  function fillChoices(): void {
    every.replaceChildren(...Array.from({ length: 24 }, (_, index) => option(tn('{0} hour', '{0} hours', index + 1), String(index + 1))));
    // Monday first, as most calendars here; the value stays Date#getDay's (0 is Sunday).
    const names = new Intl.DateTimeFormat(currentLanguage(), { weekday: 'long' });
    day.replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map(weekday => option(names.format(new Date(2024, 0, 7 + weekday)), String(weekday))));
    $('scheduleZone').textContent = t("Times are this computer's ({0}).", [Intl.DateTimeFormat().resolvedOptions().timeZone]);
  }
  function showFields(): void {
    $('scheduleEveryField').hidden = repeat.value !== 'hours';
    $('scheduleAtField').hidden = repeat.value === 'hours';
    $('scheduleDayField').hidden = repeat.value !== 'weekly';
    $('scheduleUntilField').hidden = untilKind.value !== 'date';
  }
  const dateOf = (instant: number) => {
    const d = new Date(instant);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function chosenRepeat(): ScheduleRepeat {
    if (repeat.value === 'hours') return { kind: 'hours', every: Number(every.value) };
    if (repeat.value === 'weekly') return { kind: 'weekly', day: Number(day.value), at: at.value };
    return { kind: repeat.value === 'daily' ? 'daily' : 'weekdays', at: at.value };
  }
  /** The end of the chosen last day, in this computer's time, or null for Forever. */
  function chosenUntil(): number | null {
    if (untilKind.value !== 'date' || !until.value) return null;
    const [year, month, date] = until.value.split('-').map(Number) as [number, number, number];
    return new Date(year, month - 1, date, 23, 59, 59, 999).getTime();
  }

  repeat.addEventListener('change', showFields);
  untilKind.addEventListener('change', showFields);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (!text.value.trim()) { showError(t('Write the message to send.')); return; }
    if (untilKind.value === 'date' && !until.value) { showError(t('Choose the end date.')); return; }
    showError(null);
    setBusy(true);
    try {
      const reply = await api.saveSchedule({ sessionId, text: text.value.trim(), repeat: chosenRepeat(), until: chosenUntil(), catchUp: catchUp.checked });
      if (!reply.ok) { showError(t(reply.error)); return; }
      close();
      changed(sessionId);
    } finally { setBusy(false); }
  });
  remove.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      const reply = await api.deleteSchedule(sessionId);
      if (!reply.ok) { showError(t(reply.error)); return; }
      close();
      changed(sessionId);
    } finally { setBusy(false); }
  });
  for (const id of ['scheduleCancel', 'scheduleClose']) $(id).addEventListener('click', () => close());

  return {
    async open(id: string, draft: string): Promise<void> {
      sessionId = id;
      showError(null);
      setBusy(false);
      fillChoices();
      const reply = await api.getSchedule(id);
      const existing = reply.ok ? reply.data : null;
      text.value = existing?.text ?? draft.trim();
      const kind = existing?.repeat.kind ?? 'weekdays';
      repeat.value = kind;
      every.value = String(existing?.repeat.kind === 'hours' ? existing.repeat.every : 2);
      at.value = existing && existing.repeat.kind !== 'hours' ? existing.repeat.at : '09:00';
      day.value = String(existing?.repeat.kind === 'weekly' ? existing.repeat.day : 1);
      untilKind.value = existing?.until ? 'date' : 'forever';
      until.value = existing?.until ? dateOf(existing.until) : '';
      catchUp.checked = existing?.catchUp === true;
      remove.hidden = !existing;
      showFields();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      text.focus();
    }
  };
}
