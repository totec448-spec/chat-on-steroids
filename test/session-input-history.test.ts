import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { appendEvent, createSession, getSession, initSessionStore, observeSessionModel, readEvents, resetSessionStoreForTests, upsertMessageEvent, upsertNativeImageEvent, writeAsset } from '../src/main/session/store.js';
import { recordDeliveredInput, recordedInputImage } from '../src/main/session/input-history.js';
import type { InputEntry } from '../src/main/session/input.js';
import { chronological } from '../src/shared/chronology.js';
import * as store from '../src/main/session/store.js';
import { initDurableStore, readDurable, writeDurableNow, flushDurable } from '../src/main/durable.js';
import { configureInputDelivery, listInputs, resetInputForTests, claimBrowserInput } from '../src/main/session/input.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-input-history-')); initSessionStore(directory); });
afterEach(async () => { vi.restoreAllMocks(); resetInputForTests(); await flushDurable(); resetSessionStoreForTests(); await fs.rm(directory, { recursive: true, force: true }); });

it('commits the image handout before quota failure, retries without decoding again, and enriches its original row', async () => {
  const session = await createSession({ conversationId: 'image-handout', title: 'Image handout' });
  const bytes = await sharp({ create: { width: 7, height: 5, channels: 3, background: '#13579b' } }).webp().toBuffer();
  const image = { name: 'fixture.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` };
  const entry = { id: 'image-handout', sessionId: session.id, state: 'tool', owner: 'request', offeredAt: 200,
    text: 'Inspect pixels', images: [image] } as InputEntry;
  const asset = vi.spyOn(store, 'writeAsset').mockRejectedValue(new Error('Global session asset quota exceeded'));
  const stats = vi.spyOn(sharp.prototype, 'stats');
  const committed = vi.fn();
  await expect(recordDeliveredInput(entry, committed)).rejects.toThrow('quota');
  expect(committed).toHaveBeenCalledTimes(1);
  const first = (await readEvents(session.id)).find(event => event.kind === 'user_message')!;
  expect(first).toMatchObject({ time: 200, inputDelivery: 'offered', inputId: entry.id });
  await appendEvent(session.id, { source: 'app', time: 250, kind: 'note', message: { text: 'Later', chars: 5, truncated: false } });
  const confirmed = { ...entry, state: 'sent' as const, messageId: `input:${entry.id}`, deliveredAt: 300 };
  await expect(recordDeliveredInput(confirmed)).rejects.toThrow('quota');
  await expect(recordDeliveredInput(confirmed)).rejects.toThrow('quota');
  expect(stats).toHaveBeenCalledTimes(1);
  asset.mockRestore();
  await recordDeliveredInput(confirmed);
  const rows = chronological(await readEvents(session.id));
  expect(rows[0]).toMatchObject({ kind: 'user_message', time: 200, origin: first.origin ?? first.seq, inputDelivery: 'confirmed' });
  const message = rows.find(event => event.kind === 'user_message')!;
  expect(message.kind === 'user_message' && message.assets).toHaveLength(1);
});

it('repairs a legacy off-tail image receipt across cold restore while retaining bytes and never reopening delivery', async () => {
  initDurableStore(directory);
  const session = await createSession({ conversationId: 'legacy-images', title: 'Legacy images' });
  const bytes = await sharp({ create: { width: 9, height: 3, channels: 3, background: '#2468ac' } }).webp().toBuffer();
  const row: InputEntry = { id: '10000000-0000-4000-8000-000000000001', sessionId: session.id, text: 'Old image', mode: 'auto',
    model: null, reasoningEffort: null, dueAt: 100, createdAt: 100, state: 'sent', owner: null, conversationId: 'legacy-images',
    messageId: 'input:10000000-0000-4000-8000-000000000001', offeredAt: 200, deliveredAt: 400, historyRecorded: false,
    toolImages: [{ name: 'legacy.webp', dataUrl: `data:image/webp;base64,${bytes.toString('base64')}` }] };
  await upsertMessageEvent(session.id, { kind: 'user_message', source: 'app', time: 200, messageId: row.messageId!, inputId: row.id,
    message: { text: row.text, chars: row.text.length, truncated: false } });
  const first = (await readEvents(session.id)).find(event => event.kind === 'user_message')!;
  for (let i = 0; i < 170; i++) await appendEvent(session.id, { kind: 'note', source: 'app', time: 500 + i,
    message: { text: `later ${i}`, chars: 10, truncated: false } });
  await writeDurableNow('session-input', [row]);
  await flushDurable(); resetSessionStoreForTests(); initSessionStore(directory); resetInputForTests();
  const asset = vi.spyOn(store, 'writeAsset').mockRejectedValue(new Error('Session asset quota exceeded'));
  configureInputDelivery({ recordDelivered: recordDeliveredInput, changed: () => {}, applyAutomation: async () => {} });
  const repaired = (await listInputs())[0]!;
  expect(repaired).toMatchObject({ historyAnchored: true, historyRecorded: false, toolImages: row.toolImages });
  expect((await readDurable<InputEntry[]>('session-input'))![0]).toMatchObject({ historyAnchored: true, historyRecorded: false });
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message')).toMatchObject({ origin: first.origin ?? first.seq, time: 200 });
  expect(await claimBrowserInput(row.id, 'different-page', 'legacy-images')).toBeNull();
  asset.mockRestore();
  expect((await listInputs())[0]).toMatchObject({ historyAnchored: true, historyRecorded: true });
  const message = (await readEvents(session.id)).find(event => event.kind === 'user_message')!;
  expect(message).toMatchObject({ origin: first.origin ?? first.seq, time: 200 });
  expect(message.kind === 'user_message' && await recordedInputImage(session.id, message.assets![0]!.id)).toBe(row.toolImages![0]!.dataUrl);
});

it('uses original handout time when the first canonical publication happens after its receipt', async () => {
  const session = await createSession({ title: 'Late history' });
  await recordDeliveredInput({ id: 'late', sessionId: session.id, state: 'sent', messageId: 'input:late',
    deliveredAt: 300, offeredAt: 100, text: 'Late' } as InputEntry);
  expect((await readEvents(session.id)).find(event => event.kind === 'user_message')).toMatchObject({ time: 100 });
});

it('does not republish an inherited finish task model as a new picker observation', async () => {
  const session = await createSession({ conversationId: 'continued-chat', title: 'Finish inheritance' });
  await observeSessionModel(session.id, 'continued-chat', '5.6', 100, 'xhigh');
  const entry: InputEntry = { id: 'checkpoint', sessionId: session.id, state: 'sent', text: 'Check result', mode: 'finish',
    dueAt: 0, createdAt: 0, owner: 'page', messageId: 'native-checkpoint', deliveredAt: 200,
    model: '6', reasoningEffort: 'pro', conversationId: 'continued-chat' };
  await recordDeliveredInput(entry);
  expect((await getSession(session.id))?.selectedModel).toMatchObject({ model: '5.6', reasoningEffort: 'xhigh', observedAt: 100 });
  const row = (await readEvents(session.id)).find(event => event.kind === 'user_message');
  expect(row?.model).toBeUndefined();
  expect(row?.reasoningEffort).toBeUndefined();
});

it('serves real recorded tool PNG pixels and refuses unreferenced or invalid images', async () => {
  const session = await createSession({ title: 'Tool image' });
  const other = await createSession({ title: 'Other' });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer();
  const asset = await writeAsset(session.id, bytes, 'image/png');
  const broken = await writeAsset(session.id, Buffer.from('not image bytes'), 'image/png');
  const text = { text: '{}', chars: 2, truncated: false };
  await appendEvent(session.id, { time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
    callId: 'tool-image', tool: 'get_viewport_screenshot', requestId: null, conversationId: null,
    attribution: 'unattributed', attributionMethod: 'unattributed', args: text, result: text,
    outcome: 'ok', durationMs: 1, summary: { kind: 'other', title: 'Screenshot', tone: 'neutral' }, assets: [asset, broken]
  } });
  expect(await recordedInputImage(session.id, asset.id)).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  expect(await recordedInputImage(session.id, broken.id)).toBeNull();
  const assetPath = path.join(directory, 'sessions', session.id, 'assets', asset.id);
  await fs.truncate(assetPath, 17 * 1024 * 1024);
  const readFile = vi.spyOn(fs, 'readFile');
  try {
    expect(await recordedInputImage(session.id, asset.id)).toBeNull();
    expect(readFile.mock.calls.some(args => String(args[0]) === assetPath)).toBe(false);
  } finally { readFile.mockRestore(); }
  await writeAsset(other.id, bytes, 'image/png');
  expect(await recordedInputImage(other.id, asset.id)).toBeNull();
});

