import type { AppApi } from '../preload/index.js';
import { DEFAULT_PHONE_PUSH, type PhonePushSettings } from '../shared/phone-push.js';
import type { AppState } from '../shared/types.js';
import { currentLanguage, onLanguageChange, t, tn, ui } from './i18n.js';

/**
 * Settings → General → Phone notifications (ntfy). The form reads into `ui.phonePush` with the rest
 * of the settings; the access token goes straight to secure storage and never comes back.
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const checkbox = (id: string) => $<HTMLInputElement>(id);

/** A long random topic: guessing it is the only way to read its messages on a public server. */
export function newTopic(random: (count: number) => number[] = count => [...crypto.getRandomValues(new Uint8Array(count))]): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  // 32 letters: a byte's top five bits pick one evenly, so 20 of them are 100 bits.
  return 'cos-' + random(20).map(byte => alphabet[(byte & 0xff) >> 3]).join('');
}

/** The form's phone settings; quiet hours that are not one of the choices are kept as they are. */
export function readPhonePush(previous: PhonePushSettings | undefined): PhonePushSettings {
  const finished = $<HTMLSelectElement>('phonePushFinished').value;
  const quiet = $<HTMLSelectElement>('phonePushQuiet').value;
  const [from, to] = quiet.split('-');
  return {
    enabled: checkbox('phonePushEnabled').checked,
    // Cleared stays empty and is refused while on: ntfy.sh is chosen only with Default.
    server: $<HTMLInputElement>('phonePushServer').value.trim(),
    topic: $<HTMLInputElement>('phonePushTopic').value.trim(),
    needsYou: checkbox('phonePushNeedsYou').checked,
    failures: checkbox('phonePushFailures').checked,
    finishedAfterMinutes: finished === 'never' ? null : Number(finished),
    onlyWhenAway: checkbox('phonePushAway').checked,
    quietHours: quiet === 'custom' ? previous?.quietHours ?? null : from && to ? { from, to } : null,
    includeDetails: checkbox('phonePushDetails').checked
  };
}

/** What each control showed when it was last painted, to tell a local edit from an untouched control. */
const painted = new Map<string, string | boolean>();
const shownValue = (element: HTMLElement): string | boolean =>
  element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : (element as HTMLInputElement).value;

/**
 * Paints the saved settings, leaving alone a field the person is editing. A focused control they
 * have not changed follows the saved value, or a later save would write its stale value back.
 */
export function applyPhonePush(state: AppState): void {
  const push = { ...DEFAULT_PHONE_PUSH, ...state.config.ui.phonePush };
  // `next` is what the control will show for the saved settings: a focused value that differs from
  // both what was painted and what was saved is an unsaved edit; one that was saved is painted now.
  const set = (id: string, next: string | boolean, apply: () => void) => {
    const element = $(id);
    const shown = shownValue(element);
    if (document.activeElement === element && painted.has(id) && painted.get(id) !== shown && shown !== next) return;
    apply();
    painted.set(id, shownValue(element));
  };
  const finishedValue = push.finishedAfterMinutes === null ? 'never' : String(push.finishedAfterMinutes);
  const quietValue = push.quietHours ? `${push.quietHours.from}-${push.quietHours.to}` : '';
  set('phonePushEnabled', push.enabled, () => { checkbox('phonePushEnabled').checked = push.enabled; });
  $('phonePushOptions').hidden = !push.enabled;
  set('phonePushTopic', push.topic, () => { $<HTMLInputElement>('phonePushTopic').value = push.topic; });
  set('phonePushServer', push.server, () => { $<HTMLInputElement>('phonePushServer').value = push.server; });
  syncServerDefault();
  set('phonePushNeedsYou', push.needsYou, () => { checkbox('phonePushNeedsYou').checked = push.needsYou; });
  set('phonePushFailures', push.failures, () => { checkbox('phonePushFailures').checked = push.failures; });
  set('phonePushAway', push.onlyWhenAway, () => { checkbox('phonePushAway').checked = push.onlyWhenAway; });
  set('phonePushDetails', push.includeDetails, () => { checkbox('phonePushDetails').checked = push.includeDetails; });
  set('phonePushFinished', finishedValue, () => {
    const select = $<HTMLSelectElement>('phonePushFinished');
    const value = finishedValue;
    // A value Settings does not offer (a hand-edited file) is shown as its own choice and kept, as
    // the quiet hours are; showing a neighbour would save that neighbour with the next change.
    select.querySelector('option[data-custom]')?.remove();
    if (![...select.options].some(option => option.value === value)) {
      const custom = document.createElement('option');
      custom.value = value;
      custom.dataset.custom = '';
      const minutes = push.finishedAfterMinutes ?? 0;
      custom.textContent = tn('After {0} minute of work', 'After {0} minutes of work', minutes, [minutes]);
      // In order among the minute choices, so the menu still reads from short to long.
      const after = [...select.options].find(option => option.value !== 'never' && Number(option.value) > minutes);
      select.insertBefore(custom, after ?? null);
    }
    select.value = value;
  });
  set('phonePushQuiet', quietValue, () => {
    const select = $<HTMLSelectElement>('phonePushQuiet');
    const value = quietValue;
    select.querySelector('option[value="custom"]')?.remove();
    if (value && ![...select.options].some(option => option.value === value)) {
      const custom = document.createElement('option');
      custom.value = 'custom';
      custom.textContent = quietLabel(push.quietHours!.from, push.quietHours!.to);
      select.append(custom);
      select.value = 'custom';
    } else select.value = value;
  });
  alignFieldButtons();
  $('phonePushTokenStatus').textContent = state.hasPhonePushToken
    ? t('A token is saved. Save an empty field to remove it.')
    : t('Only if your server needs one. Kept in secure storage.');
}

