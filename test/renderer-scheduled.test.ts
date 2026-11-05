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
