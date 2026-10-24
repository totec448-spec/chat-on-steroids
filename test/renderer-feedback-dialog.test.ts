import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Send feedback: a problem report needs what happened and the diagnostics report; an idea needs
 * both of its fields. GitHub opens filled in; the draft survives closing until it got there.
 */
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
});
afterEach(() => dom.window.close());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const type = (id: string, value: string) => { $<HTMLTextAreaElement>(id).value = value; };
const submit = async () => { $('feedbackForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle(); };
const update = { current: '2.1.46', latest: '2.1.46', stage: 'idle' as const, error: null, checkedAt: 1 };

async function setup(overrides: Record<string, unknown> = {}, status: unknown = update) {
  const api = {
    openFeedbackIssue: vi.fn(async () => ({ ok: true as const, data: { trimmed: false } })),
    saveDiagnosticsReport: vi.fn(async () => ({ ok: true as const, data: { saved: true as const, name: 'diagnostics-2026-10-24.txt' } })),
    writeClipboard: vi.fn(async () => ({ ok: true as const, data: true })),
    ...overrides
  };
  const openActivity = vi.fn();
  const { initFeedbackDialog } = await import('../src/renderer/feedback-dialog.js');
  const dialog = initFeedbackDialog(api as any, { update: () => status as any, openActivity });
  return { api, dialog, openActivity };
}

it('sends a problem report only with what happened and a saved diagnostics report', async () => {
  const { api, dialog } = await setup();
  dialog.open();
  expect($<HTMLDialogElement>('feedbackDialog').open).toBe(true);
  expect(document.activeElement).toBe($('feedbackWhat'));
  await submit();
  expect($('feedbackError').textContent).toBe('Write what happened.');
  type('feedbackWhat', 'The Stop button stays grey.');
  await submit();
  expect($('feedbackError').textContent).toBe('Save the diagnostics report first. A problem report on GitHub needs it.');
  expect(api.openFeedbackIssue).not.toHaveBeenCalled();
  $('feedbackSaveReport').click();
  await settle();
  expect($('feedbackReportNote').textContent).toBe('Saved as diagnostics-2026-10-24.txt. Read it, then attach it on GitHub.');
  expect($('feedbackSaveReport').textContent).toBe('Save again…');
  type('feedbackSteps', '  ');
  $<HTMLSelectElement>('feedbackFrequency').value = 'Sometimes';
  await submit();
  expect(api.openFeedbackIssue).toHaveBeenCalledWith({ kind: 'bug', what: 'The Stop button stays grey.', frequency: 'Sometimes' });
  expect($('feedbackForm').hidden).toBe(true);
  expect($('feedbackDone').hidden).toBe(false);
  expect($('feedbackDoneText').textContent).toBe('GitHub is open in your browser. Attach diagnostics-2026-10-24.txt in its Diagnostics report box yourself, then submit.');
  expect($('feedbackDoneTrimmed').hidden).toBe(true);
  // What reached GitHub is cleared; the next report starts empty and saves its own diagnostics.
  $('feedbackDoneClose').click();
  dialog.open();
  expect($<HTMLTextAreaElement>('feedbackWhat').value).toBe('');
  expect($('feedbackReportNote').textContent).toContain('Needed for a problem report.');
  expect($('feedbackForm').hidden).toBe(false);
});

it('sends an idea with both of its fields, and needs no diagnostics report', async () => {
  const { api, dialog } = await setup();
  dialog.open('idea');
  expect($('feedbackBug').hidden).toBe(true);
  expect($('feedbackIdea').hidden).toBe(false);
  expect(document.activeElement).toBe($('feedbackProblem'));
  type('feedbackProblem', 'I lose track of long runs');
  await submit();
  expect($('feedbackError').textContent).toBe('Write what the app should do.');
  type('feedbackProposal', 'A summary when a run ends');
  await submit();
  expect(api.openFeedbackIssue).toHaveBeenCalledWith({ kind: 'idea', problem: 'I lose track of long runs', proposal: 'A summary when a run ends' });
  expect(api.saveDiagnosticsReport).not.toHaveBeenCalled();
  expect($('feedbackDoneText').textContent).toBe('GitHub is open in your browser. Read the form there, then submit it.');
});

it('keeps the draft when the dialog is closed before it reached GitHub', async () => {
  const { dialog } = await setup();
  dialog.open();
  type('feedbackWhat', 'Half written');
  $('feedbackSaveReport').click();
  await settle();
  $('feedbackCancel').click();
  expect($<HTMLDialogElement>('feedbackDialog').open).toBe(false);
  dialog.open();
  expect($<HTMLTextAreaElement>('feedbackWhat').value).toBe('Half written');
  expect($('feedbackReportNote').textContent).toContain('Saved as diagnostics-2026-10-24.txt');
});

it('puts the whole text on the clipboard when GitHub got a shortened one, and says so', async () => {
  const { api, dialog } = await setup({ openFeedbackIssue: vi.fn(async () => ({ ok: true as const, data: { trimmed: true } })) });
  dialog.open();
  type('feedbackWhat', 'Very long');
  type('feedbackSteps', '1. Step');
  $('feedbackSaveReport').click();
  await settle();
  await submit();
  expect(api.writeClipboard).toHaveBeenCalledWith('Very long\n\n1. Step');
  expect($('feedbackDoneTrimmed').hidden).toBe(false);
});

it('keeps the whole draft when GitHub got a shortened text and copying the rest failed, and says so', async () => {
  for (const failure of [async () => ({ ok: false as const, error: 'clipboard busy' }), async () => { throw new Error('gone'); }]) {
    const { dialog } = await setup({ openFeedbackIssue: vi.fn(async () => ({ ok: true as const, data: { trimmed: true } })), writeClipboard: vi.fn(failure) });
    dialog.open();
    type('feedbackWhat', 'Very long');
    $('feedbackSaveReport').click();
    await settle();
    await submit();
    expect($('feedbackError').textContent).toBe('GitHub opened with a shortened text. The whole text could not be copied, so it stays here.');
    expect($<HTMLTextAreaElement>('feedbackWhat').value).toBe('Very long');
    expect($('feedbackForm').hidden).toBe(false);
    dom.window.close();
    dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, Event: dom.window.Event });
    vi.resetModules();
  }
});

