import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createSession, getSession, initSessionStore, readEvents, resetSessionStoreForTests, upsertMessageEvent, writeAsset } from '../src/main/session/store.js';
import { recordDeliveredInput, recordedInputImage } from '../src/main/session/input-history.js';
import type { InputEntry } from '../src/main/session/input.js';
import { chronological } from '../src/shared/chronology.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-input-history-')); initSessionStore(directory); });
afterEach(async () => { resetSessionStoreForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it.each([true, false])('merges a native echo before=%s with the receipt and preserves real image pixels', async (echoFirst) => {
  const session = await createSession({ conversationId: 'conversation-one', title: 'Input history' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff0000' } }).webp({ lossless: true }).toBuffer();
  const entry: InputEntry = { id: '00000000-0000-4000-8000-000000000001', sessionId: session.id, text: 'Inspect this image', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, state: 'sent', owner: 'page', createdAt: 100, conversationId: 'conversation-one', messageId: 'native-user-message', deliveredAt: 200, images: [{ name: 'red.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] };
  const echo = () => upsertMessageEvent(session.id, { time: 190, source: 'extension', kind: 'user_message', messageId: entry.messageId!, message: { text: entry.text, chars: entry.text.length, truncated: false } });
  entry.model = 'gpt-5.6-sol'; entry.reasoningEffort = 'high';
  entry.deliveryText = entry.text + '\n\nTransport-only control instruction';
  if (echoFirst) await echo();
  expect(await recordDeliveredInput(entry)).toBe(true);
  await echo();
  await recordDeliveredInput(entry);
  const messages = (await readEvents(session.id)).filter(event => event.kind === 'user_message');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ authoredText: entry.text, message: { text: entry.deliveryText } });
  expect(messages[0]).toMatchObject({ inputId: entry.id, messageId: entry.messageId, model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  const assetId = messages[0]!.kind === 'user_message' ? messages[0]!.assets![0]!.id : '';
  const data = await recordedInputImage(session.id, assetId);
  expect(data).toBe(entry.images![0]!.dataUrl);
  const pixels = await sharp(Buffer.from(data!.split(',')[1]!, 'base64')).raw().toBuffer({ resolveWithObject: true });
  expect(pixels.info).toMatchObject({ width: 3, height: 2, channels: 3 });
  expect([...pixels.data]).toEqual(Array.from({ length: 6 }, () => [255, 0, 0]).flat());
  expect(await recordedInputImage(other.id, assetId)).toBeNull();
  const unreferenced = await writeAsset(session.id, bytes, 'image/webp');
  // A real asset alone is not sufficient; only a canonical user attachment grants access.
  const stranger = await writeAsset(other.id, bytes, 'image/webp');
  expect(unreferenced.id).toBe(stranger.id);
  expect(await recordedInputImage(other.id, stranger.id)).toBeNull();
});

it('does not publish a queued intent or an unresolved fresh-session receipt', async () => {
  const entry = { sessionId: null, state: 'queued', text: 'intent', images: [] } as unknown as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(false);
  expect(await recordDeliveredInput({ ...entry, state: 'sent', messageId: 'native', deliveredAt: 100 })).toBe(false);
});

it('anchors a tool handout before later prose and confirms the same row without moving or duplicating it', async () => {
  const session = await createSession({ conversationId: 'tool-conversation', title: 'Tool chronology' });
  const offered = { id: 'offered-input', sessionId: session.id, conversationId: 'tool-conversation',
    state: 'tool', owner: 'exact-request', offeredAt: 200, text: 'look inside',
    deliveryText: 'look inside\n\nTransport-only instruction' } as InputEntry;
  expect(await recordDeliveredInput(offered)).toBe(true);
  const first = (await readEvents(session.id)).find(event => event.kind === 'user_message')!;
  expect(first).toMatchObject({ messageId: 'input:offered-input', inputId: offered.id,
    inputDelivery: 'offered', time: 200, authoredText: 'look inside' });
  expect(offered.deliveredAt).toBeUndefined();
  expect(offered.messageId).toBeUndefined();
  await upsertMessageEvent(session.id, { time: 250, source: 'extension', kind: 'assistant_message',
    messageId: 'later-prose', final: false, message: { text: 'Checking inside.', chars: 16, truncated: false } });
  const nextFrom = Math.max(...(await readEvents(session.id)).map(event => event.seq)) + 1;
  await recordDeliveredInput({ ...offered, state: 'sent', messageId: 'input:offered-input', deliveredAt: 300 });
  const incremental = await readEvents(session.id, { from: nextFrom });
  expect(incremental).toHaveLength(1);
  expect(incremental[0]).toMatchObject({ messageId: 'input:offered-input', inputDelivery: 'confirmed',
    origin: first.origin ?? first.seq, time: 200 });
  expect(incremental[0]!.seq).toBeGreaterThanOrEqual(nextFrom);
  // A delayed repeat of the handout must not undo the subsequently proven receipt.
  await recordDeliveredInput(offered);
  const rows = chronological(await readEvents(session.id)).filter(event =>
    event.kind === 'user_message' || event.kind === 'assistant_message');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ kind: 'user_message', time: 200, inputDelivery: 'confirmed',
    origin: first.origin ?? first.seq, authoredText: 'look inside' });
  expect(rows[1]).toMatchObject({ kind: 'assistant_message', messageId: 'later-prose' });
});

it('does not project an unclaimed tool row or mere browser/queued intent into history', async () => {
  const session = await createSession({ title: 'Not offered' });
  const entry = { id: 'unclaimed', sessionId: session.id, text: 'intent', state: 'tool' } as InputEntry;
  expect(await recordDeliveredInput({ ...entry, offeredAt: 100 })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'request' })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'request', offeredAt: 100, state: 'queued' })).toBe(false);
  expect(await recordDeliveredInput({ ...entry, owner: 'page', offeredAt: 100, state: 'browser' })).toBe(false);
  expect((await readEvents(session.id)).filter(event => event.kind === 'user_message')).toEqual([]);
});

it('does not attribute an injected message to the model selected for a future native send', async () => {
  const session = await createSession({ conversationId: 'injected-conversation', title: 'Injection' });
  const entry = { id: 'injected-id', sessionId: session.id, state: 'sent', text: 'Keep working',
    messageId: 'input:injected-id', deliveredAt: 100, model: 'gpt-6-astra', reasoningEffort: 'pro' } as InputEntry;
  expect(await recordDeliveredInput(entry)).toBe(true);
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row?.model).toBeUndefined();
  expect(row?.reasoningEffort).toBeUndefined();
  expect((await getSession(session.id))?.selectedModel).toBeUndefined();
});

it('records only a native receipt in the currently attached conversation as model selection', async () => {
  const session = await createSession({ conversationId: 'native-conversation', title: 'Native' });
  const entry = { id: 'native-id', sessionId: session.id, state: 'sent', text: 'Work',
    messageId: 'native-id', deliveredAt: 100, model: 'gpt-6', reasoningEffort: 'pro',
    conversationId: 'native-conversation' } as InputEntry;
  await recordDeliveredInput(entry);
  expect((await getSession(session.id))?.selectedModel).toMatchObject({ model: 'gpt-6', reasoningEffort: 'pro', observedAt: 100 });
  await recordDeliveredInput({ ...entry, model: 'gpt-5.6-pro', conversationId: 'retired-conversation', deliveredAt: 200 });
  expect((await getSession(session.id))?.selectedModel?.model).toBe('gpt-6');
});
