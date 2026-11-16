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
  MAX_SESSION_ASSET_BYTES,
  readAsset,
  readEvents,
  recordingStorageFull,
  resetSessionStoreForTests,
  setRecordingStorageLimit,
  upsertMessageEvent,
  writeAsset,
  writeOverflowText
} from '../src/main/session/store.js';
import { recordChatObservations, resetRecorderForTests } from '../src/main/session/recorder.js';
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
  resetRecorderForTests();
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

// #2198: a single chat hitting 192 MB (for example, from long tool outputs) needs per-chat breakdown and cleanup.
it('reports per-chat image vs long-text breakdown without affecting global-only calls', async () => {
  const target = await chatWithLongOutput('target', 1, 'long output '.repeat(100));
  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#113355' } }).png().toBuffer();
  const image = await writeAsset(target.session.id, png, 'image/png');
  const other = await chatWithLongOutput('other', 1, 'other output '.repeat(150));
  const textSize = (await fs.stat(path.join(directory, 'sessions', target.session.id, 'assets', target.asset.id))).size;
  const otherSize = (await fs.stat(path.join(directory, 'sessions', other.session.id, 'assets', other.asset.id))).size;

  const globalOnly = await getImageStorage();
  expect(globalOnly).toEqual({ usedBytes: textSize + image.bytes + otherSize, limitBytes: MAX_GLOBAL_ASSET_BYTES });

  const withSession = await getImageStorage(target.session.id);
  expect(withSession.session).toEqual({
    sessionId: target.session.id,
    usedBytes: textSize + image.bytes,
    limitBytes: MAX_SESSION_ASSET_BYTES,
    imageBytes: image.bytes,
    textBytes: textSize
  });
});

it('frees only images or only long texts from the chosen chat', async () => {
  const target = await chatWithLongOutput('target', 1, 'target long output '.repeat(200));
  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#113355' } }).png().toBuffer();
  const targetImage = await writeAsset(target.session.id, png, 'image/png');
  await upsertMessageEvent(target.session.id, {
    time: Date.now(), source: 'app', kind: 'user_message', messageId: 'target-msg', message: plain('keep my text'), assets: [targetImage]
  });

  const other = await chatWithLongOutput('other', 1, 'other long output '.repeat(200));
  const otherImage = await writeAsset(other.session.id, png, 'image/png');
  await upsertMessageEvent(other.session.id, {
    time: Date.now(), source: 'app', kind: 'user_message', messageId: 'other-msg', message: plain('other chat'), assets: [otherImage]
  });

  const afterImages = await clearImageStorage('session-images', target.session.id);
  expect(afterImages.freedBytes).toBe(targetImage.bytes);
  expect(await readAsset(target.session.id, targetImage.id)).toBeNull();
  expect(await readAsset(target.session.id, target.asset.id)).not.toBeNull();
  expect(await readAsset(other.session.id, otherImage.id)).not.toBeNull();
  expect(afterImages.session?.imageBytes).toBe(0);
  expect(afterImages.session?.textBytes).toBeGreaterThan(0);

  const afterTexts = await clearImageStorage('session-texts', target.session.id);
  expect(afterTexts.freedBytes).toBeGreaterThan(0);
  expect(await readAsset(target.session.id, target.asset.id)).toBeNull();
  expect(await readAsset(other.session.id, other.asset.id)).not.toBeNull();
  expect(afterTexts.session?.usedBytes).toBe(0);
  const tool = (await readEvents(target.session.id)).find(event => event.kind === 'tool_call');
  expect(tool?.kind === 'tool_call' ? tool.call.result.text : null).toContain('removed to free storage');
});

it('never classifies a .txt asset starting with WebP magic bytes as an image during session-images cleanup', async () => {
  const session = await createSession({ conversationId: 'webp-prefix-txt', title: 'WebP prefix text' });
  const tricky = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.from(' tool output line '.repeat(40))]);
  const textAsset = await writeAsset(session.id, tricky, 'text/plain');
  await appendEvent(session.id, {
    time: NOW, source: 'mcp', kind: 'tool_call', call: {
      callId: '00000000-0000-4000-8000-000000000220', tool: 'exec_command', requestId: 'req-webp-txt',
      conversationId: 'webp-prefix-txt', attribution: 'request_id', attributionMethod: 'request_id',
      args: plain('{}'),
      result: { text: `RIFF\n…[${tricky.length - 4} more characters stored in full as ${textAsset.id}]`, truncated: true, chars: tricky.length, assetId: textAsset.id },
      outcome: 'ok', durationMs: 1, summary: { kind: 'run', title: 'Ran tool', tone: 'neutral' }
    }
  });

  const before = await getImageStorage(session.id);
  expect(before.session).toMatchObject({ imageBytes: 0, textBytes: tricky.length });

  const after = await clearImageStorage('session-images', session.id);
  expect(after.removedFiles).toBe(0);
  expect(after.freedBytes).toBe(0);
  expect(await readAsset(session.id, textAsset.id)).toEqual(tricky);

  const clearedTexts = await clearImageStorage('session-texts', session.id);
  expect(clearedTexts.removedFiles).toBe(1);
  expect(clearedTexts.freedBytes).toBe(tricky.length);
  expect(await readAsset(session.id, textAsset.id)).toBeNull();
});

