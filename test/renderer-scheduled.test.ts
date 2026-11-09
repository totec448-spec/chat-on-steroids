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
  expect(rows[0]?.querySelectorAll('.scheduled-index-actions > button')).toHaveLength(1);
  expect(rows[0]?.querySelector('.scheduled-index-menu > summary')?.getAttribute('aria-label')).toBe('Actions for Economics monitoring');
  expect(rows[0]?.querySelector('.scheduled-index-message')).toBeTruthy();
  expect(rows[0]?.querySelector('.scheduled-index-meta')?.textContent).toContain('Every day');
  expect(rows[0]?.querySelector('.scheduled-index-meta')?.textContent).not.toContain('every day at');
  (rows[1]?.querySelector('button') as HTMLButtonElement).click();
  expect(calls.openChat).toHaveBeenCalledExactlyOnceWith(idB);
});

it('shows blocked delivery receipts and disables Run now until the outbox is definitive', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn(async () => ok([
      { ...schedule(idA), deliveryBlock: 'unconfirmed' as const },
      { ...schedule(idB), deliveryBlock: 'pending' as const }
    ])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  await initScheduled(calls).refresh();
  const rows = [...document.querySelectorAll<HTMLElement>('.scheduled-index-row')];
  expect(rows[0]?.querySelector('.scheduled-index-meta')?.textContent).toContain('Delivery not confirmed');
  expect(rows[1]?.querySelector('.scheduled-index-meta')?.textContent).toContain('Delivery confirmation pending');
  expect(rows.every(row => [...row.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === 'Run now')?.disabled)).toBe(true);
});

it('keeps only Open chat visible, uses the overflow menu, and confirms deletion in an accessible dialog', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn(async () => ok([schedule(idA)])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const confirm = vi.fn(() => true);
  dom.window.confirm = confirm;
  await initScheduled(calls).refresh();
  const menu = document.querySelector<HTMLDetailsElement>('.scheduled-index-menu')!;
  const summary = menu.querySelector('summary')!;
  expect(menu.open).toBe(false);
  summary.focus(); summary.click();
  expect(menu.open).toBe(true);
  const pauseInMenu = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Pause')!;
  pauseInMenu.focus();
  pauseInMenu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(summary);
  summary.click();
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
  expect(confirm).not.toHaveBeenCalled();
  expect(calls.delete).not.toHaveBeenCalled();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-labelledby="scheduledDeleteTitle"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('h2')?.textContent).toContain('Economics monitoring');
  expect(document.activeElement?.textContent).toBe('Cancel');
  dialog.querySelector<HTMLButtonElement>('.pet-delete-cancel')!.click();
  expect(document.querySelector('dialog[aria-labelledby="scheduledDeleteTitle"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('.scheduled-index-menu > summary'));
  expect(calls.delete).not.toHaveBeenCalled();
  await click('Delete');
  document.querySelector<HTMLButtonElement>('.pet-delete-confirm')!.click();
  await settle();
  expect(calls.delete).toHaveBeenCalledExactlyOnceWith(idA);
});

it('keeps the visible rows when listing fails and never presents an empty schedule store', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn().mockResolvedValueOnce(ok([schedule(idA)])).mockResolvedValueOnce({ ok: false, error: 'Cannot read schedules' })
      .mockResolvedValueOnce(ok([schedule(idA)])),
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
  await view.refresh();
  expect(document.getElementById('scheduledStatus')?.hidden).toBe(true);
});

it('keeps existing rows visible and explains when schedules were saved by a newer app version', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const error = 'These schedules were saved by a newer version of Chat On Steroids. Update the app to change them.';
  const calls = {
    list: vi.fn().mockResolvedValueOnce(ok([schedule(idA)])).mockResolvedValueOnce({ ok: false, error }),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  await view.refresh();

  expect(document.querySelector('.scheduled-index-row')?.textContent).toContain('Economics monitoring');
  expect(document.querySelector('.scheduled-index-empty')).toBeNull();
  expect(document.getElementById('scheduledStatus')?.textContent).toContain(error);
});

