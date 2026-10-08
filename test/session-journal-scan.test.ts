import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { createSession, flushSessions, initSessionStore, readEvents, resetSessionStoreForTests, sessionsRoot, upsertMessageEvent } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('cos-journal-scan-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushSessions(); await flushDurable();
  resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});

it('reads a tool-heavy journal in bounded blocks while retaining legacy UTF-8 and canonical messages', async () => {
  const session = await createSession({ title: 'Large journal', conversationId: 'bounded-journal' });
  await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: 10, messageId: 'question',
    message: { text: 'Current question', chars: 16, truncated: false } });
  await flushSessions();
  const journal = path.join(sessionsRoot(), session.id, 'events.jsonl');
  const legacyText = 'Mensaje 😀 café '.repeat(20_000);
  const olderQuestion = { seq: 2, kind: 'user_message', source: 'app', time: 8, messageId: 'question',
    message: { text: 'Superseded question', chars: 19, truncated: false } };
  const legacy = { seq: 3, kind: 'assistant_message', source: 'extension', time: 11, messageId: 'legacy-answer',
    message: { text: legacyText, chars: legacyText.length, truncated: false }, state: 'final', final: true };
  const notes = Array.from({ length: 200 }, (_, index) => JSON.stringify({ seq: index + 4, kind: 'note', source: 'app', time: index + 20,
    message: { text: 'x'.repeat(8_000), chars: 8_000, truncated: false } }));
  await fs.appendFile(journal, [JSON.stringify(olderQuestion), JSON.stringify(legacy), ...notes, 'broken journal line', ''].join('\n'));
  const readFile = vi.spyOn(fs, 'readFile');
  const opened = fs.open.bind(fs);
  const readSizes: number[] = [];
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await opened(...args);
    if (String(args[0]) === journal) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
        if (Buffer.isBuffer(readArgs[0])) readSizes.push(readArgs[0].length);
        return (read as any)(...readArgs);
      });
    }
    return handle;
  });
  const messages = await readEvents(session.id, { kinds: ['user_message', 'assistant_message'] });
  expect(messages.filter(event => event.kind === 'user_message').map(event => event.message.text)).toEqual(['Current question']);
  expect(messages.find(event => event.kind === 'assistant_message')!.message.text).toBe(legacyText);
  expect(readFile.mock.calls.some(([file]) => String(file) === journal)).toBe(false);
  expect(readSizes.length).toBeGreaterThan(1);
  expect(Math.max(...readSizes)).toBeLessThanOrEqual(256 * 1024);
  expect((await readEvents(session.id)).filter(event => event.kind === 'note')).toHaveLength(200);
});

it('discards an overlong torn line as one line, without parsing a valid-looking tail as a message', async () => {
  const session = await createSession({ title: 'Torn journal', conversationId: 'torn-journal' });
  await flushSessions();
  const journal = path.join(sessionsRoot(), session.id, 'events.jsonl');
  const message = (seq: number, text: string) => JSON.stringify({ seq, kind: 'user_message', source: 'app', time: seq,
    messageId: `legacy-${seq}`, message: { text, chars: text.length, truncated: false } });
  await fs.appendFile(journal, 'x'.repeat(600 * 1024) + message(10, 'phantom') + '\n' + message(11, 'kept after damage'));
  const events = await readEvents(session.id, { kinds: ['user_message'] });
  expect(events.map(event => event.kind === 'user_message' ? event.message.text : '')).toEqual(['kept after damage']);
});

it('does not chase journal growth while a scan is in flight', async () => {
  const session = await createSession({ title: 'Live journal', conversationId: 'growing-journal' });
  await flushSessions();
  const journal = path.join(sessionsRoot(), session.id, 'events.jsonl');
  const note = (seq: number, text: string) => JSON.stringify({ seq, kind: 'note', source: 'app', time: seq,
    message: { text, chars: text.length, truncated: false } }) + '\n';
  await fs.appendFile(journal, note(5, 'before scan'));
  const opened = fs.open.bind(fs);
  let appended = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await opened(...args);
    if (String(args[0]) === journal && !appended) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const snapshot = await stat();
        if (!appended) { appended = true; await fs.appendFile(journal, note(6, 'after scan started')); }
        return snapshot;
      });
    }
    return handle;
  });
  const first = await readEvents(session.id, { kinds: ['note'] });
  expect(first.map(event => event.kind === 'note' ? event.message.text : '')).toEqual(['before scan']);
  const later = await readEvents(session.id, { kinds: ['note'] });
  expect(later.map(event => event.kind === 'note' ? event.message.text : '')).toEqual(['before scan', 'after scan started']);
});
