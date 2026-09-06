import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const workflow = source.slice(source.indexOf('let pluginRefreshFlight = null;'), source.indexOf('async function catalogProbe('));

it('records browser creation failure before claim and retries the same obligation', async () => {
  const request = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', appId: 'asdk_app_synthetic' };
  const call = vi.fn(async (_path: string, init: { body: string }) => JSON.parse(init.body).action === 'pending'
    ? { ok: true, data: { requests: [request] } } : { ok: true });
  const createChatTab = vi.fn().mockRejectedValueOnce(new Error('window size rejected')).mockResolvedValueOnce({ id: 8 });
  const context = vm.createContext({ call, createChatTab, URL, setTimeout, clearTimeout,
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*'], chrome: { tabs: { query: async () => [] } } });
  vm.runInContext(`${workflow}\nglobalThis.run = inspectRequestedPluginRefresh;`, context);
  await context.run([{}], true);
  const actions = call.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(actions).toEqual([{ action: 'pending' }, { action: 'fail', id: request.id, error: 'The background plugin refresh tab could not be created' }]);
  await context.run([{}], true);
  expect(createChatTab).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.map(([, init]) => JSON.parse(init.body).action)).toEqual(['pending', 'fail', 'pending']);
});
