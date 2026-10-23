import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';

const electron = vi.hoisted(() => ({
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn() }));
const files = vi.hoisted(() => ({ writeFile: vi.fn(async () => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/store.js', () => store);
vi.mock('node:fs', () => ({ promises: files }));

const { exportSessionPage } = await import('../src/main/session/page-export.js');
const { setMainTextTranslations } = await import('../src/main/main-texts.js');

const said = (seq: number, kind: 'user_message' | 'assistant_message', text: string, extra: Record<string, unknown> = {}) =>
  ({ seq, time: seq, source: 'extension', kind, turnId: 't1', messageId: `m${seq}`, final: true, state: 'final',
    message: { text, truncated: false, chars: text.length }, ...extra }) as unknown as SessionEvent;

beforeEach(() => {
  vi.clearAllMocks();
  setMainTextTranslations({});
  store.getSession.mockResolvedValue({ id: 'session-1', title: 'Mail ana@example.com' });
  store.readEvents.mockResolvedValue([
    said(1, 'user_message', 'Fix /Users/ana/app'),
    said(2, 'assistant_message', 'The first part', { message: { text: 'The first part', truncated: true, chars: 40, assetId: 'abcdef12.txt' } }),
    said(3, 'assistant_message', 'still writing', { final: false, state: 'streaming' })
  ]);
  store.readOverflowText.mockResolvedValue('The first part, and **the rest**.');
});

const preview = (hide: boolean) => exportSessionPage({ id: 'session-1', target: 'preview', hide, lang: 'en' }, null);

it('previews the whole chat: what was cut in the log is read back, an unfinished answer is left out', async () => {
  const result = await preview(false);
  if (result.done !== 'preview') throw new Error(result.done);
  expect(result.html).toContain('Fix /Users/ana/app');
  expect(result.html).toContain('The first part, and <strong>the rest</strong>.');
  expect(result.html).not.toContain('still writing');
  expect(result.hidden).toBe(0);
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
});

it('saves exactly the page that was previewed, even if the chat went on meanwhile', async () => {
  const shown = await preview(true);
  if (shown.done !== 'preview') throw new Error(shown.done);
  expect(shown.hidden).toBe(2);
  store.readEvents.mockResolvedValue([said(1, 'user_message', 'Something new')]);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/page.html' });
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: shown.preview }, null)).resolves.toEqual({ done: 'saved', name: 'page.html' });
  expect(files.writeFile).toHaveBeenCalledWith('/downloads/page.html', shown.html, 'utf8');
  // The hidden email address is not in the suggested file name either.
  const options = electron.dialog.showSaveDialog.mock.calls[0]![0] as { defaultPath: string; filters: unknown };
  expect(options.defaultPath).toMatch(/Mail hidden\.html$/);
  expect(options.filters).toEqual([{ name: 'Web pages', extensions: ['html'] }]);
});

it('refuses to save a page that was not the last one shown', async () => {
  const first = await preview(false);
  await preview(true);
  if (first.done !== 'preview') throw new Error(first.done);
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: first.preview }, null)).rejects.toThrow('The preview is out of date');
  const last = await preview(false);
  if (last.done !== 'preview') throw new Error(last.done);
  await expect(exportSessionPage({ id: 'other-session', target: 'file', preview: last.preview }, null)).rejects.toThrow('The preview is out of date');
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
});

it('writes nothing when the save dialog is cancelled', async () => {
  const shown = await preview(false);
  if (shown.done !== 'preview') throw new Error(shown.done);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: shown.preview }, null)).resolves.toEqual({ done: 'cancelled' });
  expect(files.writeFile).not.toHaveBeenCalled();
});

it('says a chat with nothing said yet has nothing to share', async () => {
  store.readEvents.mockResolvedValue([]);
  await expect(preview(false)).rejects.toThrow('This chat has nothing to share yet');
});

it('labels the page in the interface language and names an untitled chat like the app does', async () => {
  setMainTextTranslations({ You: 'Du', 'New chat': 'Neuer Chat', 'Shared from Chat On Steroids': 'Geteilt aus Chat On Steroids' });
  store.getSession.mockResolvedValue({ id: 'session-1', title: '  ' });
  const result = await exportSessionPage({ id: 'session-1', target: 'preview', hide: false, lang: 'de' }, null);
  if (result.done !== 'preview') throw new Error(result.done);
  expect(result.html).toContain('<html lang="de">');
  expect(result.html).toContain('<title>Neuer Chat</title>');
  expect(result.html).toContain('<div class="who">Du</div>');
  expect(result.html).toContain('<footer>Geteilt aus Chat On Steroids</footer>');
});
