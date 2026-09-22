import { beforeEach, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({ restart: vi.fn(), update: vi.fn(), uninstall: vi.fn(), authenticate: vi.fn(), cancelAuthentication: vi.fn() }));
const rearm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('../src/main/plugins/manager.js', () => ({ pluginManager: { ...actions, snapshot: () => ({ plugins: [] }), onChanged: vi.fn() } }));
vi.mock('../src/main/plugin-refresh.js', () => ({ rearmPluginRefresh: rearm }));
vi.mock('../src/main/connection.js', () => ({ refreshPluginPublication: vi.fn() }));
import { registerPluginIpc } from '../src/main/plugins-ipc.js';

let handlers: Map<string, (payload: unknown) => Promise<unknown>>;
beforeEach(() => {
  vi.clearAllMocks();
  handlers = new Map();
  registerPluginIpc((channel, handler) => { handlers.set(channel, handler); }, () => null);
});

it.each(Object.keys(actions) as (keyof typeof actions)[])('only explicit successful Restart rearms the connector (%s)', async action => {
  await handlers.get(`plugins:${action}`)!({ id: 'synthetic-plugin' });
  expect(actions[action]).toHaveBeenCalledExactlyOnceWith('synthetic-plugin');
  if (action === 'restart') {
    expect(rearm).toHaveBeenCalledExactlyOnceWith('plugins');
    expect(rearm.mock.invocationCallOrder[0]).toBeGreaterThan(actions.restart.mock.invocationCallOrder[0]!);
  } else expect(rearm).not.toHaveBeenCalled();
});

it('does not create browser retry authority when Restart fails', async () => {
  actions.restart.mockRejectedValueOnce(new Error('Plugin restart failed'));
  await expect(handlers.get('plugins:restart')!({ id: 'synthetic-plugin' })).rejects.toThrow('Plugin restart failed');
  expect(rearm).not.toHaveBeenCalled();
});
