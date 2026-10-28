import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * #1826 (Haz's review): a chat's schedule is set from its ⋯ menu in one small dialog: the message,
 * how it repeats, until when, and whether missed runs are caught up (off: they are skipped). Times
 * are this computer's, and the dialog says so. One schedule per chat: opening it again edits it.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const SESSION = 'session-aaaa-0001';
const record = (over: Record<string, unknown> = {}) => ({ id: '0b6c4e1c-1f1e-4a4f-9d39-3c2f0e1a2b3c', sessionId: SESSION, text: 'Check the issues',
  repeat: { kind: 'weekdays', at: '09:00' }, until: null, paused: false, createdAt: 1, lastDueAt: null, ...over });

async function dialog(existing: unknown = null, api: Record<string, unknown> = {}) {
  const { initScheduleDialog } = await import('../src/renderer/schedule-dialog.js');
  const calls = {
    getSchedule: vi.fn(() => ok(existing)),
    saveSchedule: vi.fn((request: any) => ok(record(request))),
    deleteSchedule: vi.fn(() => ok(true)),
    ...api
  };
  const changed = vi.fn();
  const opened = initScheduleDialog(calls as any, changed);
  return { calls, changed, opened };
}
const change = (id: string, value: string) => {
  const control = $<HTMLInputElement | HTMLSelectElement>(id);
  control.value = value;
  control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  control.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const submit = async () => { $('scheduleForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle(); };

it('starts a new schedule from the draft, every weekday at 09:00, missed runs skipped, and saves it', async () => {
  const { calls, changed, opened } = await dialog();
  await opened.open(SESSION, 'Run the tests and say what broke');
  expect($<HTMLDialogElement>('scheduleDialog').open).toBe(true);
  expect($<HTMLTextAreaElement>('scheduleText').value).toBe('Run the tests and say what broke');
  expect($<HTMLSelectElement>('scheduleRepeat').value).toBe('weekdays');
  expect($<HTMLInputElement>('scheduleAt').value).toBe('09:00');
  expect($<HTMLInputElement>('scheduleCatchUp').checked).toBe(false);
  expect($('scheduleDelete').hidden).toBe(true);
  // The time zone the times are in, shown next to them.
  expect($('scheduleZone').textContent).toMatch(/^Times are this computer's \(.+\)\.$/);
  await submit();
  expect(calls.saveSchedule).toHaveBeenCalledWith({ sessionId: SESSION, text: 'Run the tests and say what broke', repeat: { kind: 'weekdays', at: '09:00' }, until: null, catchUp: false });
  expect(changed).toHaveBeenCalled();
  expect($<HTMLDialogElement>('scheduleDialog').open).toBe(false);
});

it('offers every repeat with only its own fields, and an end date at the end of that day', async () => {
  const { calls, opened } = await dialog();
  await opened.open(SESSION, 'Hourly check');
  change('scheduleRepeat', 'hours');
  expect($('scheduleEveryField').hidden).toBe(false);
  expect($('scheduleAtField').hidden).toBe(true);
  expect($('scheduleDayField').hidden).toBe(true);
  // The shortest interval is one hour.
  expect([...$<HTMLSelectElement>('scheduleEvery').options].map(option => option.value)[0]).toBe('1');
  change('scheduleEvery', '2');
  change('scheduleUntilKind', 'date');
  expect($('scheduleUntilField').hidden).toBe(false);
  change('scheduleUntil', '2099-01-31');
  $<HTMLInputElement>('scheduleCatchUp').checked = true;
  await submit();
  expect(calls.saveSchedule).toHaveBeenLastCalledWith({ sessionId: SESSION, text: 'Hourly check', repeat: { kind: 'hours', every: 2 }, until: new Date(2099, 0, 31, 23, 59, 59, 999).getTime(), catchUp: true });
  await opened.open(SESSION, 'Weekly');
  change('scheduleRepeat', 'weekly');
  expect($('scheduleDayField').hidden).toBe(false);
  change('scheduleDay', '1');
  change('scheduleAt', '07:30');
  await submit();
  expect(calls.saveSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ repeat: { kind: 'weekly', day: 1, at: '07:30' }, until: null }));
});

it("edits a chat's existing schedule and can delete it", async () => {
  const { calls, changed, opened } = await dialog(record({ repeat: { kind: 'daily', at: '18:15' }, until: new Date(2099, 4, 2, 23, 59, 59, 999).getTime(), catchUp: true }));
  await opened.open(SESSION, 'ignored draft');
  expect($<HTMLTextAreaElement>('scheduleText').value).toBe('Check the issues');
  expect($<HTMLSelectElement>('scheduleRepeat').value).toBe('daily');
  expect($<HTMLInputElement>('scheduleAt').value).toBe('18:15');
  expect($<HTMLSelectElement>('scheduleUntilKind').value).toBe('date');
  expect($<HTMLInputElement>('scheduleUntil').value).toBe('2099-05-02');
  expect($<HTMLInputElement>('scheduleCatchUp').checked).toBe(true);
  expect($('scheduleDelete').hidden).toBe(false);
  $('scheduleDelete').click(); await settle();
  expect(calls.deleteSchedule).toHaveBeenCalledWith(SESSION);
  expect(changed).toHaveBeenCalled();
  expect($<HTMLDialogElement>('scheduleDialog').open).toBe(false);
});

it("says the main process's refusal in the chosen words and keeps the dialog open", async () => {
  const { opened } = await dialog(null, { saveSchedule: vi.fn(() => Promise.resolve({ ok: false as const, error: 'Choose an end date in the future.' })) });
  await opened.open(SESSION, 'x');
  await submit();
  expect($('scheduleError').hidden).toBe(false);
  expect($('scheduleError').textContent).toBe('Choose an end date in the future.');
  expect($<HTMLDialogElement>('scheduleDialog').open).toBe(true);
  // An empty message is refused before anything is asked.
  $<HTMLTextAreaElement>('scheduleText').value = '   ';
  await submit();
  expect($('scheduleError').textContent).toBe('Write the message to send.');
});

it('asks for the end date when "A date" is chosen without one, instead of saving a schedule that never ends (CodeRabbit)', async () => {
  const { calls, opened } = await dialog();
  await opened.open(SESSION, 'Check the issues');
  change('scheduleUntilKind', 'date');
  change('scheduleUntil', '');
  await submit();
  expect(calls.saveSchedule).not.toHaveBeenCalled();
  expect($('scheduleError').hidden).toBe(false);
  expect($('scheduleError').textContent).toBe('Choose the end date.');
  expect($<HTMLDialogElement>('scheduleDialog').open).toBe(true);
});


it('never opens an editable new schedule when the saved one could not be read, and offers Retry (Haz)', async () => {
  // A schedule exists, but the first read fails: a "new" schedule here would overwrite it on Save.
  const reads = [Promise.resolve({ ok: false as const, error: 'The schedule could not be read.' }), ok(record({ text: 'Check the issues' }))];
  const { calls, opened } = await dialog(null, { getSchedule: vi.fn(() => reads.shift()) });
  await opened.open(SESSION, 'A draft that must not replace the saved message');
  expect($<HTMLDialogElement>('scheduleDialog').open).toBe(true);
  expect($('scheduleError').hidden).toBe(false);
  expect($('scheduleError').textContent).toBe('The schedule could not be read.');
  for (const id of ['scheduleText', 'scheduleRepeat', 'scheduleAt', 'scheduleUntilKind', 'scheduleCatchUp']) expect($<HTMLInputElement>(id).disabled, id).toBe(true);
  expect($('scheduleFields').hidden).toBe(true);
  expect($('scheduleSubmit').hidden).toBe(true);
  expect($('scheduleDelete').hidden).toBe(true);
  await submit();
  expect(calls.saveSchedule).not.toHaveBeenCalled();
  // Retry reads it again; once it can be read, the saved schedule is what the dialog edits.
  expect($('scheduleRetry').hidden).toBe(false);
  $('scheduleRetry').click();
  await settle();
  expect($('scheduleError').hidden).toBe(true);
  expect($<HTMLTextAreaElement>('scheduleText').value).toBe('Check the issues');
  expect($<HTMLTextAreaElement>('scheduleText').disabled).toBe(false);
  expect($('scheduleFields').hidden).toBe(false);
  expect($('scheduleSubmit').hidden).toBe(false);
  expect($('scheduleDelete').hidden).toBe(false);
  expect($('scheduleRetry').hidden).toBe(true);
});

it("never fills one chat's dialog with another chat's late read, and offers nothing to edit or save while reading (CodeRabbit)", async () => {
  const reads = new Map<string, (value: unknown) => void>();
  const { calls, opened } = await dialog(null, {
    getSchedule: vi.fn((id: string) => new Promise(resolve => reads.set(id, resolve)))
  });
  const OTHER = 'session-bbbb-0002';
  void opened.open(SESSION, '');
  await settle();
  // While the read runs, the form can't be edited or saved.
  expect($<HTMLTextAreaElement>('scheduleText').disabled).toBe(true);
  expect($<HTMLButtonElement>('scheduleSubmit').disabled).toBe(true);
  $('scheduleCancel').click();
  const second = opened.open(OTHER, 'Draft for B');
  await settle();
  // A's read answers late: B's dialog stays B's, still waiting for its own read.
  reads.get(SESSION)!({ ok: true, data: record({ text: "A's schedule" }) });
  await settle();
  expect($<HTMLTextAreaElement>('scheduleText').value).not.toBe("A's schedule");
  expect($<HTMLButtonElement>('scheduleSubmit').disabled).toBe(true);
  await submit();
  expect(calls.saveSchedule).not.toHaveBeenCalled();
  reads.get(OTHER)!({ ok: true, data: null });
  await second;
  expect($<HTMLTextAreaElement>('scheduleText').value).toBe('Draft for B');
  expect($<HTMLTextAreaElement>('scheduleText').disabled).toBe(false);
  expect($<HTMLButtonElement>('scheduleSubmit').disabled).toBe(false);
  await submit();
  expect(calls.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ sessionId: OTHER, text: 'Draft for B' }));
});
