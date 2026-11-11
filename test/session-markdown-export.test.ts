import { beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionEvent } from '../src/shared/session.js';

const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/downloads') }
}));
const store = vi.hoisted(() => ({ getSession: vi.fn(), readEvents: vi.fn(), readOverflowText: vi.fn(),
  readAsset: vi.fn(), MAX_OVERFLOW_ASSET_CHARS: 8 * 1024 * 1024 }));
const files = vi.hoisted(() => ({ replaceFile: vi.fn(async () => undefined) }));
vi.mock('electron', () => electron);
vi.mock('../src/main/session/store.js', () => store);
vi.mock('../src/main/replace-file.js', () => files);
const logger = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock('../src/main/logger.js', async original => ({ ...await original<object>(), ...logger }));

const { exportSessionMarkdown, fullText } = await import('../src/main/session/markdown-export.js');
const { exportSessionPage } = await import('../src/main/session/page-export.js');

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

it.each(['clipboard', 'file'] as const)('separates a list message from the next message’s indented code in %s', async target => {
  store.readEvents.mockResolvedValue([
    events[0]!,
    { ...events[1]!, message: { text: '- Notes', truncated: false, chars: 7 } },
    { ...events[1]!, seq: 3, messageId: 'a2', message: { text: '    echo *text*', truncated: false, chars: 15 } },
    { ...events[2]!, seq: 4 }
  ]);
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/code.md' });
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target }, null);
  const expected = '- Notes\n\n<!-- -->\n\n    echo *text*\n';
  if (target === 'clipboard') expect(electron.clipboard.writeText).toHaveBeenCalledWith(expected);
  else expect(files.replaceFile).toHaveBeenCalledWith('/downloads/code.md', expected, 'Markdown export');
});

it('saves the session transcript where the person chooses, named after the chat', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/Explain it.md' });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'session', target: 'file' }, null)).resolves.toEqual({ done: 'saved', name: 'Explain it.md' });
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0]).toMatchObject({ defaultPath: expect.stringContaining('Explain it.md') });
  // Linux replaces a file without asking unless the dialog is told to confirm.
  expect(electron.dialog.showSaveDialog.mock.calls[0]![0].properties).toContain('showOverwriteConfirmation');
  expect(files.replaceFile).toHaveBeenCalledWith('/downloads/Explain it.md',
    '# Explain: it?\n\n## You\n\nExplain it\n\n## ChatGPT\n\nThe first part, and the rest of the answer.\n', 'Markdown export');
});

it('writes nothing when the save dialog is cancelled, and refuses unfinished turns', async () => {
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true });
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'file' }, null)).resolves.toEqual({ done: 'cancelled' });
  expect(files.replaceFile).not.toHaveBeenCalled();
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

