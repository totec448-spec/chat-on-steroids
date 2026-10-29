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
  const retry = $<HTMLButtonElement>('scheduleRetry');
  const fieldset = $('scheduleFields');
  const fields = [text, repeat, every, day, at, untilKind, until, catchUp];
  let sessionId = '', draftText = '';
  let busy = false;
  // Set while the saved schedule could not be read: nothing here may be edited or saved, since a
  // "new" schedule would overwrite the one that exists (Haz on #1835).
  let unreadable = false;
  // Set while a read runs. Each read has its number: a late answer for an earlier opening (another
  // chat, or this one before it was opened again) is dropped, never shown in this one (CodeRabbit).
  let loading = false;
  let reading = 0;

  const close = () => { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  const showError = (message: string | null) => { error.hidden = !message; error.textContent = message ?? ''; };
  const setBusy = (next: boolean) => { busy = next; submit.disabled = next || loading; remove.disabled = next; };

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
    if (busy || unreadable || loading) return;
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
    if (busy || loading) return;
    setBusy(true);
    try {
      const reply = await api.deleteSchedule(sessionId);
      if (!reply.ok) { showError(t(reply.error)); return; }
      close();
      changed(sessionId);
    } finally { setBusy(false); }
  });
  for (const id of ['scheduleCancel', 'scheduleClose']) $(id).addEventListener('click', () => close());
  retry.addEventListener('click', () => { void load(); });

  /** Reads the chat's schedule and fills the form from it, or shows why it can't be edited now. */
  async function load(): Promise<void> {
    const mine = ++reading, owner = sessionId;
    showError(null);
    // Until this chat's own schedule is read, nothing can be edited or saved, and nothing an
    // earlier opening left in the fields stays there.
    loading = true;
    for (const field of fields) field.disabled = true;
    submit.disabled = true;
    remove.hidden = true;
    retry.hidden = true;
    text.value = '';
    const reply = await api.getSchedule(owner);
    if (mine !== reading || owner !== sessionId) return;
    loading = false;
    submit.disabled = busy;
    unreadable = !reply.ok;
    for (const field of fields) field.disabled = unreadable;
    // Nothing that could be mistaken for the saved schedule is shown while it can't be read.
    fieldset.hidden = unreadable;
    submit.hidden = unreadable;
    retry.hidden = !unreadable;
    if (!reply.ok) {
      remove.hidden = true;
      showError(t(reply.error));
      retry.focus();
      return;
    }
    const existing = reply.data;
    text.value = existing?.text ?? draftText.trim();
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
    text.focus();
  }

  return {
    async open(id: string, draft: string): Promise<void> {
      sessionId = id;
      draftText = draft;
      setBusy(false);
      fillChoices();
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      await load();
    }
  };
}
