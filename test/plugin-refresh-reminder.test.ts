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

it('silently baselines connector schemas, persists a changed-schema reminder and rearms only for another schema', async () => {
  let { paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js');
  const notice = document.getElementById('pluginRefreshReminder')!;
  const dismiss = document.getElementById('dismissPluginRefreshReminder')!;
  paint({ core: 'schema-a' });
  expect(notice.hidden).toBe(true);
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(false);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(false);
  dismiss.click();
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(true);
  vi.resetModules();
  ({ paintPluginRefreshReminder: paint } = await import('../src/renderer/plugin-refresh-reminder.js'));
  paint({ core: 'schema-b' });
  expect(notice.hidden).toBe(true);
  paint({ core: 'schema-c' });
  expect(notice.hidden).toBe(false);
  dismiss.click();
  paint({ core: 'schema-c' });
  expect(notice.hidden).toBe(true);
});

it('does not invent refresh debt when a connector is first published or temporarily absent', async () => {
  const { paintPluginRefreshReminder } = await import('../src/renderer/plugin-refresh-reminder.js');
  const notice = document.getElementById('pluginRefreshReminder')!;
  paintPluginRefreshReminder({});
  expect(notice.hidden).toBe(true);
  paintPluginRefreshReminder({ core: 'core-a' });
  expect(notice.hidden).toBe(true);
  paintPluginRefreshReminder({});
  expect(notice.hidden).toBe(true);
  paintPluginRefreshReminder({ core: 'core-a', plugins: 'plugins-a' });
  expect(notice.hidden).toBe(true);
  paintPluginRefreshReminder({ core: 'core-a', plugins: 'plugins-b' });
  expect(notice.hidden).toBe(false);
});

it('dismisses only the reminder and leaves simultaneous extension or update notices visible', async () => {
  const { paintPluginRefreshReminder } = await import('../src/renderer/plugin-refresh-reminder.js');
  const update = document.getElementById('updateNotice')!;
  update.hidden = false;
  paintPluginRefreshReminder({ core: 'schema-a' });
  paintPluginRefreshReminder({ core: 'schema-b' });
  document.getElementById('dismissPluginRefreshReminder')!.click();
  expect(document.getElementById('pluginRefreshReminder')!.hidden).toBe(true);
  expect(update.hidden).toBe(false);
});