it('handles malformed session IDs, symlinked assets dirs, ENOENT lstat races, and protected .txt records in per-chat flows', async () => {
  await expect(getImageStorage('../bad')).rejects.toThrow('Invalid session id');
  await expect(clearImageStorage('session-images', '../bad')).rejects.toThrow('Invalid session id');
  await expect(clearImageStorage('session-texts', '../bad')).rejects.toThrow('Invalid session id');
  await expect(clearImageStorage('old-chats-gib', '../bad')).rejects.toThrow('Invalid session id');

  const symlinked = await createSession({ conversationId: 'symlink-breakdown', title: 'Symlinked assets' });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-symlink-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'deadbeef.txt'), 'secret outside text');
    const assetsPath = path.join(directory, 'sessions', symlinked.id, 'assets');
    await fs.mkdir(path.dirname(assetsPath), { recursive: true });
    await fs.symlink(outside, assetsPath, process.platform === 'win32' ? 'junction' : 'dir');
    const symInfo = await getImageStorage(symlinked.id);
    expect(symInfo.session).toEqual({
      sessionId: symlinked.id, usedBytes: 0, limitBytes: MAX_SESSION_ASSET_BYTES, imageBytes: 0, textBytes: 0
    });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }

  const protectedChat = await chatWithLongOutput('protected-txt', 1, 'kept output '.repeat(120));
  const extraTxt = await writeAsset(protectedChat.session.id, Buffer.from('disappearing text'), 'text/plain');
  await appendEvent(protectedChat.session.id, {
    time: NOW, source: 'app', kind: 'note',
    message: { text: 'protected ref', truncated: true, chars: 1200, assetId: protectedChat.asset.id }
  });

  const realLstat = fs.lstat.bind(fs);
  const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
    if (String(target).endsWith(extraTxt.id)) {
      throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
    }
    return (realLstat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.lstat>>>)(target, ...rest);
  });
  try {
    const raced = await getImageStorage(protectedChat.session.id);
    expect(raced.session?.textBytes).toBe(protectedChat.asset.bytes);
  } finally {
    lstatSpy.mockRestore();
  }

  const vetoed = await clearImageStorage('session-texts', protectedChat.session.id);
  expect(vetoed.removedFiles).toBe(1); // unreferenced extraTxt removed, protectedChat.asset kept
  expect(await readAsset(protectedChat.session.id, protectedChat.asset.id)).not.toBeNull();

  // Vetoed files stay admissible for subsequent message upserts (not poisoned in removedAssetEpoch).
  const keptUpsert = await upsertMessageEvent(protectedChat.session.id, {
    time: NOW + 1,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'vetoed-kept-msg',
    message: { text: `head\n…[1196 more characters stored in full as ${protectedChat.asset.id}]`, truncated: true, chars: 1200, assetId: protectedChat.asset.id },
    state: 'final',
    final: true
  });
  expect(keptUpsert.event.kind).toBe('assistant_message');
  if (keptUpsert.event.kind === 'assistant_message') {
    expect(keptUpsert.event.message.assetId).toBe(protectedChat.asset.id);
    expect(keptUpsert.event.retiredTextAssetIds).toBeUndefined();
  }
});

