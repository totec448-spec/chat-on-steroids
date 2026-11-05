import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// ChatGPT's account-wide pause notice ("Chats working at once", #1694), CodeRabbit on #2051.
let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
  // jsdom's own timers do not follow the fake clock; the module uses window.setTimeout.
  dom.window.setTimeout = setTimeout as unknown as typeof dom.window.setTimeout;
  dom.window.clearTimeout = clearTimeout as unknown as typeof dom.window.clearTimeout;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

it('keeps the notice when its timer fires early because the clock was set back', async () => {
  (window as any).api = { resumeAutomaticSends: vi.fn() };
  const { paintAutomaticPause } = await import('../src/renderer/automatic-pause.js');
  const start = Date.now();
  paintAutomaticPause(start + 10 * 60_000);
  const notice = document.getElementById('automaticPause')!;
  expect(notice.hidden).toBe(false);
  // The clock goes back five minutes, then the timer fires at its old moment.
  vi.setSystemTime(start - 5 * 60_000);
  vi.advanceTimersByTime(10 * 60_000 + 500);
  expect(notice.hidden).toBe(false);
  // At ChatGPT's time by the current clock it ends.
  vi.setSystemTime(start + 10 * 60_000 + 1);
  vi.advanceTimersByTime(15 * 60_000);
  expect(notice.hidden).toBe(true);
});

it('moves keyboard focus to the message box when Resume now hides the notice', async () => {
  (window as any).api = { resumeAutomaticSends: vi.fn(async () => ({ ok: true, data: true })) };
  const { paintAutomaticPause } = await import('../src/renderer/automatic-pause.js');
  paintAutomaticPause(Date.now() + 10 * 60_000);
  const resume = document.getElementById('resumeAutomaticSends') as HTMLButtonElement;
  resume.focus();
  resume.click();
  await vi.waitFor(() => expect(document.getElementById('automaticPause')!.hidden).toBe(true), { timeout: 5_000 });
  expect(document.activeElement).toBe(document.getElementById('chatInput'));
});

it('moves keyboard focus to the message box when the pause ends by itself', async () => {
  (window as any).api = { resumeAutomaticSends: vi.fn() };
  const { paintAutomaticPause } = await import('../src/renderer/automatic-pause.js');
  const start = Date.now();
  paintAutomaticPause(start + 60_000);
  (document.getElementById('resumeAutomaticSends') as HTMLButtonElement).focus();
  vi.setSystemTime(start + 61_000);
  vi.advanceTimersByTime(61_000);
  expect(document.getElementById('automaticPause')!.hidden).toBe(true);
  expect(document.activeElement).toBe(document.getElementById('chatInput'));
});
