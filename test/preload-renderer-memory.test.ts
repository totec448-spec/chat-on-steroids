import { expect, it, vi } from 'vitest';

const { invoke, expose } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: false })),
  expose: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') }
}));

it('exposes one fixed renderer-memory IPC channel with the numeric diagnostic payload', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const payload = {
    at: 1_800_000_000_000,
    hidden: false,
    jsHeap: { usedBytes: 10, totalBytes: 20, limitBytes: 30 },
    counters: {
      domNodes: 10,
      imageElements: 1,
      dataUrlImageChars: 0,
      sessionRows: 2,
      eventRows: 3,
      renderedTimelineRows: 3,
      rowCacheEntries: 3,
      toolGroups: 1,
      openTools: 0,
      eventTextChars: 100,
      inputDrafts: 1,
      inputDraftChars: 12,
      attachmentDrafts: 0,
      attachmentDraftBytes: 0,
      startingInputs: 0,
      pendingInputs: 0,
      taskPlans: 0,
      goalModels: 0
    }
  };

  await api.recordRendererMemory(payload);
  expect(invoke).toHaveBeenCalledWith('renderer:memorySample', payload);
});
