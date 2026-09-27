import { beforeEach, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({ restart: vi.fn(), update: vi.fn(), uninstall: vi.fn(), authenticate: vi.fn(), cancelAuthentication: vi.fn() }));
const rearm = vi.hoisted(() => vi.fn(async () => true));
const onChanged = vi.hoisted(() => vi.fn());
const refreshPublication = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('../src/main/plugins/manager.js', () => ({ pluginManager: { ...actions, snapshot: () => ({ plugins: [] }), onChanged } }));
vi.mock('../src/main/plugin-refresh.js', () => ({ rearmPluginRefresh: rearm }));
vi.mock('../src/main/connection.js', () => ({ refreshPluginPublication: refreshPublication }));
import { registerPluginIpc } from '../src/main/plugins-ipc.js';

let handlers: Map<string, (payload: unknown) => Promise<unknown>>;
let publishStateChange = vi.fn<() => void>();
let sendToRenderer = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  handlers = new Map();
  publishStateChange = vi.fn<() => void>();
  sendToRenderer = vi.fn();
  registerPluginIpc(
    (channel, handler) => { handlers.set(channel, handler); },
    () => ({ isDestroyed: () => false, webContents: { send: sendToRenderer } }) as any,
    publishStateChange
  );
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

it('publishes fresh AppState after a plugin catalog change updates the connector schema', () => {
  const changed = onChanged.mock.calls[0]?.[0] as (() => void) | undefined;
  expect(changed).toBeTypeOf('function');
  changed!();
  expect(refreshPublication).toHaveBeenCalledExactlyOnceWith('plugins');
  expect(sendToRenderer).toHaveBeenCalledExactlyOnceWith('plugins:changed', { plugins: [] });
  expect(publishStateChange).toHaveBeenCalledTimes(1);
  expect(sendToRenderer.mock.invocationCallOrder[0]).toBeGreaterThan(refreshPublication.mock.invocationCallOrder[0]!);
  expect(publishStateChange.mock.invocationCallOrder[0]).toBeGreaterThan(sendToRenderer.mock.invocationCallOrder[0]!);
});