it('limits pre-cleanup inspection to the target chat so an unreadable asset elsewhere cannot block session cleanup', async () => {
  const healthy = await createSession({ conversationId: 'healthy-chat-cleanup', title: 'Healthy chat' });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#224466' } }).png().toBuffer();
  const healthyImage = await writeAsset(healthy.id, png, 'image/png');
  await upsertMessageEvent(healthy.id, {
    time: NOW, source: 'app', kind: 'user_message', messageId: 'healthy-msg', message: plain('keep healthy text'), assets: [healthyImage]
  });

  const broken = await createSession({ conversationId: 'unreadable-chat-cleanup', title: 'Unreadable chat' });
  const brokenAsset = await writeAsset(broken.id, png, 'image/png');

  const realOpen = fs.open.bind(fs);
  const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (target, ...rest) => {
    if (String(target).includes(broken.id) && String(target).endsWith(brokenAsset.id)) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return (realOpen as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.open>>>)(target, ...rest);
  });
  try {
    const cleared = await clearImageStorage('session-images', healthy.id);
    expect(cleared).toMatchObject({ removedFiles: 1, freedBytes: png.length });
    expect(await readAsset(healthy.id, healthyImage.id)).toBeNull();
    expect(cleared.session).toEqual({
      sessionId: healthy.id, usedBytes: 0, limitBytes: MAX_SESSION_ASSET_BYTES, imageBytes: 0, textBytes: 0
    });
  } finally {
    openSpy.mockRestore();
  }

  const healthyText = await writeAsset(healthy.id, Buffer.from('healthy long text '.repeat(40)), 'text/plain');
  await upsertMessageEvent(healthy.id, {
    time: NOW, source: 'app', kind: 'user_message', messageId: 'healthy-txt-msg',
    message: { text: 'head\n…[more]', truncated: true, chars: 700, assetId: healthyText.id }
  });
  const warnSpy = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const realOpendir = fs.opendir.bind(fs);
  const opendirSpy = vi.spyOn(fs, 'opendir').mockImplementation(async (target, ...rest) => {
    if (String(target).includes(broken.id)) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return (realOpendir as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.opendir>>>)(target, ...rest);
  });
  try {
    const clearedWithUnreadablePeerDir = await clearImageStorage('session-texts', healthy.id);
    expect(clearedWithUnreadablePeerDir).toMatchObject({
      removedFiles: 1,
      freedBytes: healthyText.bytes,
      usedBytes: null,
      session: { sessionId: healthy.id, usedBytes: 0, limitBytes: MAX_SESSION_ASSET_BYTES, imageBytes: 0, textBytes: 0 }
    });
    expect(await readAsset(healthy.id, healthyText.id)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('global recount failed: permission denied'));
  } finally {
    opendirSpy.mockRestore();
    warnSpy.mockRestore();
  }
});

it('prevents repeated observations from re-spilling retired overflow text assets after session-texts cleanup and restart', async () => {
  const conversationId = 'conv-retired-long-text';
  const session = await createSession({ conversationId, title: 'Retired long texts' });
  const longUserText = 'U'.repeat(260_000);
  const longAssistantText = 'A'.repeat(260_000);
  const longAssistantHtml = `<p>${'H'.repeat(125_000)}</p>`;

  await recordChatObservations(conversationId, [
    { kind: 'user_message', time: NOW + 1, messageId: 'msg-u-long', text: longUserText },
    {
      kind: 'assistant_message',
      time: NOW + 2,
      messageId: 'msg-a-long',
      text: longAssistantText,
      renderedHtml: longAssistantHtml,
      state: 'final',
      final: true
    }
  ]);

  const assetsDir = path.join(directory, 'sessions', session.id, 'assets');
  const beforeFiles = (await fs.readdir(assetsDir)).filter((name) => name.endsWith('.txt'));
  expect(beforeFiles).toHaveLength(3);

  const cleared = await clearImageStorage('session-texts', session.id);
  expect(cleared.removedFiles).toBe(3);
  expect(await fs.readdir(assetsDir)).toEqual([]);

  const replaySame = async () => recordChatObservations(conversationId, [
    { kind: 'user_message', time: NOW + 3, messageId: 'msg-u-long', text: longUserText },
    {
      kind: 'assistant_message',
      time: NOW + 4,
      messageId: 'msg-a-long',
      text: longAssistantText,
      renderedHtml: longAssistantHtml,
      state: 'final',
      final: true
    }
  ]);

  await replaySame();
  expect(await fs.readdir(assetsDir)).toEqual([]);

  // Simulate app restart and replay the exact same page observations: retired texts must stay deleted.
  resetRecorderForTests();
  resetSessionStoreForTests();
  initSessionStore(directory);

  await replaySame();
  expect(await fs.readdir(assetsDir)).toEqual([]);
  const eventsAfterRestart = await readEvents(session.id);
  const userAfter = eventsAfterRestart.find((ev) => ev.kind === 'user_message');
  const assistantAfter = eventsAfterRestart.find((ev) => ev.kind === 'assistant_message');
  expect(userAfter?.kind === 'user_message' ? userAfter.message.assetId : undefined).toBeUndefined();
  expect(assistantAfter?.kind === 'assistant_message' ? assistantAfter.message.assetId : undefined).toBeUndefined();
  expect(assistantAfter?.kind === 'assistant_message' ? assistantAfter.renderedHtml?.assetId : undefined).toBeUndefined();
  expect(userAfter?.kind === 'user_message' ? userAfter.message.text : '').toContain('more characters removed to free storage');
  expect(assistantAfter?.kind === 'assistant_message' ? assistantAfter.message.text : '').toContain('more characters removed to free storage');

  // New edited content on the same message id (different hash) still spills normally.
  await recordChatObservations(conversationId, [
    {
      kind: 'assistant_message',
      time: NOW + 5,
      messageId: 'msg-a-long',
      text: `${longAssistantText} edited`,
      state: 'final',
      final: true
    }
  ]);
  const afterEditFiles = (await fs.readdir(assetsDir)).filter((name) => name.endsWith('.txt'));
  expect(afterEditFiles).toHaveLength(1);
});

