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
  // It says the app neither runs nor checks it, and nothing reads as "safe".
  expect(card.textContent).toContain('does not run or check this command');
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
