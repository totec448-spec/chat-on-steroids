import { expect, it, vi } from 'vitest';

const { invoke, expose, getPath } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true, data: [] })), expose: vi.fn(), getPath: vi.fn((file: any) => file.path ?? '')
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: { getPathForFile: getPath }
}));

it('transports pathless clipboard bytes and disk paths through one bounded image import', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const bytes = new Uint8Array([1, 2, 3]);
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  await api.dropFiles([{ name: 'clipboard.png', size: 3, arrayBuffer }, { name: 'disk.png', size: 3, path: '/disk.png' }]);
  expect(invoke).toHaveBeenCalledWith('sessions:dropFiles', { files: [{ name: 'clipboard.png', bytes }, '/disk.png'] });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  invoke.mockClear(); arrayBuffer.mockClear();
  expect(await api.dropFiles([{ name: 'huge.png', size: 12 * 1024 * 1024 + 1, arrayBuffer }])).toMatchObject({ ok: false });
  expect(await api.dropFiles(Array(21).fill({ name: 'clipboard.png', size: 3, arrayBuffer }))).toMatchObject({ ok: false });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  await api.getProjectGitSnapshot('project-id');
  await api.getProjectGitDiff('project-id', 'src/main.ts');
  await api.getToolEditReview('session-id', '00000000-0000-4000-8000-000000000000', 1);
  expect(invoke).toHaveBeenNthCalledWith(1, 'projectGit:snapshot', { projectId: 'project-id' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'projectGit:diff', { projectId: 'project-id', path: 'src/main.ts' });
  expect(invoke).toHaveBeenNthCalledWith(3, 'sessions:toolEditReview', {
    sessionId: 'session-id', callId: '00000000-0000-4000-8000-000000000000', changeIndex: 1
  });
});
