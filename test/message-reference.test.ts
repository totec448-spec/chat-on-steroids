import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ caps: { screen: true, control: true }, session: vi.fn(), message: vi.fn(), execute: vi.fn() }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({}), effectiveCapabilities: () => f.caps }));
vi.mock('../src/main/session/store.js', () => ({ getSession: f.session, readRecordedAssistantMessage: f.message }));
vi.mock('../src/main/browser-control.js', () => ({ browserControl: { execute: f.execute } }));
import { openRecordedReference } from '../src/main/session/message-reference.js';
const conversationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', messageId = '11111111-2222-4333-8444-555555555555';
const reference = { index: 0, type: 'file', name: 'report.py', path: '/mnt/data/report.py', sourceMessageId: messageId };
beforeEach(() => {
  vi.clearAllMocks(); f.caps.screen = true; f.caps.control = true;
  f.session.mockResolvedValue({ conversationId, chatIds: [conversationId] });
  f.message.mockResolvedValue({ providerMessageId: messageId, presentation: { conversationId, references: [reference] } });
  f.execute.mockResolvedValue({ value: { requested: true } });
});
it('dispatches only stored file metadata and revalidates it before native input', async () => {
  expect(await openRecordedReference('test-session', messageId, 0)).toBe(true);
  const call = f.execute.mock.calls[0]!;
  expect(call.slice(0, 4)).toEqual(['open_recorded_reference', { conversationId, messageId, reference }, 'ui-reference:test-session', conversationId]);
  expect(await call[4]()).toBe(true);
  f.message.mockResolvedValue(undefined);
  await expect(call[4]()).rejects.toThrow('verified');
});
it('does not reinterpret a sandbox file as a local path or follow a foreign conversation', async () => {
  f.session.mockResolvedValue({ conversationId: 'other', chatIds: [] });
  await expect(openRecordedReference('test-session', messageId, 0)).rejects.toThrow('verified');
  expect(f.execute).not.toHaveBeenCalled();
});
it('requires current browser control permission and never retries an unconfirmed result', async () => {
  f.caps.control = false;
  await expect(openRecordedReference('test-session', messageId, 0)).rejects.toThrow('control');
  expect(f.execute).not.toHaveBeenCalled();
  f.caps.control = true; f.execute.mockResolvedValue({ error: 'BROWSER_RESULT_UNCONFIRMED' });
  await expect(openRecordedReference('test-session', messageId, 0)).rejects.toThrow('UNCONFIRMED');
  expect(f.execute).toHaveBeenCalledTimes(1);
});