it('copies distinct rows for drawn tables that share column headings', async () => {
  const table = (item: string, quantity: string) => '<div data-d-component="table"><table>' +
    `<tr><td>Item</td><td>Qty</td></tr><tr><td>${item}</td><td>${quantity}</td></tr></table></div>`;
  const html = table('Rice', '1 kg') + table('Milk', '2 l');
  const markdown = '## Before\n| Item | Qty |\n|---|---|\n\n## After\n| Item | Qty |\n|---|---|';
  store.readEvents.mockResolvedValue([
    events[0]!,
    { ...events[1]!, message: { text: markdown, truncated: false, chars: markdown.length },
      renderedHtml: { text: html, truncated: false, chars: html.length } },
    events[2]!
  ]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenCalledWith(
    '## Before\n| Item | Qty |\n|---|---|\n| Rice | 1 kg |\n\n## After\n| Item | Qty |\n|---|---|\n| Milk | 2 l |\n');
});

it.each([
  ['answer', 'clipboard'], ['latest', 'clipboard'], ['answer', 'file'], ['session', 'file']
] as const)('reads both text and drawing overflow for %s export to %s', async (scope, target) => {
  const markdown = '| Item | Qty |\n|---|---|';
  const html = '<p>' + 'x'.repeat(120_000) + '</p><div data-d-component="table"><table>' +
    '<tr><td>Item</td><td>Qty</td></tr><tr><td>Rice</td><td>1 kg</td></tr></table></div>';
  store.readEvents.mockResolvedValue([
    events[0]!,
    { ...events[1]!, message: { text: '| Item', truncated: true, chars: markdown.length, assetId: 'abcdef12.txt' },
      renderedHtml: { text: html.slice(0, 120_000), truncated: true, chars: html.length, assetId: 'abcdef34.txt' } },
    events[2]!
  ]);
  store.readOverflowText.mockResolvedValue(markdown);
  store.readAsset.mockResolvedValue(Buffer.from(html));
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/table.md' });
  await exportSessionMarkdown({ id: 'session-1', scope, turnId: 't1', target }, null);
  const answer = `${markdown}\n| Rice | 1 kg |\n`;
  if (target === 'clipboard') expect(electron.clipboard.writeText).toHaveBeenCalledWith(answer);
  else expect(files.replaceFile).toHaveBeenCalledWith('/downloads/table.md',
    scope === 'session' ? `# Explain: it?\n\n## You\n\nExplain it\n\n## ChatGPT\n\n${answer}` : answer, 'Markdown export');
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
  expect(store.readAsset).toHaveBeenCalledWith('session-1', 'abcdef34.txt', 32 * 1024 * 1024);
});

it.each([undefined, 'abcdef34.txt'])('does not complete a partial drawing when its overflow is unavailable (%s)', async assetId => {
  const markdown = '| Item | Qty |\n|---|---|';
  const partial = '<div data-d-component="table"><table><tr><td>Item</td><td>Qty</td></tr>' +
    '<tr><td>Rice</td><td>1 kg</td></tr></table></div>';
  store.readOverflowText.mockResolvedValue(null);
  store.readAsset.mockResolvedValue(null);
  await expect(fullText('session-1', { text: markdown, truncated: false, chars: markdown.length },
    { text: partial, truncated: true, chars: 120_001, ...(assetId ? { assetId } : {}) })).resolves.toBe(markdown);
  expect(store.readAsset).toHaveBeenCalledTimes(assetId ? 1 : 0);
  expect(logger.logWarn).toHaveBeenCalledExactlyOnceWith(assetId
    ? 'Markdown export: drawing overflow unavailable or over the read limit; table completion kept partial'
    : 'Markdown export: drawing overflow was not stored; table completion kept partial');
});

it.each(['answer', 'latest', 'session', 'page'] as const)('serializes drawing recovery for %s, including repeated assets', async scope => {
  const markdown = '| Item | Qty |\n|---|---|';
  const html = '<div data-d-component="table"><table><tr><td>Item</td><td>Qty</td></tr>' +
    '<tr><td>Rice</td><td>1 kg</td></tr></table></div>';
  const drawing = { text: html.slice(0, 20), truncated: true, chars: html.length, assetId: 'abcdef34.txt' };
  store.readEvents.mockResolvedValue([
    ...[1, 2, 3].map(seq => ({ ...events[1]!, seq, messageId: `a${seq}`,
      message: { text: markdown, truncated: false, chars: markdown.length }, renderedHtml: drawing })),
    { ...events[2]!, seq: 4 }
  ]);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { entered = done; });
  let active = 0, peak = 0;
  store.readAsset.mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    entered();
    await held;
    active--;
    return Buffer.from(html);
  });
  const pending = scope === 'page'
    ? exportSessionPage({ id: 'session-1', target: 'preview', hide: false, lang: 'en' }, null)
    : exportSessionMarkdown({ id: 'session-1', scope, turnId: 't1', target: 'clipboard' }, null);
  const overlappingCopy = scope === 'page'
    ? exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't1', target: 'clipboard' }, null) : null;
  await started;
  try { expect(store.readAsset).toHaveBeenCalledTimes(1); }
  finally { release(); await Promise.all([pending, overlappingCopy]); }
  expect(peak).toBe(1);
  expect(store.readAsset).toHaveBeenCalledTimes(scope === 'page' ? 6 : 3);
  const result = await pending;
  if (result.done === 'preview') expect(result.html.match(/<td>Rice<\/td>/g)).toHaveLength(3);
  expect(electron.clipboard.writeText.mock.calls[0]![0].match(/Rice/g)).toHaveLength(3);
});

it('releases the recovery slot after a failed read so a concurrent export can finish', async () => {
  const stored = { text: 'Kept answer', truncated: true, chars: 11, assetId: 'abcdef12.txt' };
  store.readOverflowText.mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce('Kept answer');
  const failed = fullText('session-1', stored);
  const next = fullText('session-1', stored);
  await expect(failed).rejects.toThrow('read failed');
  await expect(next).resolves.toBe('Kept answer');
});