it('sets automatic text direction for chat titles and message previews', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const record = { ...schedule(idA), sessionTitle: 'مراقبة الاقتصاد', text: 'שלום, 123' };
  const calls = {
    list: vi.fn(async () => ok([record])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  await initScheduled(calls).refresh();

  expect(document.querySelector('.scheduled-index-row h2')?.getAttribute('dir')).toBe('auto');
  expect(document.querySelector('.scheduled-index-message')?.getAttribute('dir')).toBe('auto');
  expect(document.querySelector('.scheduled-index-message')?.textContent).toBe(record.text);
});

it('bounds message text retained by the DOM and does not split a surrogate pair', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const text = 'a'.repeat(319) + '😀' + 'b'.repeat(100_000);
  const calls = {
    list: vi.fn(async () => ok([{ ...schedule(idA), text }])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  await initScheduled(calls).refresh();

  const preview = document.querySelector('.scheduled-index-message')?.textContent ?? '';
  expect(preview).toBe('a'.repeat(319) + '…');
  expect(preview.length).toBe(320);
});

it('keeps the Refresh button enabled and focused while exposing active reads with aria-busy', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  type ScheduleReply = { ok: true; data: ReturnType<typeof schedule>[] };
  let release!: (value: ScheduleReply) => void;
  const calls = {
    list: vi.fn(() => new Promise<ScheduleReply>(resolve => { release = resolve; })),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  const refresh = document.getElementById('scheduledRefresh') as HTMLButtonElement;
  refresh.focus();
  const pending = view.refresh();
  expect(refresh.disabled).toBe(false);
  expect(refresh.getAttribute('aria-busy')).toBe('true');
  expect(document.activeElement).toBe(refresh);
  release(ok([schedule(idA)]));
  await pending;
  expect(refresh.disabled).toBe(false);
  expect(refresh.getAttribute('aria-busy')).toBe('false');
  expect(document.activeElement).toBe(refresh);
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

it('keeps action errors visible after a failed read and a later successful refresh', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn().mockResolvedValueOnce(ok([schedule(idA)]))
      .mockRejectedValueOnce(new Error('Temporary read failure'))
      .mockResolvedValue(ok([schedule(idA)])),
    pause: vi.fn().mockResolvedValueOnce({ ok: false as const, error: 'Permission denied' }).mockResolvedValue(ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  const pause = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')]
    .find(node => node.textContent === 'Pause')!;
  pause.click();
  await settle();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Permission denied');
  await view.refresh();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Permission denied');
  await view.refresh();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Permission denied');
  pause.click();
  await settle();
  expect(document.getElementById('scheduledStatus')?.hidden).toBe(true);
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
  expect((document.activeElement as HTMLElement).dataset.scheduledAction).toBe('menu');
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Queued');
  await view.refresh();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Queued');
  runNow.click(); await settle();
  expect(document.getElementById('scheduledStatus')?.textContent).toBe('Skipped');

  const pause = [...original.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Pause')!;
  pause.focus(); pause.click(); await settle();
  const resume = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')].find(node => node.textContent === 'Resume')!;
  expect(resume).toBeDefined();
  expect((document.activeElement as HTMLElement).dataset.scheduledAction).toBe('menu');
});

it('preserves keyboard focus when a background refresh changes a different schedule row', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const first = schedule(idA);
  const second = schedule(idB, true);
  const calls = {
    list: vi.fn().mockResolvedValueOnce(ok([first, second])).mockResolvedValueOnce(ok([first, { ...second, paused: false, nextRunAt: Date.now() + 7200000 }])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  const focused = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')]
    .find(node => node.dataset.sessionId === idA && node.dataset.scheduledAction === 'pause')!;
  focused.focus();
  expect(document.activeElement).toBe(focused);

  await view.refresh();
  const restored = document.activeElement as HTMLButtonElement;
  expect(restored.dataset.sessionId).toBe(idA);
  expect(restored.dataset.scheduledAction).toBe('menu');
});

it('moves focus to a surviving row or Refresh when a background refresh removes the focused row', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const calls = {
    list: vi.fn().mockResolvedValueOnce(ok([schedule(idA), schedule(idB, true)]))
      .mockResolvedValueOnce(ok([schedule(idB, true)]))
      .mockResolvedValueOnce(ok([])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  await view.refresh();
  const focusedA = [...document.querySelectorAll<HTMLButtonElement>('.scheduled-index-row button')]
    .find(node => node.dataset.sessionId === idA && node.dataset.scheduledAction === 'pause')!;
  focusedA.focus();

  await view.refresh();
  expect((document.activeElement as HTMLButtonElement).dataset.sessionId).toBe(idB);

  const focusedB = document.activeElement as HTMLButtonElement;
  focusedB.focus();
  await view.refresh();
  expect(document.activeElement).toBe(document.getElementById('scheduledRefresh'));
});

it('shows missed occurrences with localized time and does not duplicate the recurrence clock', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const { setLanguage } = await import('../src/renderer/i18n.js');
  const missedAt = new Date(2026, 10, 5, 9, 0).getTime();
  const record = { ...schedule(idA), missedDueAt: missedAt };
  const calls = {
    list: vi.fn(async () => ok([record])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  const view = initScheduled(calls);
  try {
    setLanguage('en');
    await view.refresh();
    expect(document.querySelector('.scheduled-index-meta')?.textContent).toContain('missed');
    const englishTime = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(missedAt);
    expect(document.querySelector('.scheduled-index-meta')?.textContent).toContain(englishTime);
    expect(document.querySelector('.scheduled-index-meta')?.textContent).toContain('Every day');

    setLanguage('pt-PT');
    const portugueseTime = new Intl.DateTimeFormat('pt-PT', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(missedAt);
    expect(document.querySelector('.scheduled-index-meta')?.textContent).toContain(portugueseTime);
  } finally { setLanguage('en'); }
});

it('shows the exact overdue occurrence while the scheduler is retrying an outbox failure', async () => {
  const { initScheduled } = await import('../src/renderer/scheduled.js');
  const retryAt = new Date(2026, 10, 5, 9, 0).getTime();
  const calls = {
    list: vi.fn(async () => ok([{ ...schedule(idA), retryDueAt: retryAt }])),
    pause: vi.fn(async () => ok(true)),
    runNow: vi.fn(async () => ok(true)),
    delete: vi.fn(async () => ok(true)),
    openChat: vi.fn()
  };
  await initScheduled(calls).refresh();
  const meta = document.querySelector('.scheduled-index-meta')?.textContent ?? '';
  expect(meta).toContain('Retrying the run due');
  expect(meta).toContain(new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(retryAt));
  expect(document.querySelector<HTMLButtonElement>('button[data-scheduled-action="run-now"]')?.disabled).toBe(true);
});

it('has translated queued and skipped feedback in every shipped locale', () => {
  const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
    expect(messages.Queued, locale).toBeTruthy();
    expect(messages.Skipped, locale).toBeTruthy();
  }
});
