import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Source-contract coverage for the production adapter chain. This checks that the real source
 * files retain the same named mappings; it does not instantiate Electron or claim runtime E2E.
 */
const source = (path: string): string => readFileSync(path, 'utf8');

const renderer = source('src/renderer/main.ts');
const chat = source('src/renderer/chat.ts');
const preload = source('src/preload/index.ts');
const ipc = source('src/main/ipc.ts');

it('connects the production Scheduled page to the named preload API and chat navigation', () => {
  expect(renderer).toContain('const scheduled = initScheduled({');
  for (const mapping of [
    'list: () => api.listSchedules(),',
    'pause: (sessionId, paused) => api.pauseSchedule(sessionId, paused),',
    'runNow: sessionId => api.runScheduleNow(sessionId),',
    'delete: sessionId => api.deleteSchedule(sessionId),',
    "openChat: sessionId => { showTab('chat'); void openScheduledChat(sessionId); }"
  ]) expect(renderer).toContain(mapping);

  expect(renderer).toContain("if (name === 'scheduled') void scheduled.refresh();");
  expect(renderer).toContain("api.onSessionChanged(() => {");
  expect(renderer).toContain("if (document.querySelector('.panel[data-panel=\"scheduled\"]')?.classList.contains('is-active')) void scheduled.refresh();");
});

it('offers Schedule only for existing ChatGPT conversations, not unbound local drafts', () => {
  expect(chat).toContain("if (summary.origin?.kind !== 'worker' && !!summary.conversationId) {");
  expect(ipc).toContain('if (!session.conversationId) throw new Error(\'This chat is not connected to a ChatGPT conversation yet.\');');
});

it('maps every Scheduled operation to a fixed preload IPC channel and expected payload', () => {
  expect(preload).toContain('ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>');
  expect(preload).toContain("contextBridge.exposeInMainWorld('api', api);");
  for (const mapping of [
    "listSchedules: () => call<ScheduledRunListItem[]>('schedules:list'),",
    "pauseSchedule: (sessionId: string, paused: boolean) => call<ScheduledRun | null>('schedules:pause', { sessionId, paused }),",
    "runScheduleNow: (sessionId: string) => call<boolean>('schedules:runNow', { sessionId }),",
    "deleteSchedule: (sessionId: string) => call<boolean>('schedules:delete', { sessionId }),",
    "ipcRenderer.on('session:changed', wrapped)"
  ]) expect(preload).toContain(mapping);
});

it('registers the matching main-process handlers and converts schedule exceptions to IPC errors', () => {
  for (const mapping of [
    "handle('schedules:list', async () => listScheduleItems(",
    "handle('schedules:pause', async payload => {",
    "handle('schedules:runNow', async payload => {",
    "handle('schedules:delete', async payload => {"
  ]) expect(ipc).toContain(mapping);

  expect(ipc).toContain("const message = channel.startsWith('schedules:')\n        ? scheduleIpcError(err)");
  expect(ipc).toContain('return { ok: false as const, error: message };');
});