it('refuses a crash-shortened drawing even after a recorder retry reuses the asset', async () => {
  const realStore = await vi.importActual<typeof import('../src/main/session/store.js')>('../src/main/session/store.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-short-drawing-'));
  realStore.initSessionStore(directory);
  try {
    const session = await realStore.createSession({ title: 'Synthetic interrupted drawing' });
    const markdown = '| Item | Qty |\n|---|---|';
    const prefix = '<div data-d-component="table"><table><tr><td>Item</td><td>Qty</td></tr>' +
      '<tr><td>米🧪</td><td>1 kg</td></tr></table></div>';
    const whole = prefix + '<p>' + 'x'.repeat(120_000) + '</p>';
    const assetId = (await realStore.writeOverflowText(session.id, whole))!;
    await fs.writeFile(path.join(realStore.sessionsRoot(), session.id, 'assets', assetId), prefix);
    expect(await realStore.writeOverflowText(session.id, whole)).toBe(assetId);
    store.readAsset.mockImplementation(realStore.readAsset);
    const stored = { text: markdown, truncated: false, chars: markdown.length };
    const drawing = { text: prefix, truncated: true, chars: whole.length, assetId };
    await expect(fullText(session.id, stored, drawing)).resolves.toBe(markdown);
    expect(logger.logWarn).toHaveBeenCalledExactlyOnceWith(
      'Markdown export: drawing overflow length mismatch; table completion kept partial');
    await fs.writeFile(path.join(realStore.sessionsRoot(), session.id, 'assets', assetId), whole);
    await expect(fullText(session.id, stored, drawing)).resolves.toBe(`${markdown}\n| 米🧪 | 1 kg |`);
  } finally {
    await realStore.flushSessions();
    realStore.resetSessionStoreForTests();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([{ bytes: [0xff] }, { bytes: [0xf0, 0x90, 0x80] }])('refuses invalid UTF-8 drawing bytes $bytes even when the character count matches', async ({ bytes }) => {
  const realStore = await vi.importActual<typeof import('../src/main/session/store.js')>('../src/main/session/store.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-utf8-drawing-'));
  realStore.initSessionStore(directory);
  try {
    const session = await realStore.createSession({ title: 'Synthetic damaged drawing' });
    const markdown = '| Item | Qty |\n|---|---|';
    const html = '<p>' + 'x'.repeat(120_000) + '</p><div data-d-component="table"><table>' +
      '<tr><td>Item</td><td>Qty</td></tr><tr><td>米🧪</td><td>1 kg</td></tr></table></div>';
    const original = Buffer.from(html);
    const at = original.indexOf(Buffer.from('米'));
    const damaged = Buffer.concat([original.subarray(0, at), Buffer.from(bytes), original.subarray(at + Buffer.byteLength('米'))]);
    const recovered = damaged.toString('utf8');
    expect(recovered.length).toBe(html.length);
    // The incomplete four-byte sequence also fools a re-encoded byte-length comparison.
    if (bytes.length === 3) expect(Buffer.byteLength(recovered)).toBe(damaged.length);
    const assetId = (await realStore.writeOverflowText(session.id, html))!;
    const asset = path.join(realStore.sessionsRoot(), session.id, 'assets', assetId);
    await fs.writeFile(asset, damaged);
    store.readAsset.mockImplementation(realStore.readAsset);
    const stored = { text: markdown, truncated: false, chars: markdown.length };
    const drawing = { text: html.slice(0, 120_000), truncated: true, chars: html.length, assetId };
    await expect(fullText(session.id, stored, drawing)).resolves.toBe(markdown);
    expect(logger.logWarn).toHaveBeenCalledExactlyOnceWith(
      'Markdown export: drawing overflow invalid UTF-8; table completion kept partial');
    await fs.writeFile(asset, original);
    await expect(fullText(session.id, stored, drawing)).resolves.toBe(`${markdown}\n| 米🧪 | 1 kg |`);
  } finally {
    await realStore.flushSessions();
    realStore.resetSessionStoreForTests();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('accepts valid UTF-8 containing an authored replacement character', async () => {
  const markdown = '| Item | Qty |\n|---|---|';
  const html = '<div data-d-component="table"><table><tr><td>Item</td><td>Qty</td></tr>' +
    '<tr><td>米🧪�</td><td>1 kg</td></tr></table></div>';
  store.readAsset.mockResolvedValue(Buffer.from(html));
  await expect(fullText('session-1', { text: markdown, truncated: false, chars: markdown.length },
    { text: html.slice(0, 20), truncated: true, chars: html.length, assetId: 'abcdef34.txt' }))
    .resolves.toBe(`${markdown}\n| 米🧪� | 1 kg |`);
  expect(logger.logWarn).not.toHaveBeenCalled();
});

it('reads a legacy drawing above the current write cap, but refuses an oversized file before loading it', async () => {
  const realStore = await vi.importActual<typeof import('../src/main/session/store.js')>('../src/main/session/store.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-drawing-export-'));
  realStore.initSessionStore(directory);
  try {
    const session = await realStore.createSession({ title: 'Synthetic legacy drawing' });
    const markdown = '| Item | Qty |\n|---|---|';
    const html = '<p>' + 'x'.repeat(realStore.MAX_ASSET_BYTES + 1) + '</p><div data-d-component="table"><table>' +
      '<tr><td>Item</td><td>Qty</td></tr><tr><td>Rice</td><td>1 kg</td></tr></table></div>';
    // Simulate an already-saved legacy asset, not a new write that today's store would reject.
    const asset = path.join(realStore.sessionsRoot(), session.id, 'assets', 'abcdef34.txt');
    await fs.mkdir(path.dirname(asset), { recursive: true });
    await fs.writeFile(asset, html);
    store.readAsset.mockImplementation(realStore.readAsset);
    const stored = { text: markdown, truncated: false, chars: markdown.length };
    const drawing = { text: html.slice(0, 120_000), truncated: true, chars: html.length, assetId: 'abcdef34.txt' };
    await expect(fullText(session.id, stored, drawing)).resolves.toBe(`${markdown}\n| Rice | 1 kg |`);
    // A sparse oversized fixture exercises readAsset's stat-before-allocation bound.
    await fs.truncate(asset, realStore.MAX_OVERFLOW_ASSET_CHARS * 4 + 1);
    await expect(fullText(session.id, stored, drawing)).resolves.toBe(markdown);
    expect(logger.logWarn).toHaveBeenCalledExactlyOnceWith(
      'Markdown export: drawing overflow unavailable or over the read limit; table completion kept partial');
  } finally {
    await realStore.flushSessions();
    realStore.resetSessionStoreForTests();
    await fs.rm(directory, { recursive: true, force: true });
  }
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
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't2', target: 'clipboard' }, null))
    .rejects.toThrow('This turn has not completed');
  await expect(exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't2', target: 'file' }, null))
    .rejects.toThrow('This turn has not completed');
  expect(electron.clipboard.writeText).not.toHaveBeenCalled();
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
  await exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('The first part, and the rest of the answer.\n');
  store.readEvents.mockResolvedValue([...events, ...later, { seq: 8, time: 8, source: 'extension', kind: 'turn_end', turnId: 't2', outcome: 'completed' }] as SessionEvent[]);
  await exportSessionMarkdown({ id: 'session-1', scope: 'answer', turnId: 't2', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('Done now\n');
  await exportSessionMarkdown({ id: 'session-1', scope: 'latest', target: 'clipboard' }, null);
  expect(electron.clipboard.writeText).toHaveBeenLastCalledWith('Done now\n');
});

