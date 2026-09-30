import { expect, it, vi } from 'vitest';

const { on, removeListener, expose } = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke: vi.fn(), on, removeListener },
  webUtils: { getPathForFile: vi.fn() }
}));

it('forwards exact session-change ownership to the renderer and keeps catalog-only pushes payload-less', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const listener = vi.fn();
  const stop = api.onSessionChanged(listener);
  const [channel, wrapped] = on.mock.calls.find(([name]) => name === 'session:changed')!;
  expect(channel).toBe('session:changed');
  wrapped({}, { sessionIds: ['2026-09-30-aaaaaaaa'] });
  wrapped({}, { allTranscripts: true });
  wrapped({});
  expect(listener.mock.calls).toEqual([[{ sessionIds: ['2026-09-30-aaaaaaaa'] }], [{ allTranscripts: true }], [undefined]]);
  stop();
  expect(removeListener).toHaveBeenCalledWith('session:changed', wrapped);
});
