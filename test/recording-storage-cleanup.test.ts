import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  appendEvent,
  clearImageStorage,
  createSession,
  getImageStorage,
  initSessionStore,
  MAX_GLOBAL_ASSET_BYTES,
  readAsset,
  readEvents,
  recordingStorageFull,
  resetSessionStoreForTests,
  setRecordingStorageLimit,
  upsertMessageEvent,
  writeAsset
} from '../src/main/session/store.js';
import * as logger from '../src/main/logger.js';

// #1406: the store held 2 GiB and could only shed images. Long texts (tool output, long answers)
// filled it just as well, so people with long runs had no way out short of losing everything.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12);
let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-recording-cleanup-'));
  initSessionStore(directory);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const plain = (value: string) => ({ text: value, chars: value.length, truncated: false });

/** What the recorder stores for text past the inline cap: a head, a note, and the full copy's id. */
async function longText(sessionId: string, full: string) {
  const asset = await writeAsset(sessionId, Buffer.from(full), 'text/plain');
  const head = full.slice(0, 10);
  return {
    asset,
    stored: { text: `${head}\n…[${full.length - 10} more characters stored in full as ${asset.id}]`, truncated: true, chars: full.length, assetId: asset.id }
  };
}

async function chatWithLongOutput(title: string, ageDays: number, output: string) {
  vi.setSystemTime(NOW - ageDays * DAY);
  const session = await createSession({ conversationId: `conv-${title}`, title });
  const result = await longText(session.id, output);
  await appendEvent(session.id, {
    time: Date.now(), source: 'mcp', kind: 'tool_call', call: {
      callId: `00000000-0000-4000-8000-${String(ageDays).padStart(12, '0')}`, tool: 'exec_command', requestId: `request-${title}`,
      conversationId: `conv-${title}`, attribution: 'request_id', attributionMethod: 'request_id',
      args: plain('{"cmd":"npm test"}'), result: result.stored, outcome: 'ok', durationMs: 1,
      summary: { kind: 'run', title: 'Ran npm test', tone: 'neutral' }
    }
  });
  vi.setSystemTime(NOW);
  return { session, asset: result.asset };
}

it('frees long texts and images from chats unused for a week, and leaves recent chats whole', async () => {
  const old = await chatWithLongOutput('old', 30, 'old build output '.repeat(200));
  vi.setSystemTime(NOW - 30 * DAY);
  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#113355' } }).png().toBuffer();
  const image = await writeAsset(old.session.id, png, 'image/png');
  const answer = await longText(old.session.id, 'a long answer '.repeat(300));
  await upsertMessageEvent(old.session.id, {
    time: Date.now(), source: 'extension', kind: 'assistant_message', messageId: 'old-answer', final: true, message: answer.stored
  });
  await upsertMessageEvent(old.session.id, {
    time: Date.now(), source: 'app', kind: 'user_message', messageId: 'old-question', message: plain('look at this'), assets: [image]
  });
  vi.setSystemTime(NOW);
  const recent = await chatWithLongOutput('recent', 2, 'recent build output '.repeat(200));

  const result = await clearImageStorage('old-chats-gib');

  expect(result.removedFiles).toBe(3);
  expect(await readAsset(old.session.id, old.asset.id)).toBeNull();
  expect(await readAsset(old.session.id, answer.asset.id)).toBeNull();
  expect(await readAsset(old.session.id, image.id)).toBeNull();
  // A chat used this week keeps everything.
  expect(await readAsset(recent.session.id, recent.asset.id)).not.toBeNull();

  const rows = await readEvents(old.session.id);
  const tool = rows.find(event => event.kind === 'tool_call');
  const said = rows.find(event => event.kind === 'assistant_message');
  const asked = rows.find(event => event.kind === 'user_message');
  // The head stays, and the entry says what happened instead of pointing at a missing file.
  expect(tool?.kind === 'tool_call' ? tool.call.result : null).toEqual({
    text: `old build \n…[${'old build output '.repeat(200).length - 10} more characters removed to free storage]`,
    truncated: true, chars: 'old build output '.repeat(200).length
  });
  expect(said?.kind === 'assistant_message' ? said.message : null).toMatchObject({ truncated: true });
  expect(said?.kind === 'assistant_message' ? said.message.assetId : 'missing').toBeUndefined();
  expect(said?.kind === 'assistant_message' ? said.message.text : '').toMatch(/more characters removed to free storage\]$/);
  expect(asked).toMatchObject({ assets: undefined, retiredImageAssetIds: [image.id] });
});

it('keeps a long text that a record it cannot rewrite still points to', async () => {
  const old = await chatWithLongOutput('noted', 30, 'shared output '.repeat(200));
  // A note has no stable key, so its reference cannot be retired; the file must stay.
  await appendEvent(old.session.id, {
    time: NOW - 30 * DAY, source: 'app', kind: 'note',
    message: { text: 'see output', truncated: true, chars: 3000, assetId: old.asset.id }
  });

  const result = await clearImageStorage('old-chats-gib');

  expect(result.removedFiles).toBe(0);
  expect(await readAsset(old.session.id, old.asset.id)).not.toBeNull();
  const tool = (await readEvents(old.session.id)).find(event => event.kind === 'tool_call');
  expect(tool?.kind === 'tool_call' ? tool.call.result.assetId : null).toBe(old.asset.id);
});

it('takes the oldest chats first and stops once about 1 GB is free', async () => {
  const oldest = await chatWithLongOutput('oldest', 90, 'oldest output '.repeat(200));
  const older = await chatWithLongOutput('older', 60, 'older output '.repeat(200));
  // The oldest chat's text alone covers the 1 GB target. A sparse file takes no real disk space.
  await fs.truncate(path.join(directory, 'sessions', oldest.session.id, 'assets', oldest.asset.id), 2 ** 30);

  await clearImageStorage('old-chats-gib');

  expect(await readAsset(oldest.session.id, oldest.asset.id)).toBeNull();
  expect(await readAsset(older.session.id, older.asset.id)).not.toBeNull();
});

it('uses the chosen storage limit, and a larger one ends a full store at once', async () => {
  const filler = await createSession({ title: 'Old recordings' });
  const current = await createSession({ title: 'Current chat' });
  await writeAsset(filler.id, Buffer.from('an old long text'), 'text/plain');
  resetSessionStoreForTests();
  initSessionStore(directory);
  vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const realStat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (String(file).includes(path.join(filler.id, 'assets') + path.sep)) Object.defineProperty(found, 'size', { value: MAX_GLOBAL_ASSET_BYTES });
    return found;
  });
  await expect(writeAsset(current.id, Buffer.from('refused at 2 GB'), 'text/plain')).rejects.toThrow('Global session asset quota exceeded');
  expect(recordingStorageFull()).toBe(true);

  setRecordingStorageLimit(5);

  expect(recordingStorageFull()).toBe(false);
  expect((await getImageStorage()).limitBytes).toBe(5 * 2 ** 30);
  await writeAsset(current.id, Buffer.from('stored at 5 GB'), 'text/plain');

  // Back to 2 GB with 2 GB already used: full again, without waiting for the next refused write.
  setRecordingStorageLimit(2);
  expect(recordingStorageFull()).toBe(true);
  // Only the offered sizes are accepted.
  expect(() => setRecordingStorageLimit(3)).toThrow();
});
