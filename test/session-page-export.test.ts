import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';

const electron = vi.hoisted(() => ({
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn() }));
const files = vi.hoisted(() => ({ replaceFile: vi.fn(async () => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/store.js', () => store);
vi.mock('../src/main/replace-file.js', () => files);
const logger = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('../src/main/logger.js', async original => ({ ...await original<object>(), ...logger }));

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
    said(1, 'user_message', 'Fix /Users/ana/app with sk-proj-abcdefghijklmnopqrstuvwx'),
    said(2, 'assistant_message', 'The first part', { message: { text: 'The first part', truncated: true, chars: 40, assetId: 'abcdef12.txt' } }),
    said(3, 'assistant_message', 'still writing', { final: false, state: 'streaming' })
  ]);
  store.readOverflowText.mockResolvedValue('The first part, and **the rest** <b>bold</b>.');
});

const preview = async (hide: boolean, lang = 'en') => {
  const result = await exportSessionPage({ id: 'session-1', target: 'preview', hide, lang }, null);
  if (result.done !== 'preview') throw new Error(result.done);
  return result;
};

it('previews the whole chat, keys always hidden: what was cut in the log is read back, an unfinished answer is left out', async () => {
  const result = await preview(false);
  expect(result.html).toContain('Fix /Users/ana/app with <span class="hidden">hidden</span>');
  expect(result.html).not.toContain('sk-proj-');
  expect(result.html).toContain('The first part, and <strong>the rest</strong> &lt;b&gt;bold&lt;/b&gt;.');
  expect(result.html).not.toContain('still writing');
  expect(result.hidden).toBe(1);
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
});

it('also hides email addresses and user names in folder paths when asked, and counts every hidden detail', async () => {
  const result = await preview(true);
  expect(result.html).not.toMatch(/ana@|\/Users\/ana|sk-proj-/);
  expect(result.html).toContain('<title>Mail hidden</title>');
  expect(result.hidden).toBe(3);
});

it('saves exactly the page that was previewed, even if the chat went on meanwhile, and asks before replacing a file', async () => {
  const shown = await preview(true);
  store.readEvents.mockResolvedValue([said(1, 'user_message', 'Something new')]);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/page.html' });
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: shown.preview }, null)).resolves.toEqual({ done: 'saved', name: 'page.html' });
  expect(files.replaceFile).toHaveBeenCalledWith('/downloads/page.html', shown.html, 'HTML export');
  const options = electron.dialog.showSaveDialog.mock.calls[0]![0] as { defaultPath: string; filters: unknown; properties: string[] };
  // The hidden email address is not in the suggested file name either.
  expect(options.defaultPath).toMatch(/Mail hidden\.html$/);
  expect(options.filters).toEqual([{ name: 'HTML files', extensions: ['html'] }]);
  expect(options.properties).toContain('showOverwriteConfirmation');
});

it('keeps a key out of the suggested file name even with personal details shown', async () => {
  store.getSession.mockResolvedValue({ id: 'session-1', title: 'Rotate sk-proj-abcdefghijklmnopqrstuvwx' });
  const shown = await preview(false);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: shown.preview }, null)).resolves.toEqual({ done: 'cancelled' });
  expect((electron.dialog.showSaveDialog.mock.calls[0]![0] as { defaultPath: string }).defaultPath).toMatch(/Rotate hidden\.html$/);
  expect(files.replaceFile).not.toHaveBeenCalled();
});

it('refuses to save a page that was not the last one shown', async () => {
  const first = await preview(false);
  await preview(true);
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: first.preview }, null)).rejects.toThrow('The preview is out of date');
  const last = await preview(false);
  await expect(exportSessionPage({ id: 'other-session', target: 'file', preview: last.preview }, null)).rejects.toThrow('The preview is out of date');
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
});

it('logs why a save was refused', async () => {
  await preview(false);
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: 'not-the-one' }, null)).rejects.toThrow('The preview is out of date');
  expect(logger.logWarn).toHaveBeenCalledWith('page export: save refused, the preview is out of date');
});

it('keeps the newest preview when an older, slower one finishes last, so the page the dialog shows can be saved', async () => {
  let release!: () => void;
  const slow = new Promise<void>(done => { release = done; });
  const events = await store.readEvents();
  store.readEvents.mockImplementationOnce(async () => { await slow; return events; });
  const older = exportSessionPage({ id: 'session-1', target: 'preview', hide: true, lang: 'en' }, null);
  const newer = await preview(false);
  release();
  const late = await older;
  if (late.done !== 'preview') throw new Error(late.done);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/page.html' });
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: newer.preview }, null)).resolves.toEqual({ done: 'saved', name: 'page.html' });
  expect(files.replaceFile).toHaveBeenCalledWith('/downloads/page.html', newer.html, 'HTML export');
  await expect(exportSessionPage({ id: 'session-1', target: 'file', preview: late.preview }, null)).rejects.toThrow('The preview is out of date');
});

it('says a chat with nothing said yet has nothing to share', async () => {
  store.readEvents.mockResolvedValue([]);
  await expect(preview(false)).rejects.toThrow('This chat has nothing to share yet');
});

it('labels the page in the interface language and names an untitled chat like the app does', async () => {
  setMainTextTranslations({ You: 'Du', 'New chat': 'Neuer Chat', hidden: 'ausgeblendet', 'Shared from Chat On Steroids': 'Geteilt aus Chat On Steroids' });
  store.getSession.mockResolvedValue({ id: 'session-1', title: '  ' });
  const result = await preview(false, 'de');
  expect(result.html).toContain('<html lang="de">');
  expect(result.html).toContain('<title>Neuer Chat</title>');
  expect(result.html).toContain('<h2>Du</h2>');
  expect(result.html).toContain('<span class="hidden">ausgeblendet</span>');
  expect(result.html).toMatch(/<p class="date">\d{1,2}\. \S+ \d{4}<\/p>/);
  expect(result.html).toContain('<footer>Geteilt aus Chat On Steroids</footer>');
});