it('points out a newer release for a problem report, not for an idea', async () => {
  const { dialog, openActivity } = await setup({}, { ...update, latest: '2.1.47' });
  dialog.open();
  expect($('feedbackUpdate').hidden).toBe(false);
  expect($('feedbackUpdateText').textContent).toBe('Version 2.1.47 is out and may already fix this. Update first.');
  const idea = document.querySelector<HTMLInputElement>('input[name="feedbackKind"][value="idea"]')!;
  idea.checked = true;
  idea.dispatchEvent(new dom.window.Event('change'));
  expect($('feedbackUpdate').hidden).toBe(true);
  dialog.open('bug');
  $('feedbackUpdateOpen').click();
  expect($<HTMLDialogElement>('feedbackDialog').open).toBe(false);
  expect(openActivity).toHaveBeenCalledTimes(1);
});

it('shows nothing about updates on the newest release or before the check answered', async () => {
  for (const status of [update, { ...update, latest: null }, null]) {
    const { dialog } = await setup({}, status);
    dialog.open();
    expect($('feedbackUpdate').hidden).toBe(true);
  }
});

it('keeps everything as typed when GitHub could not be opened, and says why in the chosen language', async () => {
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  const { dialog } = await setup({ openFeedbackIssue: vi.fn(async () => ({ ok: false as const, error: 'Write what happened.' })) });
  dialog.open();
  type('feedbackWhat', 'Kept');
  $('feedbackSaveReport').click();
  await settle();
  await submit();
  expect($('feedbackError').textContent).toBe('Schreib, was passiert ist.');
  expect($('feedbackForm').hidden).toBe(false);
  expect($<HTMLTextAreaElement>('feedbackWhat').value).toBe('Kept');
  expect($<HTMLButtonElement>('feedbackSubmit').disabled).toBe(false);
});

it('locks the form while the report is being saved, and a cancelled save keeps it unsaved', async () => {
  let finish!: (value: unknown) => void;
  const { dialog } = await setup({ saveDiagnosticsReport: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
  dialog.open();
  $('feedbackSaveReport').click();
  await settle();
  expect($<HTMLButtonElement>('feedbackSaveReport').disabled).toBe(true);
  expect($<HTMLButtonElement>('feedbackSubmit').disabled).toBe(true);
  finish({ ok: true, data: { saved: false } });
  await settle();
  expect($<HTMLButtonElement>('feedbackSubmit').disabled).toBe(false);
  expect($('feedbackReportNote').textContent).toContain('Needed for a problem report.');
});
