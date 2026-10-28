import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { observeRequestCorrelation, requestCorrelation } from '../src/main/session/correlation.js';
import { recordToolCall, recordChatObservations, recordRequestEvidence, sessionForConversation, flushRecorder, resetRecorderForTests } from '../src/main/session/recorder.js';
import { NEW_CHAT, noteAutomaticReply, resetAutomaticRepliesForTests } from '../src/main/session/automatic-replies.js';
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

it('commits a newly proved owner to disk before request evidence is acknowledged', async () => {
  const id = await sessionForConversation('conv-committed');
  const ledger = path.join(dir, 'state', 'request-correlations.json');
  const evidence = (requestId: string) => [{ kind: 'tool_evidence' as const, time: Date.now(), fiberConversationId: 'conv-committed', calls: [{ requestId, messageId: 'tool', tool: 'read', order: 0, answered: false }] }];
  expect(await recordRequestEvidence('conv-committed', evidence('committed-proof'))).toBe(id);
  // No flush: the ordinary snapshot is debounced, so only the acknowledgement barrier can have written this.
  const saved = JSON.parse(await fs.readFile(ledger, 'utf8'));
  expect(saved).toMatchObject({ version: 6, complete: true });
  expect(saved.entries.map((entry: { requestId: string }) => entry.requestId)).toEqual(['committed-proof']);
  // Re-proving a known owner adds nothing, so it does not rewrite the ledger.
  const write = vi.spyOn(fs, 'rename');
  expect(await recordRequestEvidence('conv-committed', evidence('committed-proof'))).toBe(id);
  expect(write).not.toHaveBeenCalled();
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

// Prompt recall (#1655): a Goal or Loop follow-up is typed by its page, so it reaches ChatGPT with no
// outbox row and came back from Up as if the person had typed it (Mac release round, 2026-10-19).
it('marks the message a Goal or Loop follow-up came back as, and only that one', async () => {
  resetAutomaticRepliesForTests();
  const id = await sessionForConversation('conv-auto');
  const at = Date.now();
  const user = (messageId: string, text: string, time: number) => ({ kind: 'user_message' as const, time, messageId, text });
  noteAutomaticReply('conv-auto', 'continue with `step two` and *check* it', at);
  noteAutomaticReply('conv-other', 'typed by a person here', at);
  await recordChatObservations('conv-auto', [
    user('q-1', 'typed by a person here', at + 1),
    // ChatGPT stores text the page inserted with Markdown escaped.
    user('q-2', 'continue with \\`step two\\` and \\*check\\* it', at + 2)
  ]);
  // A re-observation without the mark keeps it, and the same text later is the person's.
  await recordChatObservations('conv-auto', [user('q-2', 'continue with \\`step two\\` and \\*check\\* it', at + 2),
    user('q-3', 'continue with `step two` and *check* it', at + 3)]);
  await flushRecorder();
  const latest = new Map((await readEvents(id!, { kinds: ['user_message'] })).map(event => [event.kind === 'user_message' ? event.messageId : '', event]));
  const automatic = (messageId: string) => { const event = latest.get(messageId); return event?.kind === 'user_message' ? event.automatic : 'missing'; };
  expect(automatic('q-1')).toBeUndefined();
  expect(automatic('q-2')).toBe(true);
  expect(automatic('q-3')).toBeUndefined();
});

// A Goal started from the ChatGPT page's own new-chat sheet: the page types the drafted opening
// message into a chat that has no id yet, so it is noted for whichever new chat it arrives in.
it('marks a Goal opening message the ChatGPT page typed into a new chat', async () => {
  resetAutomaticRepliesForTests();
  const id = await sessionForConversation('conv-opening');
  const at = Date.now();
  noteAutomaticReply(NEW_CHAT, 'start by listing the open issues', at);
  await recordChatObservations('conv-opening', [{ kind: 'user_message' as const, time: at + 1, messageId: 'q-open', text: 'start by listing the open issues' }]);
  await recordChatObservations('conv-opening-2', [{ kind: 'user_message' as const, time: at + 2, messageId: 'q-again', text: 'start by listing the open issues' }]);
  await flushRecorder();
  const opened = (await readEvents(id!, { kinds: ['user_message'] })).at(-1);
  expect(opened?.kind === 'user_message' && opened.automatic).toBe(true);
  const other = (await readEvents((await sessionForConversation('conv-opening-2'))!, { kinds: ['user_message'] })).at(-1);
  expect(other?.kind === 'user_message' && other.automatic).toBeFalsy();
});

// Edit & resubmit (#365): ChatGPT keeps an edited question as a new version beside the old one,
// under the same parent. Recorded linearly, the edit read as one more question at the end.
it('records an edited question as replacing the version it was made from', async () => {
  const id = await sessionForConversation('conv-edit');
  const at = Date.now();
  const user = (messageId: string, text: string, parentId: string, parentExact: boolean, time: number) =>
    ({ kind: 'user_message' as const, time, messageId, text, parentId, parentExact });
  await recordChatObservations('conv-edit', [
    user('q-1', 'First question', 'root', false, at),
    { kind: 'assistant_message', time: at + 1, messageId: 'a-1', text: 'First answer', final: true, state: 'final' } as any,
    user('q-2', 'Second question', 'a-1', false, at + 2),
    { kind: 'assistant_message', time: at + 3, messageId: 'a-2', text: 'Second answer', final: true, state: 'final' } as any
  ]);
  // The page shows the edit before ChatGPT draws its versions control, then again with it.
  await recordChatObservations('conv-edit', [user('q-2b', 'Second question, edited', 'a-1', false, at + 4)]);
  await recordChatObservations('conv-edit', [user('q-2b', 'Second question, edited', 'a-1', true, at + 4)]);
  // An edit of that edit replaces the newest version, not the first one.
  await recordChatObservations('conv-edit', [user('q-2c', 'Second question, edited twice', 'a-1', true, at + 6)]);
  // The first question edited: it sits at the chat's root.
  await recordChatObservations('conv-edit', [user('q-1b', 'First question, edited', 'root', true, at + 8)]);
  await flushRecorder();
  const questions = await readEvents(id!, { kinds: ['user_message'] });
  const latest = new Map(questions.map(event => [event.kind === 'user_message' ? event.messageId : '', event]));
  const replaces = (messageId: string) => { const event = latest.get(messageId); return event?.kind === 'user_message' ? event.replaces : 'missing'; };
  expect(replaces('q-1')).toBeUndefined();
  expect(replaces('q-2')).toBeUndefined();
  expect(replaces('q-2b')).toBe('q-2');
  expect(replaces('q-2c')).toBe('q-2b');
  expect(replaces('q-1b')).toBe('q-1');
});

it('keeps an edit replacing the question it was made from when ChatGPT re-reports the older version', async () => {
  const id = await sessionForConversation('conv-edit-flip');
  const at = Date.now();
  const user = (messageId: string, text: string, time: number) =>
    ({ kind: 'user_message' as const, time, messageId, text, parentId: 'a-1', parentExact: true });
  await recordChatObservations('conv-edit-flip', [
    { kind: 'user_message', time: at, messageId: 'q-1', text: 'First question', parentId: 'root', parentExact: false },
    { kind: 'assistant_message', time: at + 1, messageId: 'a-1', text: 'First answer', final: true, state: 'final' } as any,
    user('q-2', 'Second question', at + 2),
    user('q-2b', 'Second question, edited', at + 4)
  ]);
  // The user flips the versions control back to 1/2 (or reloads on it): the older version is reported again.
  await recordChatObservations('conv-edit-flip', [user('q-2', 'Second question', at + 2)]);
  await flushRecorder();
  const latest = async () => new Map((await readEvents(id!, { kinds: ['user_message'] }))
    .map(event => [event.kind === 'user_message' ? event.messageId : '', event.kind === 'user_message' ? event.replaces : undefined]));
  expect((await latest()).get('q-2')).toBeUndefined();
  expect((await latest()).get('q-2b')).toBe('q-2');
  // A genuinely new edit after the flip still replaces the newest version, not the one re-reported.
  await recordChatObservations('conv-edit-flip', [user('q-2c', 'Second question, edited twice', at + 6)]);
  await flushRecorder();
  expect((await latest()).get('q-2c')).toBe('q-2b');
  expect((await latest()).get('q-2')).toBeUndefined();
});

it('never takes a question with the same parent for an edit without ChatGPT\'s versions proof', async () => {
  const id = await sessionForConversation('conv-noedit');
  const at = Date.now();
  await recordChatObservations('conv-noedit', [
    { kind: 'user_message', time: at, messageId: 'q-1', text: 'One', parentId: 'root', parentExact: false },
    { kind: 'user_message', time: at + 1, messageId: 'q-2', text: 'Two', parentId: 'root', parentExact: false }
  ]);
  await flushRecorder();
  const questions = await readEvents(id!, { kinds: ['user_message'] });
  expect(questions.every(event => event.kind === 'user_message' && event.replaces === undefined)).toBe(true);
});

it('stores a recorded screenshot as lossless WebP when that saves space, with exactly the same pixels, and keeps a tiny PNG as it is', async () => {
  const sharp = (await import('sharp')).default;
  const id = await sessionForConversation('conv-webp-screenshot');
  // A screenshot-like picture: flat panels, text-like stripes and a gradient, as a PNG.
  // With a transparent corner whose hidden colors are not black, and a Display P3 profile, as macOS screenshots have:
  // a lossless conversion that dropped either would show different colors.
  const width = 480, height = 300, raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4, panel = x < 120 ? 32 : 245, stripe = y % 18 < 3 && x > 140 && x < 440 ? 60 : panel;
    raw[at] = stripe; raw[at + 1] = y < 40 ? Math.floor(x / 2) : stripe; raw[at + 2] = stripe;
    raw[at + 3] = x < 20 && y < 20 ? 0 : 255;
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).withIccProfile('p3').png().toBuffer();
  expect((await sharp(png).metadata()).icc).toBeDefined();
  await recordToolCall({ ...call('webp-shot', 'conv-webp-screenshot'), tool: 'screenshot',
    content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] });
  const event = (await readEvents(id!, { kinds: ['tool_call'] }))[0]!;
  if (event.kind !== 'tool_call') throw new Error('missing recorded call');
  const asset = event.call.assets![0]!;
  expect(asset.mimeType).toBe('image/webp');
  const stored = (await readAsset(id!, asset.id))!;
  expect(stored.length).toBeLessThan(png.length);
  expect(asset.bytes).toBe(stored.length);
  const pixels = async (data: Buffer) => sharp(data).ensureAlpha().raw().toBuffer();
  expect((await pixels(stored)).equals(await pixels(png))).toBe(true);
  expect((await sharp(stored).metadata()).icc).toEqual((await sharp(png).metadata()).icc);
  // A tiny image saves nothing worth a conversion: kept byte for byte.
  const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
  await recordToolCall({ ...call('webp-tiny', 'conv-webp-screenshot'), tool: 'screenshot', content: [{ type: 'image', data: tiny, mimeType: 'image/png' }] });
  const second = (await readEvents(id!, { kinds: ['tool_call'] }))[1]!;
  if (second.kind !== 'tool_call') throw new Error('missing recorded call');
  expect(second.call.assets![0]!.mimeType).toBe('image/png');
  expect(await readAsset(id!, second.call.assets![0]!.id)).toEqual(Buffer.from(tiny, 'base64'));
});

