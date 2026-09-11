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

it('persists an unacknowledged reminder across reloads and rearms only for another running version', async () => {
  let { paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js');
  const notice = document.getElementById('pluginRefreshReminder')!;
  const dismiss = document.getElementById('dismissPluginRefreshReminder')!;
  paint('2.0.9');
  expect(notice.hidden).toBe(false);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint('2.0.9');
  expect(notice.hidden).toBe(false);
  dismiss.click();
  paint('2.0.9');
  expect(notice.hidden).toBe(true);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint('2.0.9');
  expect(notice.hidden).toBe(true);
  paint('2.0.10');
  expect(notice.hidden).toBe(false);
  dismiss.click();
  paint('2.0.10');
  expect(notice.hidden).toBe(true);
});

it('dismisses only the reminder and leaves simultaneous extension or update notices visible', async () => {
  const { paintPluginRefreshReminder } = await import('../src/renderer/plugin-refresh-reminder.js');
  const update = document.getElementById('updateNotice')!;
  update.hidden = false;
  paintPluginRefreshReminder('2.0.9');
  document.getElementById('dismissPluginRefreshReminder')!.click();
  expect(document.getElementById('pluginRefreshReminder')!.hidden).toBe(true);
  expect(update.hidden).toBe(false);
});