/**
 * The field rows' buttons take the widest one's width, so the three text fields end on one edge in
 * every language and at every zoom. Measured while shown; hidden rows have no width.
 */
/** "Default" does nothing while the server already is ntfy.sh, so it says so. */
function syncServerDefault(): void {
  $<HTMLButtonElement>('phonePushServerDefault').disabled = $<HTMLInputElement>('phonePushServer').value.trim() === DEFAULT_PHONE_PUSH.server;
}

function alignFieldButtons(): void {
  const buttons = [...document.querySelectorAll<HTMLElement>('.phone-push-control .btn')];
  for (const button of buttons) button.style.minWidth = '';
  if ($('phonePushOptions').hidden) return;
  const widest = Math.max(...buttons.map(button => button.getBoundingClientRect().width));
  if (widest > 0) for (const button of buttons) button.style.minWidth = `${Math.ceil(widest)}px`;
}

/** "22:00 – 07:00", or "10:00 PM – 7:00 AM", as the app language writes times. */
function quietLabel(from: string, to: string): string {
  const clock = (value: string) => {
    const [hours, minutes] = value.split(':').map(Number);
    try { return new Intl.DateTimeFormat(currentLanguage(), { hour: 'numeric', minute: '2-digit' }).format(new Date(2026, 0, 1, hours, minutes)); } catch { return value; }
  };
  return `${clock(from)} – ${clock(to)}`;
}

export function initPhonePushSettings(api: Pick<AppApi, 'testPhonePush' | 'setPhonePushToken' | 'writeClipboard'>, hooks: {
  save(): Promise<boolean>; applied(state: AppState): void; toast(message: string): void;
}): void {
  for (const option of $<HTMLSelectElement>('phonePushQuiet').options) {
    const [from, to] = option.value.split('-');
    if (from && to) ui(option, 'textContent', () => quietLabel(from, to));
  }
  // Turning it on for the first time comes with a fresh topic, so the next step is the phone.
  checkbox('phonePushEnabled').addEventListener('change', () => {
    const topic = $<HTMLInputElement>('phonePushTopic');
    if (checkbox('phonePushEnabled').checked && !topic.value.trim()) topic.value = newTopic();
    $('phonePushOptions').hidden = !checkbox('phonePushEnabled').checked;
    alignFieldButtons();
  });
  onLanguageChange(alignFieldButtons);
  // Server, token and a new topic are rarely needed with ntfy.sh; they wait behind Advanced.
  $('phonePushAdvanced').addEventListener('toggle', alignFieldButtons);
  $('phonePushCopyTopic').addEventListener('click', async () => {
    const topic = $<HTMLInputElement>('phonePushTopic').value.trim();
    if (!topic) return;
    const reply = await api.writeClipboard(topic);
    hooks.toast(reply.ok ? t('Topic copied') : t(reply.error));
  });
  $('phonePushServerDefault').addEventListener('click', () => {
    const server = $<HTMLInputElement>('phonePushServer');
    if (server.value.trim() === DEFAULT_PHONE_PUSH.server) return;
    server.value = DEFAULT_PHONE_PUSH.server;
    syncServerDefault();
    void hooks.save();
  });
  $('phonePushServer').addEventListener('input', syncServerDefault);
  $('phonePushNewTopic').addEventListener('click', () => {
    $<HTMLInputElement>('phonePushTopic').value = newTopic();
    void hooks.save();
    hooks.toast(t('New topic. Subscribe to it in the ntfy app on your phone.'));
  });
  let savingToken = false;
  $('phonePushTokenSave').addEventListener('click', async () => {
    if (savingToken) return;
    savingToken = true;
    const field = $<HTMLInputElement>('phonePushToken');
    // The answer is about this value; a newer one typed meanwhile is a draft and stays.
    const submitted = field.value;
    try {
      const reply = await api.setPhonePushToken(submitted);
      if (!reply.ok) { hooks.toast(t(reply.error)); return; }
      hooks.toast(submitted.trim() ? t('Access token saved.') : t('Access token removed.'));
      if (field.value === submitted) field.value = '';
      hooks.applied(reply.data);
    } finally { savingToken = false; }
  });
  let testing = false;
  $('phonePushTest').addEventListener('click', async () => {
    if (testing) return;
    testing = true;
    const status = $('phonePushTestStatus');
    const button = $<HTMLButtonElement>('phonePushTest');
    button.disabled = true;
    status.classList.remove('is-warn');
    status.textContent = t('Sending…');
    try {
      // What was just typed is saved first, so the test uses it. A save that did not happen would
      // test the previous settings and report on them, so nothing is sent.
      if (!await hooks.save().catch(() => false)) {
        status.textContent = t('The settings could not be saved, so no test was sent.');
        status.classList.add('is-warn');
        return;
      }
      const reply = await api.testPhonePush();
      status.textContent = reply.ok ? t('Sent. Check your phone.') : t(reply.error);
      status.classList.toggle('is-warn', !reply.ok);
    } finally { testing = false; button.disabled = false; }
  });
}
