import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
});
afterEach(() => dom.window.close());

const ok = <T>(data: T) => ({ ok: true as const, data });
const idA = 'session-aaaa-0001';
const idB = 'session-bbbb-0002';
const schedule = (sessionId: string, paused = false) => ({
  id: 'schedule-' + sessionId,
  sessionId,
  sessionTitle: sessionId === idA ? 'Economics monitoring' : 'Politics',
  text: sessionId === idA ? 'Review prices and publish a report' : 'Review parliament',
  repeat: { kind: 'daily' as const, at: '09:00' },
  until: null,
  paused,
  createdAt: 1000,
  lastDueAt: null,
  nextRunAt: paused ? null : Date.now() + 3600000
});
const settle = async () => { for (let i = 0; i < 14; i++) await Promise.resolve(); };

it('projects different chats from one schedule list and opens the selected chat', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn(async () => ok([schedule(idA), schedule(idB, true)])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  await initScheduled(calls).refresh();
  const rows = [...document.querySelectorAll('.scheduled-index-row')];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('Economics monitoring');
  expect(rows[0]?.textContent).toContain('Review prices and publish a report');
  expect(rows[1]?.textContent).toContain('Paused');
  (rows[1]?.querySelector('button') as HTMLButtonElement).click();
  expect(calls.openChat).toHaveBeenCalledExactlyOnceWith(idB);
});

it('reuses pause, runNow and delete actions for the exact original chat; deletion asks first', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn(async () => ok([schedule(idA)])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const confirm = vi.fn(() => false);
  dom.window.confirm = confirm;
  await initScheduled(calls).refresh();
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')]
      .find(node => node.textContent === label);
    expect(button).toBeDefined();
    button!.click();
    await settle();
  };
  await click('Pause');
  expect(calls.pause).toHaveBeenCalledExactlyOnceWith(idA, true);
  await click('Run now');
  expect(calls.runNow).toHaveBeenCalledExactlyOnceWith(idA);
  await click('Delete');
  expect(confirm).toHaveBeenCalledOnce();
  expect(calls.delete).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await click('Delete');
  expect(calls.delete).toHaveBeenCalledExactlyOnceWith(idA);
});

it('keeps the visible rows when listing fails and never presents an empty schedule store', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn().mockResolvedValueOnce(ok([schedule(idA)])).mockResolvedValueOnce({ ok: false, error: 'Cannot read schedules' }),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  await view.refresh();
  expect(document.querySelector('.scheduled-index-row')?.textContent).toContain('Economics monitoring');
  expect(document.getElementById('scheduledStatus')?.textContent).toContain('Cannot read schedules');
});

it('coalesces a burst of refreshes to one in-flight read plus one dirty follow-up', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  let release!: (value: ReturnType<typeof ok>) => void;
  const first = new Promise<ReturnType<typeof ok>>(resolve => { release = resolve; });
  const calls = {
    list: vi.fn().mockImplementationOnce(() => first).mockResolvedValue(ok([schedule(idA)])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  const pending = view.refresh();
  for (let i = 0; i < 20; i++) void view.refresh();
  expect(calls.list).toHaveBeenCalledTimes(1);
  release(ok([schedule(idA)]));
  await pending;
  expect(calls.list).toHaveBeenCalledTimes(2);
});

it('releases mutation controls after one post-mutation read while refresh pushes continue', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  let releaseSecond!: (value: ReturnType<typeof ok>) => void;
  let releaseThird!: (value: ReturnType<typeof ok>) => void;
  const calls = {
    list: vi.fn()
      .mockResolvedValueOnce(ok([schedule(idA)]))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof ok>>(resolve => { releaseSecond = resolve; }))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof ok>>(resolve => { releaseThird = resolve; }))
      .mockImplementation(() => new Promise<ReturnType<typeof ok>>(() => {})),
    pause: vi.fn(async (_sessionId: string, paused: boolean) => ok(paused)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  void view.refresh(); // A read that began before the mutation.
  const pause = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')]
    .find(node => node.textContent === 'Pause')!;
  pause.click();
  await settle();
  releaseSecond(ok([schedule(idA)]));
  await settle();
  expect(calls.list).toHaveBeenCalledTimes(3); // The mutation's required post-write read has started.
  void view.refresh(); // Keep the dirty stream active during that read.
  releaseThird(ok([schedule(idA, true)]));
  await settle();
  const resume = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')]
    .find(node => node.textContent === 'Resume')!;
  expect(resume.disabled).toBe(false);
  expect(calls.list).toHaveBeenCalledTimes(4); // A further refresh may continue without holding busy.
});

it('keeps unchanged rows mounted, restores action focus after a changed row, and reports run-now outcome', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  let paused = false;
  let current = schedule(idA, paused);
  const calls = {
    list: vi.fn(async () => ok([current])),
    pause: vi.fn(async (_sessionId: string, next: boolean) => { paused = next; current = schedule(idA, paused); return ok(true); }),
    runNow: vi.fn().mockResolvedValueOnce(ok(true)).mockResolvedValueOnce(ok(false)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  const original = document.querySelector('.scheduled-index-row')!;
  await view.refresh();
  expect(document.querySelector('.scheduled-index-row')).toBe(original);

  const runNow = [...original.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Run now')!;
  runNow.focus(); runNow.click(); await settle();
  expect(document.querySelector('.scheduled-index-row')).toBe(original);
  expect(document.activeElement).toBe(runNow);
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Queued');
  await view.refresh();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Queued');
  runNow.click(); await settle();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Skipped');

  const pause = [...original.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Pause')!;
  pause.focus(); pause.click(); await settle();
  const resume = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')].find(node => node.textContent === 'Resume')!;
  expect(document.activeElement).toBe(resume);
});

it('has translated queued and skipped feedback in every shipped locale', () => {
  const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
    expect(messages.Queued, locale).toBeTruthy();
    expect(messages.Skipped, locale).toBeTruthy();
  }
});