it('rejects overflow text references removed between writeOverflowText and new message upsert', async () => {
  const session = await createSession({ conversationId: 'conv-epoch-text-race', title: 'Epoch text race' });
  const overflowBody = 'R'.repeat(260_000);
  const proseAssetId = await writeOverflowText(session.id, overflowBody);
  expect(proseAssetId).toBeTruthy();

  const cleared = await clearImageStorage('session-texts', session.id);
  expect(cleared.removedFiles).toBe(1);

  const upserted = await upsertMessageEvent(session.id, {
    time: NOW + 1,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'msg-raced-before-upsert',
    message: {
      text: `${overflowBody.slice(0, 256_000)}\n…[${overflowBody.length - 256_000} more characters stored in full as ${proseAssetId}]`,
      truncated: true,
      chars: overflowBody.length,
      assetId: proseAssetId!
    },
    state: 'final',
    final: true
  });

  expect(upserted.event.kind).toBe('assistant_message');
  if (upserted.event.kind === 'assistant_message') {
    expect(upserted.event.message.assetId).toBeUndefined();
    expect(upserted.event.message.text).toContain('more characters removed to free storage');
    expect(upserted.event.retiredTextAssetIds).toEqual([proseAssetId]);
  }
});

it('preserves removal epochs for already-deleted assets and clears only retained ones when a later unlink fails', async () => {
  const session = await createSession({ conversationId: 'conv-partial-delete-abort', title: 'Partial delete abort' });
  const bodyA = 'A'.repeat(260_000);
  const bodyB = 'B'.repeat(260_000);
  const assetA = await writeOverflowText(session.id, bodyA);
  const assetB = await writeOverflowText(session.id, bodyB);
  expect(assetA).toBeTruthy();
  expect(assetB).toBeTruthy();

  // Fail fs.rename on the second text file deletion after the first text file is already unlinked.
  const sortedIds = [assetA!, assetB!].sort();
  let deletedFirst = '';
  const realRename = fs.rename.bind(fs);
  const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath, ...rest) => {
    const oldStr = String(oldPath);
    if (oldStr.endsWith(sortedIds[0]!) || oldStr.endsWith(sortedIds[1]!)) {
      if (!deletedFirst) deletedFirst = oldStr.endsWith(sortedIds[0]!) ? sortedIds[0]! : sortedIds[1]!;
      else throw Object.assign(new Error('disk error during second delete'), { code: 'EIO' });
    }
    return (realRename as (...args: unknown[]) => Promise<void>)(oldPath, newPath, ...rest);
  });

  try {
    await expect(clearImageStorage('session-texts', session.id)).rejects.toThrow('disk error during second delete');
  } finally {
    renameSpy.mockRestore();
  }

  const keptSecond = deletedFirst === sortedIds[0] ? sortedIds[1]! : sortedIds[0]!;
  expect(await readAsset(session.id, deletedFirst)).toBeNull();
  expect(await readAsset(session.id, keptSecond)).not.toBeNull();

  // Upserting the already-deleted asset must retire its missing assetId; the retained asset remains admissible.
  const firstUpsert = await upsertMessageEvent(session.id, {
    time: NOW + 2,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'msg-after-abort-a',
    message: { text: `head\n…[10 more characters stored in full as ${deletedFirst}]`, truncated: true, chars: 260_000, assetId: deletedFirst },
    state: 'final',
    final: true
  });
  expect(firstUpsert.event.kind === 'assistant_message' ? firstUpsert.event.message.assetId : undefined).toBeUndefined();

  const secondUpsert = await upsertMessageEvent(session.id, {
    time: NOW + 3,
    source: 'extension',
    kind: 'assistant_message',
    messageId: 'msg-after-abort-b',
    message: { text: `head\n…[10 more characters stored in full as ${keptSecond}]`, truncated: true, chars: 260_000, assetId: keptSecond },
    state: 'final',
    final: true
  });
  expect(secondUpsert.event.kind === 'assistant_message' ? secondUpsert.event.message.assetId : undefined).toBe(keptSecond);
});