it('anchors each native generated image before preview enrichment and authorizes only its exact session asset', async () => {
  const session = await createSession({ conversationId: 'generated-images', title: 'Generated images' });
  const other = await createSession({ title: 'Other' });
  const first = await upsertNativeImageEvent(session.id, {
    time: 200, source: 'extension', kind: 'native_image', messageId: '3150f756-bf2d-45fa-ac0f-45010b2239fb',
    providerAssetId: 'file_00000000000000000000000000000001', providerRole: 'tool', providerChannel: 'final',
    providerStatus: 'in_progress', width: 1254, height: 1254, previewStatus: 'pending',
    turnId: 'turn-one', agent: 'worker-a'
  });
  await appendEvent(session.id, { time: 250, source: 'app', kind: 'note', message: { text: 'Later', chars: 5, truncated: false } });
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#123456' } }).webp().toBuffer();
  const asset = await writeAsset(session.id, bytes, 'image/webp');
  const enriched = await upsertNativeImageEvent(session.id, {
    time: 300, source: 'extension', kind: 'native_image', messageId: first.event.messageId,
    providerAssetId: first.event.providerAssetId, providerRole: 'tool', providerChannel: 'final', turnId: 'remounted-turn',
    providerStatus: 'finished_successfully', width: 1254, height: 1254, agent: 'worker-a',
    previewStatus: 'available', previewWidth: 12, previewHeight: 8, asset
  });
  await upsertNativeImageEvent(session.id, {
    time: 210, source: 'extension', kind: 'native_image', messageId: first.event.messageId,
    providerAssetId: 'file_00000000000000000000000000000002', providerRole: 'tool', providerChannel: 'final',
    width: 1024, height: 768, previewStatus: 'unavailable', previewError: 'not_loaded'
  });
  // A later document-local turn hint cannot move an exact provider tuple; the canonical
  // owner stays put while the same image is still allowed to finish preview enrichment.
  const { seq: _seq, origin: _origin, ...enrichedInput } = enriched.event;
  const conflict = await upsertNativeImageEvent(session.id, { ...enrichedInput, time: 400, turnId: 'turn-two' });
  const agentConflict = await upsertNativeImageEvent(session.id, { ...enrichedInput, time: 401, agent: 'worker-b' });

  const rows = (await readEvents(session.id)).filter(event => event.kind === 'native_image');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ origin: first.event.origin ?? first.event.seq, time: 200, turnId: 'turn-one',
    providerStatus: 'finished_successfully', previewStatus: 'available', asset });
  expect(rows[1]).toMatchObject({ providerAssetId: 'file_00000000000000000000000000000002', previewStatus: 'unavailable' });
  expect(conflict.changed).toBe(false);
  expect(agentConflict.changed).toBe(false);
  await flushDurable(); resetSessionStoreForTests(); initSessionStore(directory);
  const restored = (await readEvents(session.id)).filter(event => event.kind === 'native_image');
  expect(restored).toHaveLength(2);
  expect(restored[0]).toMatchObject({ origin: first.event.origin ?? first.event.seq, previewStatus: 'available', asset });
  expect(await recordedInputImage(session.id, asset.id)).toBe(`data:image/webp;base64,${bytes.toString('base64')}`);
  expect(await recordedInputImage(other.id, asset.id)).toBeNull();
});

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