it('keeps a 16-bit PNG as it came, since WebP holds 8 bits a channel, and logs why a screenshot stayed PNG (CodeRabbit)', async () => {
  const sharp = (await import('sharp')).default;
  const { onLog } = await import('../src/main/logger.js');
  const lines: string[] = [];
  const stop = onLog(entry => { lines.push(entry.message); });
  try {
    const id = await sessionForConversation('conv-webp-16bit');
    const width = 400, height = 240, raw = Buffer.alloc(width * height * 3);
    for (let at = 0; at < raw.length; at += 3) { const x = (at / 3) % width; raw[at] = x < 200 ? 30 : 230; raw[at + 1] = 120; raw[at + 2] = x % 40 < 3 ? 0 : 200; }
    const deep = await sharp(raw, { raw: { width, height, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
    expect((await sharp(deep).metadata()).depth).toBe('ushort');
    await recordToolCall({ ...call('webp-16bit', 'conv-webp-16bit'), tool: 'screenshot', content: [{ type: 'image', data: deep.toString('base64'), mimeType: 'image/png' }] });
    const event = (await readEvents(id!, { kinds: ['tool_call'] }))[0]!;
    if (event.kind !== 'tool_call') throw new Error('missing recorded call');
    expect(event.call.assets![0]!.mimeType).toBe('image/png');
    expect(await readAsset(id!, event.call.assets![0]!.id)).toEqual(deep);
    expect(lines.some(line => line.includes('kept a screenshot as PNG') && line.includes('16-bit'))).toBe(true);
  } finally { stop(); }
});
