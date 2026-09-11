import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { observeRequestCorrelation, requestCorrelation } from '../src/main/session/correlation.js';
import { recordToolCall, recordChatObservations, recordRequestEvidence, sessionForConversation, flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import { appendEvent, createSession, flushSessions, initSessionStore, readActivityEvents, readAsset, readEvents, readRecentEvents, resetSessionStoreForTests, unsetSessionRootForTests, upsertMessageEvent } from '../src/main/session/store.js';

let dir = '';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const call = (requestId?: string, conversationId?: string) => ({ tool: 'read', args: {}, content: [{ type: 'text', text: requestId ?? 'anonymous' }], outcome: 'ok' as const, durationMs: 1, startedAt: Date.now(), requestId, conversationId });

it('redacts pasted credentials from nested browser arguments, protocol results and spill assets without mutating input or image bytes', async () => {
  const secret = 'sk-or-v1-' + 'testfixture'.repeat(6);
  const id = await sessionForConversation('conv-browser-redaction');
  const args = { fields: [{ name: 'api', value: secret }], code: `await page.fill('input', '${secret}')`, padding: 'x'.repeat(40_000) };
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
  const result = { content: [{ type: 'text', text: `${secret}\n${'result '.repeat(15_000)}${secret}` }], structuredContent: { fields: [{ value: secret }] } };
  await recordToolCall({ ...call('browser-secret', 'conv-browser-redaction'), tool: 'browser_fill_form', args,
    content: [...result.content, { type: 'image', data: image, mimeType: 'image/png' }], protocolResult: result });
  const event = (await readEvents(id!, { kinds: ['tool_call'] }))[0]!;
  if (event.kind !== 'tool_call') throw new Error('missing recorded call');
  expect(JSON.stringify(event)).not.toContain(secret);
  expect(event.call.args.assetId).toBeDefined();
  expect(event.call.result.assetId).toBeDefined();
  for (const text of [event.call.args, event.call.result]) {
    const full = (await readAsset(id!, text.assetId!))!.toString();
    expect(full).not.toContain(secret);
    expect(full).toContain('[redacted]');
  }
  expect(await readAsset(id!, event.call.assets![0]!.id)).toEqual(Buffer.from(image, 'base64'));
  expect(args.fields[0]!.value).toBe(secret);
  expect(result.structuredContent.fields[0]!.value).toBe(secret);
});
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-backend-'));
  initConfigPath(dir); initSessionStore(dir); initDurableStore(dir);
  await saveConfig(defaultConfig());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushRecorder(); await flushSessions(); await flushDurable();
  resetRecorderForTests(); resetSessionStoreForTests(); unsetSessionRootForTests(); resetDurableForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

it('a proven chat completes while an unrelated request waits for evidence; shutdown includes the waiter', async () => {
  const a = await sessionForConversation('conv-a');
  const b = await sessionForConversation('conv-b');
  const waiting = recordToolCall(call('waiting-a'));
  let flushed = false;
  const flushing = flushRecorder().then(() => { flushed = true; });
  try {
    const known = await recordToolCall(call('known-b', 'conv-b'));
    expect(known?.conversationId).toBe('conv-b');
    expect((await readEvents(b!, { kinds: ['tool_call'] })).length).toBe(1);
    expect(flushed).toBe(false);
  } finally {
    observeRequestCorrelation({ requestId: 'waiting-a', conversationId: 'conv-a', sessionId: a!, messageId: 'a', tool: 'read', observedAt: Date.now() });
    await waiting; await flushing;
  }
});

it('same workflow preserves admission order when a later call already knows its owner', async () => {
  const id = await sessionForConversation('conv-order');
  const first = recordToolCall({ ...call('workflow'), args: { order: 1 } });
  const second = recordToolCall({ ...call('workflow', 'conv-order'), args: { order: 2 } });
  observeRequestCorrelation({ requestId: 'workflow', conversationId: 'conv-order', sessionId: id!, messageId: 'a', tool: 'read', observedAt: Date.now() });
  await Promise.all([first, second]);
  const rows = await readEvents(id!, { kinds: ['tool_call'] });
  expect(rows.map((event) => event.kind === 'tool_call' && JSON.parse(event.call.args.text).order)).toEqual([1, 2]);
});

it('slow result preparation keeps its session order while another session records independently', async () => {
  const id = await sessionForConversation('conv-prepare');
  await sessionForConversation('conv-independent');
  const reached = gate(); const release = gate();
  const writeFile = fs.writeFile.bind(fs);
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (target, ...args) => {
    if (String(target).includes(`${path.sep}assets${path.sep}`)) { reached.resolve(); await release.promise; }
    return writeFile(target, ...args);
  });
  const first = recordToolCall({ ...call('prepare-first', 'conv-prepare'), args: { order: 1 }, content: [{ type: 'text', text: 'result '.repeat(3_000) }] });
  let second: ReturnType<typeof recordToolCall> | undefined;
  try {
    await reached.promise;
    let secondDone = false;
    second = recordToolCall({ ...call('prepare-second', 'conv-prepare'), args: { order: 2 } });
    void second.then(() => { secondDone = true; });
    expect((await recordToolCall(call('independent', 'conv-independent')))?.conversationId).toBe('conv-independent');
    expect(secondDone).toBe(false);
  } finally { release.resolve(); await first; await second; spy.mockRestore(); }
  const rows = await readEvents(id!, { kinds: ['tool_call'] });
  expect(rows.map((event) => event.kind === 'tool_call' && JSON.parse(event.call.args.text).order)).toEqual([1, 2]);
});