it.each(['clipboard', 'file'] as const)('recovers drawing overflow for %s only after a reopened answer completes again', async target => {
  const markdown = '| Item | Qty |\n|---|---|';
  const html = '<div data-d-component="table"><table><tr><td>Item</td><td>Qty</td></tr>' +
    '<tr><td>Rice</td><td>1 kg</td></tr></table></div>';
  const reopened = [events[0]!,
    { ...events[1]!, message: { text: '| Item', truncated: true, chars: markdown.length, assetId: 'abcdef12.txt' },
      renderedHtml: { text: html.slice(0, 20), truncated: true, chars: html.length, assetId: 'abcdef34.txt' } },
    events[2]!, { seq: 4, time: 4, source: 'app', kind: 'turn_start', turnId: 't1' }
  ] as SessionEvent[];
  store.readEvents.mockResolvedValue(reopened);
  store.readOverflowText.mockResolvedValue(markdown);
  store.readAsset.mockResolvedValue(Buffer.from(html));
  electron.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/downloads/table.md' });
  const request = { id: 'session-1', scope: 'answer' as const, turnId: 't1', target };
  await expect(exportSessionMarkdown(request, null)).rejects.toThrow('This turn has not completed');
  expect(store.readOverflowText).not.toHaveBeenCalled();
  expect(store.readAsset).not.toHaveBeenCalled();
  expect(electron.clipboard.writeText).not.toHaveBeenCalled();
  expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
  expect(files.replaceFile).not.toHaveBeenCalled();
  expect(logger.logWarn).toHaveBeenCalledExactlyOnceWith('Markdown export: answer refused because its turn has not completed');

  store.readEvents.mockResolvedValue([...reopened,
    { seq: 5, time: 5, source: 'extension', kind: 'turn_end', turnId: 't1', outcome: 'completed' }]);
  await exportSessionMarkdown(request, null);
  expect(store.readOverflowText).toHaveBeenCalledWith('session-1', 'abcdef12.txt');
  expect(store.readAsset).toHaveBeenCalledWith('session-1', 'abcdef34.txt', 32 * 1024 * 1024);
  const answer = `${markdown}\n| Rice | 1 kg |\n`;
  if (target === 'clipboard') expect(electron.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(answer);
  else expect(files.replaceFile).toHaveBeenCalledExactlyOnceWith('/downloads/table.md', answer, 'Markdown export');
});
