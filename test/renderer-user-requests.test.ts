import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UserRequestView } from '../src/shared/user-requests.js';

// A step handed to the person (#1695): the card shows exactly what is asked, never runs or rates it,
// and only the person's click answers it.
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

const request = (patch: Partial<UserRequestView> = {}): UserRequestView => ({
  id: 'ur_abcdefghijkl', command: 'rm -rf build && make flash PORT=/dev/ttyUSB0', folder: '/work/firmware', remote: false,
  purpose: 'Flash the board: it needs the USB key plugged in.', expected: [{ path: 'build/flash.log', real: '/work/firmware/build/flash.log' }, { path: '../secret' }],
  constraints: 'Takes about 2 minutes', state: 'open', createdAt: 1, conversationId: 'c1',
  found: [{ path: 'build/flash.log', state: 'found', size: 2048, modifiedAt: Date.UTC(2026, 10, 3, 10, 42) }, { path: '../secret', state: 'unchecked' }],
  ...patch
});

it('shows the exact command, folder, purpose and expected files, with no verdict about the command', async () => {
  const writeClipboard = vi.fn(async () => ({ ok: true, data: true }));
  (window as any).api = { writeClipboard };
  const { userRequestCard } = await import('../src/renderer/user-requests.js');
  const answer = vi.fn(async () => undefined);
  const card = userRequestCard(request(), { answer, readOnly: () => false });
  document.body.append(card);
  expect(card.querySelector('pre')!.textContent).toBe('rm -rf build && make flash PORT=/dev/ttyUSB0');
  expect(card.querySelector('.user-request-purpose')!.textContent).toBe('Flash the board: it needs the USB key plugged in.');
  expect(card.textContent).toContain('/work/firmware');
  expect(card.textContent).toContain('Takes about 2 minutes');
  const files = [...card.querySelectorAll('.user-request-files li')].map(item => item.textContent);
  expect(files[0]).toMatch(/^build\/flash\.logfound, 2 kB, /);
  expect(files[1]).toBe('../secretnot checked');
  const small = userRequestCard(request({ found: [{ path: 'build/flash.log', state: 'found', size: 9, modifiedAt: 1 }, { path: '../secret', state: 'unchecked' }] }), { answer, readOnly: () => false });
  expect(small.querySelector('.user-request-file-state')!.textContent).toMatch(/^found, 9 bytes, /);
  // It says the app neither runs nor checks it, and nothing reads as "safe".
  expect(card.querySelector('.user-request-note')!.textContent).toBe('Run it yourself, in your own terminal: Chat On Steroids does not run or check it.');
  // Two expected files and a note fold into one line; the folder stays in view (Haz on #2049).
  const more = card.querySelector<HTMLDetailsElement>('details.user-request-more')!;
  expect(more.open).toBe(false);
  expect(more.querySelector('summary')!.textContent).toBe('2 expected files · Note');
  expect(more.contains(card.querySelector('.user-request-files'))).toBe(true);
  const folderFact = [...card.querySelectorAll(':scope > .user-request-facts dt')].map(dt => dt.textContent);
  expect(folderFact).toEqual(['Folder']);
  // One file and a short note stay in view, unfolded.
  const short = userRequestCard(request({ expected: [{ path: 'build/flash.log' }], found: [] }), { answer, readOnly: () => false });
  expect(short.querySelector('details')).toBeNull();
  expect([...short.querySelectorAll('.user-request-facts dt')].map(dt => dt.textContent)).toEqual(['Folder', 'Expected', 'Note']);
  // A long note folds even alone.
  const long = userRequestCard(request({ expected: [], found: [], constraints: 'x '.repeat(80) }), { answer, readOnly: () => false });
  expect(long.querySelector('details.user-request-more summary')!.textContent).toBe('Note');
  expect(card.textContent?.toLowerCase()).not.toMatch(/\bsafe\b|verified|harmless/);
  expect(card.textContent).not.toContain('Read-only');

  (card.querySelector('.tool-copy') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('rm -rf build && make flash PORT=/dev/ttyUSB0'), { timeout: 1000 });
  const [done, skip] = [...card.querySelectorAll<HTMLButtonElement>('.user-request-actions button')];
  expect([done!.textContent, skip!.textContent]).toEqual(['Mark as done', 'Skip']);
  done!.click();
  expect(answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ur_abcdefghijkl' }), 'done');
  expect(done!.disabled && skip!.disabled).toBe(true);
});

it('says Read-only is on, and shows an answered step without its buttons', async () => {
  (window as any).api = { writeClipboard: vi.fn() };
  const { userRequestCard } = await import('../src/renderer/user-requests.js');
  expect(userRequestCard(request(), { answer: vi.fn(), readOnly: () => true }).textContent).toContain('Read-only is on in the app');
  const skipped = userRequestCard(request({ state: 'skipped', answeredAt: 5, found: [] }), { answer: vi.fn(), readOnly: () => false });
  expect(skipped.querySelector('.user-request-actions')).toBeNull();
  expect(skipped.querySelector('.user-request-state')!.textContent).toBe('Skipped');
  expect(skipped.textContent).toContain('ChatGPT is told it did not happen');
  // Answered steps do not report files that may have changed since.
  expect(skipped.querySelector('.user-request-file-state')!.textContent).toBe('');
});

it('shows one quiet line above the composer while steps wait, in the person\'s language and plural', async () => {
  (window as any).api = { writeClipboard: vi.fn() };
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const { renderUserRequestsDock } = await import('../src/renderer/user-requests.js');
  const host = document.getElementById('userRequests')!;
  const actions = { answer: vi.fn(), readOnly: () => false };
  renderUserRequestsDock(host, 's1', [request()], actions);
  expect(host.hidden).toBe(false);
  expect(host.querySelector('.user-requests-title')!.textContent).toBe('1 step waiting for you');
  expect(host.querySelectorAll('.user-request')).toHaveLength(1);
  renderUserRequestsDock(host, 's1', [request(), request({ id: 'ur_bcdefghijklm', command: 'other' })], actions);
  expect(host.querySelector('.user-requests-title')!.textContent).toBe('2 steps waiting for you');
  setLanguage('ru');
  expect(host.querySelector('.user-requests-title')!.textContent).toBe('2 шага ждут вас');
  setLanguage('en');
  renderUserRequestsDock(host, 's1', [request({ state: 'done', answeredAt: 2 })], actions);
  expect(host.hidden).toBe(true);
  renderUserRequestsDock(host, 's2', [request()], actions);
  expect(host.hidden).toBe(false);
  renderUserRequestsDock(host, null, [request()], actions);
  expect(host.hidden).toBe(true);
});

it('keeps keyboard focus on the next step after one is answered, or hands it back (CodeRabbit on #2049)', async () => {
  (window as any).api = { writeClipboard: vi.fn() };
  const { renderUserRequestsDock, keepStepFocus, userRequestCard } = await import('../src/renderer/user-requests.js');
  const host = document.getElementById('userRequests')!;
  const fallback = vi.fn();
  const actions = { answer: vi.fn(async () => undefined), readOnly: () => false, focusFallback: fallback };
  const second = request({ id: 'ur_bcdefghijklm', command: 'second' });
  const third = request({ id: 'ur_cdefghijklmn', command: 'third' });
  renderUserRequestsDock(host, 's1', [request(), second, third], actions);
  host.querySelector<HTMLDetailsElement>('.user-requests-shell')!.open = true;
  const buttonOf = (index: number) => host.querySelectorAll<HTMLElement>('.user-request')[index]!.querySelector<HTMLButtonElement>('.user-request-actions button')!;
  // The second step is answered with the keyboard: focus moves to the step that took its place.
  buttonOf(1).focus();
  renderUserRequestsDock(host, 's1', [request(), third], actions);
  expect(document.activeElement).toBe(buttonOf(1));
  expect(buttonOf(1).closest('.user-request')!.getAttribute('data-request-id')).toBe('ur_cdefghijklmn');
  // The last one in the list: focus goes to the one before it.
  buttonOf(1).focus();
  renderUserRequestsDock(host, 's1', [request()], actions);
  expect(document.activeElement).toBe(buttonOf(0));
  // None left: focus is handed back.
  buttonOf(0).focus();
  renderUserRequestsDock(host, 's1', [], actions);
  expect(fallback).toHaveBeenCalledTimes(1);
  // A refresh while focus is elsewhere moves nothing.
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  renderUserRequestsDock(host, 's1', [request(), second], actions);
  expect(document.activeElement).toBe(outside);
  expect(fallback).toHaveBeenCalledTimes(1);

  // A timeline card replaced by its answered state hands focus back too.
  const slot = document.createElement('div');
  document.body.append(slot);
  slot.append(userRequestCard(request(), actions));
  slot.querySelector<HTMLButtonElement>('.user-request-actions button')!.focus();
  keepStepFocus(slot, () => slot.replaceChildren(userRequestCard(request({ state: 'done', answeredAt: 2 }), actions)), fallback);
  expect(fallback).toHaveBeenCalledTimes(2);
});

it('writes an answered step\'s time like the timeline does, without a leading zero (2.1.51 polish pass)', async () => {
  (window as any).api = { writeClipboard: vi.fn() };
  const { userRequestCard } = await import('../src/renderer/user-requests.js');
  const at = new Date(2026, 10, 6, 5, 2).getTime();
  const done = userRequestCard(request({ state: 'done', answeredAt: at, found: [] }), { answer: vi.fn(), readOnly: () => false });
  const expected = new Date(at).toLocaleString('en', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  expect(done.textContent).toContain(expected);
  expect(done.textContent).not.toContain(new Date(at).toLocaleString('en', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }));
  // A 24-hour language writes it as its own clock does (CodeRabbit on #2092).
  const { setLanguage } = await import('../src/renderer/i18n.js');
  setLanguage('de');
  try {
    const german = userRequestCard(request({ state: 'done', answeredAt: at, found: [] }), { answer: vi.fn(), readOnly: () => false });
    expect(german.textContent).toContain(new Date(at).toLocaleString('de', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }));
  } finally { setLanguage('en'); }
});
