import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../src/shared/session.js';

const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn() }));
const files = vi.hoisted(() => ({ writeFile: vi.fn(async () => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/store.js', () => store);
vi.mock('node:fs', () => ({ promises: files }));

const { exportSessionMarkdown } = await import('../src/main/session/markdown-export.js');

const events: SessionEvent[] = [
  { seq: 1, time: 1, source: 'extension', kind: 'user_message', turnId: 't1', messageId: 'u1', message: { text: 'Explain it', truncated: false, chars: 10 } },
  { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final',
    message: { text: 'The first part', truncated: true, chars: 40, assetId: 'abcdef12.txt' } },
  { seq: 3, time: 3, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' }
] as SessionEvent[];

beforeEach(() => {
  vi.clearAllMocks();
  store.getSession.mockResolvedValue({ id: 'session-1', title: 'Explain: it?' });
  store.readEvents.mockResolvedValue(events);
  store.readOverflowText.mockResolvedValue('The first part, and the rest of the answer.');
});

it('copies a completed answer whole, reading the part the log cut', async () => {
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null)).resolves.toEqual({ done: 'copied' });
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('The first part, and the rest of the answer.\n');
});

it('saves the session transcript where the person chooses, named after the chat', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/Explain it.md' });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'session', target: 'file' }, null)).resolves.toEqual({ done: 'saved', name: 'Explain it.md' });
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toMatchObject({ defaultPath: expect.stringContaining('Explain it.md') });
  expect(files.writeFile).toHaveBeenCalledWith('/downloads/Explain it.md',
    '# Explain: it?\n\n## You\n\nExplain it\n\n## ChatGPT\n\nThe first part, and the rest of the answer.\n', 'utf8');
});

it('writes nothing when the save dialog is cancelled, and refuses unfinished turns', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'file' }, null)).resolves.toEqual({ done: 'cancelled' });
  expect(files.writeFile).not.toHaveBeenCalled();
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 'open-turn', target: 'clipboard' }, null)).rejects.toThrow('has not completed');
});

// The clipboard write is asynchronous. It was not awaited, so a failed copy still answered "copied".
it('says a copy failed when the clipboard refuses it, instead of "copied"', async () => {
  electron.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null)).rejects.toThrow('clipboard unavailable');
});


// ChatGPT's link cards are private-use markup in the raw text; the copy gets a real Markdown link.
it('copies link cards as Markdown links instead of their raw markers', async () => {
  store.readOverflowText.mockResolvedValue('Open urlthe comparisonhttps://github.com/o/r/compare and merge it.');
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('Open [the comparison](https://github.com/o/r/compare) and merge it.\n');
});

it('copies the rows of a table ChatGPT drew but wrote with only its header (#1477)', async () => {
  const html = '<div data-d-component="table"><table><tr><td><p><span>Item</span></p></td><td><p>Qty</p></td></tr>' +
    '<tr><td><p>Rice</p></td><td><p>1 kg</p></td></tr><tr><td><p>Milk</p></td><td><p>2 l</p></td></tr></table></div>' +
    '<button type="button" data-d-component="button"><span>Copy list</span></button>';
  store.readEvents.mockResolvedValue([
    events[0]!,
    { seq: 2, time: 2, source: 'extension', kind: 'assistant_message', turnId: 't1', messageId: 'a1', final: true, state: 'final',
      message: { text: '| **Item** | **Qty** |\n|---|---|\n\n[Copy list]', truncated: false, chars: 40 },
      renderedHtml: { text: html, truncated: false, chars: html.length } },
    events[2]!
  ] as SessionEvent[]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('| **Item** | **Qty** |\n|---|---|\n| Rice | 1 kg |\n| Milk | 2 l |\n');
});

// An answer recorded outside any turn (copied branch history, an adopted chat) has no turn to name.
it('copies an answer recorded without a turn by its message id, and only such an answer', async () => {
  store.readEvents.mockResolvedValue([...events,
    { seq: 4, time: 4, source: 'extension', kind: 'assistant_message', messageId: 'loose-1', final: true, state: 'final',
      message: { text: 'An earlier answer', truncated: false, chars: 17 } }] as SessionEvent[]);
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', messageId: 'loose-1', target: 'clipboard' }, null)).resolves.toEqual({ done: 'copied' });
  expect(electron.clipboard.writeText).toHaveBeenCalledWith('An earlier answer\n');
  // A turn's own answer is exported by its turn; an unknown or turn-owned id is refused.
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', messageId: 'a1', target: 'clipboard' }, null)).rejects.toThrow('no answer to export');
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', target: 'clipboard' }, null)).rejects.toThrow('has not completed');
});

// /copy names no answer: it copies the chat's newest finished one, never a turn still being written.
it('copies the newest finished answer for /copy, skipping a turn that is still open', async () => {
  const loose = { seq: 4, time: 4, source: 'extension', kind: 'assistant_message', messageId: 'loose-1', final: true, state: 'final',
    message: { text: 'A later answer outside any turn', truncated: false, chars: 31 } };
  const ask = { seq: 5, time: 5, source: 'extension', kind: 'user_message', turnId: 't2', messageId: 'u2', message: { text: 'And now?', truncated: false, chars: 8 } };
  const reply = { seq: 6, time: 6, source: 'extension', kind: 'assistant_message', turnId: 't2', messageId: 'a2', final: true, state: 'final',
    message: { text: 'Done now', truncated: false, chars: 8 } };
  store.readEvents.mockResolvedValue([...events, loose, ask, reply] as SessionEvent[]);
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null)).resolves.toEqual({ done: 'copied' });
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('A later answer outside any turn\n');
  store.readEvents.mockResolvedValue([...events, loose, ask, reply,
    { seq: 7, time: 7, source: 'extension', kind: 'turn_end', turnId: 't2', outcome: 'completed' }] as SessionEvent[]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('Done now\n');
  store.readEvents.mockResolvedValue([events[0]!]);
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null)).rejects.toThrow('This chat has no finished answer yet');
});

it('skips a completed turn that started again for /copy until it ends again', async () => {
  const later = [
    { seq: 4, time: 4, source: 'extension', kind: 'user_message', turnId: 't2', messageId: 'u2', message: { text: 'And now?', truncated: false, chars: 8 } },
    { seq: 5, time: 5, source: 'extension', kind: 'assistant_message', turnId: 't2', messageId: 'a2', final: true, state: 'final',
      message: { text: 'Done now', truncated: false, chars: 8 } },
    { seq: 6, time: 6, source: 'extension', kind: 'turn_end', turnId: 't2', outcome: 'completed' },
    { seq: 7, time: 7, source: 'app', kind: 'turn_start', turnId: 't2' }
  ];
  store.readEvents.mockResolvedValue([...events, ...later] as SessionEvent[]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('The first part, and the rest of the answer.\n');
  store.readEvents.mockResolvedValue([...events, ...later, { seq: 8, time: 8, source: 'extension', kind: 'turn_end', turnId: 't2', outcome: 'completed' }] as SessionEvent[]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('Done now\n');
});