it('exact evidence bypasses a blocked canonical transcript write without inventing a second session', async () => {
  const id = await sessionForConversation('conv-evidence');
  const reached = gate(); const release = gate();
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).includes(`${path.sep}messages${path.sep}`)) { reached.resolve(); await release.promise; }
    return rename(from, to);
  });
  const transcript = recordChatObservations('conv-evidence', [{ kind: 'assistant_message', time: Date.now(), messageId: 'answer', text: 'streaming' }]);
  try {
    await reached.promise;
    expect(await recordRequestEvidence('conv-evidence', [{ kind: 'tool_evidence', time: Date.now(), fiberConversationId: 'conv-evidence', calls: [{ requestId: 'fast-proof', messageId: 'tool', tool: 'read', order: 0, answered: false }] }])).toBe(id);
    expect(requestCorrelation('fast-proof')?.sessionId).toBe(id);
  } finally { release.resolve(); await transcript; spy.mockRestore(); }
});

it('concurrent headerless calls share one initialized unattributed bucket', async () => {
  await Promise.all(Array.from({ length: 8 }, () => recordToolCall(call())));
  const { indexedSessions } = await import('../src/main/session/store.js');
  const buckets = (await indexedSessions()).filter((session) => session.title === 'Unattributed activity');
  expect(buckets).toHaveLength(1);
  expect((await readEvents(buckets[0]!.id, { kinds: ['tool_call'] })).length).toBe(8);
});

it('warm activity polls perform no filesystem work and deliver mutable revisions past the cursor', async () => {
  const session = await createSession({ conversationId: 'conv-feed' });
  const message = { time: 1, source: 'extension' as const, kind: 'user_message' as const, messageId: 'resume', message: { text: '[[CLF-RESUME:abcdefghijklmnop]]\nhello', chars: 38, truncated: false } };
  const original = await upsertMessageEvent(session.id, message);
  const first = await readActivityEvents(session.id, 0);
  expect(first.resumeBoundary).toBe(original.event.seq);
  expect(first.resumeUserMessage?.messageId).toBe(message.messageId);
  const spies = [vi.spyOn(fs, 'open'), vi.spyOn(fs, 'readFile'), vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'rename')];
  expect((await readActivityEvents(session.id, original.event.seq + 1)).events).toEqual([]);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  for (const spy of spies) spy.mockRestore();
  const revised = await upsertMessageEvent(session.id, { ...message, message: { ...message.message, text: message.message.text + ' revised' } });
  const next = await readActivityEvents(session.id, original.event.seq + 1);
  expect(next.events.map((event) => event.seq)).toEqual([revised.event.seq]);
  expect(next.resumeBoundary).toBe(original.event.seq);
  expect(next.openingUserMessage?.messageId).toBe(message.messageId);
  expect(next.resumeUserMessage?.seq).toBe(revised.event.seq);
});

it('reopened activity hydrates once and subsequent polls reuse the bounded committed tail', async () => {
  const session = await createSession({ conversationId: 'conv-reopen' });
  for (let i = 0; i < 5; i++) await appendEvent(session.id, { kind: 'progress', source: 'app', time: i, message: { text: `row-${i}`, chars: 5, truncated: false } });
  const expected = await readRecentEvents(session.id, 1200);
  await flushSessions(); resetSessionStoreForTests();
  expect((await readActivityEvents(session.id, 0)).events).toEqual(expected);
  const spy = vi.spyOn(fs, 'open');
  expect((await readActivityEvents(session.id, 6)).events).toEqual([]);
  expect((await readActivityEvents(session.id, 0)).events).toEqual(expected);
  expect(spy).not.toHaveBeenCalled();
});

it('an old canonical message cannot hide a gap before a byte-bounded cold journal tail', async () => {
  const session = await createSession({ conversationId: 'conv-byte-tail' });
  await upsertMessageEvent(session.id, { time: 1, source: 'extension', kind: 'user_message', messageId: 'old', message: { text: 'old', chars: 3, truncated: false } });
  const text = 'x'.repeat(300_000);
  for (let i = 0; i < 32; i++) await appendEvent(session.id, { kind: 'progress', source: 'app', time: i + 2, message: { text, chars: text.length, truncated: false } });
  await flushSessions(); resetSessionStoreForTests();
  const tail = await readActivityEvents(session.id, 2);
  expect(tail.reset).toBe(true);
  expect(tail.events.some((event) => event.seq === 1)).toBe(true);
  expect(tail.events.some((event) => event.seq === 2)).toBe(false);
  // General explicit history must still fall back to disk instead of trusting that gap.
  expect((await readEvents(session.id, { from: 2, limit: 1 }))[0]?.seq).toBe(2);
});
