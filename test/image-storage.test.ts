import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  appendEvent,
  clearImageStorage,
  createSession,
  deleteSession,
  getImageStorage,
  initSessionStore,
  MAX_GLOBAL_ASSET_BYTES,
  MAX_SESSION_ASSET_BYTES,
  onRecordingStorageFullChange,
  readAsset,
  readEvents,
  recordingStorageFull,
  resetSessionStoreForTests,
  setRecordingStorageLimit,
  upsertMessageEvent,
  upsertNativeImageEvent,
  writeAsset,
  writeOverflowText
} from '../src/main/session/store.js';
import * as logger from '../src/main/logger.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-image-storage-'));
  initSessionStore(directory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionStoreForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

const text = (value: string) => ({ text: value, chars: value.length, truncated: false });

it('reads cold usage without opening asset contents and reuses the maintained quota after writes', async () => {
  const session = await createSession({ title: 'Usage accounting' });
  const bytes = Buffer.from('stored asset');
  await writeAsset(session.id, bytes, 'text/plain');
  resetSessionStoreForTests();
  initSessionStore(directory);
  const openFile = vi.spyOn(fs, 'open');
  expect(await getImageStorage()).toEqual({ usedBytes: bytes.length, limitBytes: MAX_GLOBAL_ASSET_BYTES });
  expect(openFile).not.toHaveBeenCalled();
  const scan = vi.spyOn(fs, 'opendir');
  expect((await getImageStorage()).usedBytes).toBe(bytes.length);
  expect(scan).not.toHaveBeenCalled();
  await writeAsset(session.id, Buffer.from('another asset'), 'text/plain');
  expect((await getImageStorage()).usedBytes).toBe(bytes.length + Buffer.byteLength('another asset'));
  expect(scan).not.toHaveBeenCalled();
});

it('clears only persisted images after retiring every durable reference and never reacquires an exact removed native image', async () => {
  const session = await createSession({ conversationId: 'image-storage', title: 'Image storage' });
  const png = await sharp({ create: { width: 5, height: 4, channels: 3, background: '#113355' } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 6, height: 3, channels: 3, background: '#775533' } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 7, height: 2, channels: 3, background: '#337755' } }).webp().toBuffer();
  const [userImage, toolImage, nativeImage] = await Promise.all([
    writeAsset(session.id, png, 'image/png'),
    writeAsset(session.id, jpeg, 'image/jpeg'),
    writeAsset(session.id, webp, 'image/webp')
  ]);
  const overflow = await writeAsset(session.id, Buffer.from('preserve exact text'), 'text/plain');
  const binary = await writeAsset(session.id, Buffer.from([1, 2, 3, 4, 5]), 'application/octet-stream');

  await upsertMessageEvent(session.id, {
    time: 100, source: 'app', kind: 'user_message', messageId: 'input:image-storage',
    message: text('Keep the transcript'), assets: [userImage]
  });
  await appendEvent(session.id, {
    time: 110, source: 'mcp', kind: 'tool_call', call: {
      callId: 'image-tool-call', tool: 'view_image', requestId: 'image-storage-request',
      conversationId: 'image-storage', attribution: 'request_id', attributionMethod: 'request_id',
      args: text('{}'), result: { ...text(''), assetId: overflow.id }, outcome: 'ok', durationMs: 1,
      summary: { kind: 'read', title: 'Viewed image', tone: 'neutral' }, assets: [toolImage]
    }
  });
  const native = await upsertNativeImageEvent(session.id, {
    time: 120, source: 'extension', kind: 'native_image', messageId: 'native-image-message',
    providerAssetId: 'file_00000000000000000000000000000001', providerRole: 'tool',
    providerChannel: 'final', providerStatus: 'finished_successfully', width: 1254, height: 1254,
    previewWidth: 7, previewHeight: 2, previewStatus: 'available', asset: nativeImage
  });

  const before = await getImageStorage();
  expect(before).toEqual({
    usedBytes: png.length + jpeg.length + webp.length + Buffer.byteLength('preserve exact text') + 5,
    limitBytes: MAX_GLOBAL_ASSET_BYTES
  });
  const cleared = await clearImageStorage('all');
  expect(cleared).toEqual({
    freedBytes: png.length + jpeg.length + webp.length,
    removedFiles: 3,
    usedBytes: Buffer.byteLength('preserve exact text') + 5,
    limitBytes: MAX_GLOBAL_ASSET_BYTES
  });
  expect(await readAsset(session.id, overflow.id)).toEqual(Buffer.from('preserve exact text'));
  expect(await readAsset(session.id, binary.id)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  expect(await readAsset(session.id, userImage.id)).toBeNull();

  const rows = await readEvents(session.id);
  const user = rows.find((event) => event.kind === 'user_message');
  const tool = rows.find((event) => event.kind === 'tool_call');
  const generated = rows.find((event) => event.kind === 'native_image');
  expect(user).toMatchObject({ assets: undefined, retiredImageAssetIds: [userImage.id] });
  expect(tool?.kind === 'tool_call' ? tool.call : null).toMatchObject({
    assets: undefined, retiredImageAssetIds: [toolImage.id], result: { assetId: overflow.id }
  });
  expect(generated).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
  expect(generated?.kind === 'native_image' ? generated.asset : null).toBeUndefined();

  const { seq: _seq, origin: _origin, ...nativeReplay } = native.event;
  const replay = await upsertNativeImageEvent(session.id, {
    ...nativeReplay, asset: nativeImage, previewStatus: 'available', previewError: undefined
  });
  expect(replay).toMatchObject({ changed: false, accepted: false });
  await upsertMessageEvent(session.id, {
    time: 130, source: 'app', kind: 'user_message', messageId: 'input:image-storage',
    message: text('Keep the transcript'), assets: [userImage]
  });
  expect((await readEvents(session.id)).find((event) => event.kind === 'user_message')).toMatchObject({
    assets: undefined, retiredImageAssetIds: [userImage.id]
  });

  resetSessionStoreForTests();
  initSessionStore(directory);
  const restored = (await readEvents(session.id)).find((event) => event.kind === 'native_image');
  expect(restored).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
  expect(restored?.kind === 'native_image' ? restored.asset : null).toBeUndefined();
});

it('preserves a local quota failure across weaker page observations until a preview is actually stored', async () => {
  const session = await createSession({ conversationId: 'quota-precedence', title: 'Quota precedence' });
  const identity = {
    time: 200, source: 'extension' as const, kind: 'native_image' as const,
    messageId: 'quota-image-message', providerAssetId: 'file_00000000000000000000000000000002',
    providerRole: 'tool' as const, providerStatus: 'finished_successfully' as const
  };
  await upsertNativeImageEvent(session.id, {
    ...identity, previewStatus: 'unavailable', previewError: 'quota'
  });
  const replay = await upsertNativeImageEvent(session.id, {
    ...identity, time: 201, previewStatus: 'unavailable', previewError: 'not_loaded'
  });
  expect(replay.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'quota' });

  const pixels = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#224466' } }).webp().toBuffer();
  const asset = await writeAsset(session.id, pixels, 'image/webp');
  const available = await upsertNativeImageEvent(session.id, {
    ...identity, time: 202, previewStatus: 'available', previewWidth: 3, previewHeight: 2, asset
  });
  expect(available.event).toMatchObject({ previewStatus: 'available', asset });
  expect(available.event.previewError).toBeUndefined();
});

it('fences a pre-cleanup asset reference even when its canonical publication lands after cleanup', async () => {
  const session = await createSession({ conversationId: 'cleanup-race', title: 'Cleanup race' });
  const pixels = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#662244' } }).png().toBuffer();
  const write = writeAsset(session.id, pixels, 'image/png');
  const cleanup = clearImageStorage('all');
  const asset = await write;
  const result = await cleanup;
  expect(result).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });

  await upsertMessageEvent(session.id, {
    time: 300, source: 'app', kind: 'user_message', messageId: 'input:late-image-reference',
    message: text('Late publication'), assets: [asset]
  });
  const row = (await readEvents(session.id)).find((event) => event.kind === 'user_message');
  expect(row).toMatchObject({ assets: undefined, retiredImageAssetIds: [asset.id] });
  expect(await readAsset(session.id, asset.id)).toBeNull();
});

it('does not traverse or delete an assets directory symlink', async () => {
  const session = await createSession({ conversationId: 'linked-assets', title: 'Linked assets' });
  const outside = path.join(directory, 'outside-images');
  await fs.mkdir(outside);
  const pixels = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#335577' } }).png().toBuffer();
  const outsideFile = path.join(outside, '0123456789abcdef0123456789abcdef.png');
  await fs.writeFile(outsideFile, pixels);
  await fs.symlink(outside, path.join(directory, 'sessions', session.id, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');

  expect(await getImageStorage()).toEqual({ usedBytes: 0, limitBytes: MAX_GLOBAL_ASSET_BYTES });
  expect(await clearImageStorage('all')).toEqual({
    freedBytes: 0, removedFiles: 0, usedBytes: 0, limitBytes: MAX_GLOBAL_ASSET_BYTES
  });
  expect(await fs.readFile(outsideFile)).toEqual(pixels);
});

// #1406: a full store used to be visible only as one log warning per refused write (thousands in a
// long run), while recordings silently became incomplete.
it('reports a full recording store once, and clears the report when space is free again', async () => {
  const filler = await createSession({ title: 'Old recordings' });
  const current = await createSession({ title: 'Current chat' });
  await writeAsset(filler.id, Buffer.from('an old long text'), 'text/plain');
  resetSessionStoreForTests();
  initSessionStore(directory);
  const changes: boolean[] = [];
  const stop = onRecordingStorageFullChange(() => changes.push(recordingStorageFull()));
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  // The old chat's files fill the store. Real sizes would need 2 GiB on disk.
  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (String(file).includes(path.join(filler.id, 'assets') + path.sep)) Object.defineProperty(found, 'size', { value: MAX_GLOBAL_ASSET_BYTES });
    return found;
  });
  expect(recordingStorageFull()).toBe(false);
  await expect(writeAsset(current.id, Buffer.from('first refused'), 'text/plain')).rejects.toThrow('Global session asset quota exceeded');
  await expect(writeAsset(current.id, Buffer.from('second refused'), 'text/plain')).rejects.toThrow('Global session asset quota exceeded');
  expect(recordingStorageFull()).toBe(true);
  expect(changes).toEqual([true]);
  expect(warned.mock.calls.filter(([line]) => /recording storage is full/i.test(String(line)))).toHaveLength(1);

  // Space is free again (here: the sizes are real again, as after a clean-up).
  stat.mockRestore();
  await clearImageStorage('all');
  expect(recordingStorageFull()).toBe(false);
  expect(changes).toEqual([true, false]);
  await writeAsset(current.id, Buffer.from('stored again'), 'text/plain');
  expect(changes).toEqual([true, false]);
  stop();
});

it('preserves a per-session quota failure across weaker observations and logs the configured storage limit', async () => {
  const session = await createSession({ conversationId: 'session-quota-precedence', title: 'Session quota' });
  const identity = {
    time: 200, source: 'extension' as const, kind: 'native_image' as const,
    messageId: 'session-quota-message', providerAssetId: 'file_00000000000000000000000000000003',
    providerRole: 'tool' as const, providerStatus: 'finished_successfully' as const
  };
  await upsertNativeImageEvent(session.id, {
    ...identity, previewStatus: 'unavailable', previewError: 'session_quota'
  });
  const replay = await upsertNativeImageEvent(session.id, {
    ...identity, time: 201, previewStatus: 'unavailable', previewError: 'not_loaded'
  });
  expect(replay.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'session_quota' });

  const switchedToGlobal = await upsertNativeImageEvent(session.id, {
    ...identity, time: 202, previewStatus: 'unavailable', previewError: 'quota'
  });
  expect(switchedToGlobal.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'quota' });

  const switchedToSession = await upsertNativeImageEvent(session.id, {
    ...identity, time: 203, previewStatus: 'unavailable', previewError: 'session_quota'
  });
  expect(switchedToSession.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'session_quota' });

  const filler = await createSession({ title: 'Configured limit filler' });
  await writeAsset(filler.id, Buffer.from('seed asset'), 'text/plain');
  resetSessionStoreForTests();
  initSessionStore(directory);
  setRecordingStorageLimit(5);
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (String(file).includes(path.join(filler.id, 'assets') + path.sep)) Object.defineProperty(found, 'size', { value: 5 * 1024 * 1024 * 1024 });
    return found;
  });
  try {
    await expect(writeAsset(session.id, Buffer.from('refused at 5 GiB'), 'text/plain')).rejects.toThrow('Global session asset quota exceeded');
  } finally {
    stat.mockRestore();
  }
  expect(warned).toHaveBeenCalledWith(expect.stringContaining('recording storage is full (5 GiB)'));
});

it('marks a cleaned-up retry after session_quota as removed so later replays do not resurrect it', async () => {
  const session = await createSession({ conversationId: 'quota-cleanup-removed', title: 'Quota cleanup removed' });
  const identity = {
    time: 200, source: 'extension' as const, kind: 'native_image' as const,
    messageId: 'quota-cleanup-message', providerAssetId: 'file_00000000000000000000000000000004',
    providerRole: 'tool' as const, providerStatus: 'finished_successfully' as const
  };
  await upsertNativeImageEvent(session.id, {
    ...identity, previewStatus: 'unavailable', previewError: 'session_quota'
  });

  const pixels = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#446622' } }).webp().toBuffer();
  const write = writeAsset(session.id, pixels, 'image/webp');
  const cleanup = clearImageStorage('all');
  const staleRetryAsset = await write;
  const cleanupResult = await cleanup;
  expect(cleanupResult).toMatchObject({ removedFiles: 1, freedBytes: pixels.length });

  const afterCleanup = await upsertNativeImageEvent(session.id, {
    ...identity, time: 201, previewStatus: 'available', previewWidth: 3, previewHeight: 2, asset: staleRetryAsset
  });
  expect(afterCleanup.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
  expect(afterCleanup.event.asset).toBeUndefined();

  const replacement = await writeAsset(session.id, pixels, 'image/webp');
  const laterReplay = await upsertNativeImageEvent(session.id, {
    ...identity, time: 202, previewStatus: 'available', previewWidth: 3, previewHeight: 2, asset: replacement
  });
  expect(laterReplay.accepted).toBe(false);
  expect(laterReplay.event).toMatchObject({ previewStatus: 'unavailable', previewError: 'removed' });
});

it('warns once per full session, preserving omitted overflow and independent sessions', async () => {
  const first = await createSession({ title: 'Long first chat' });
  const second = await createSession({ title: 'Long second chat' });
  const a = await writeAsset(first.id, Buffer.from('filler A'), 'text/plain');
  const b = await writeAsset(second.id, Buffer.from('filler B'), 'text/plain');
  resetSessionStoreForTests(); initSessionStore(directory);
  const realStat = fs.stat.bind(fs);
  const quotaFiles = new Set([
    path.join(directory, 'sessions', first.id, 'assets', a.id),
    path.join(directory, 'sessions', second.id, 'assets', b.id)
  ]);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (quotaFiles.has(String(file))) Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES });
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  expect(await writeOverflowText(first.id, 'one')).toBeNull();
  expect(await writeOverflowText(first.id, 'two')).toBeNull();
  expect(await writeOverflowText(first.id, 'three')).toBeNull();
  expect(await writeOverflowText(second.id, 'four')).toBeNull();
  expect(await writeOverflowText(second.id, 'five')).toBeNull();
  const perSessionWarnings = warned.mock.calls.filter(([line]) => String(line).includes('overflow text not stored: Session asset quota exceeded'));
  expect(perSessionWarnings).toHaveLength(2);
  expect(perSessionWarnings.filter(([line]) => String(line).includes(first.id))).toHaveLength(1);
  expect(perSessionWarnings.filter(([line]) => String(line).includes(second.id))).toHaveLength(1);
  stat.mockRestore();
});

it('re-arms a session quota warning only after a successful write', async () => {
  const session = await createSession({ title: 'Recovered quota interval' });
  const filler = await writeAsset(session.id, Buffer.from('seed'), 'text/plain');
  resetSessionStoreForTests();
  initSessionStore(directory);

  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (String(file) === path.join(directory, 'sessions', session.id, 'assets', filler.id)) {
      Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES - 20 });
    }
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);

  expect(await writeOverflowText(session.id, 'overflow exceeds the remaining capacity')).toBeNull();
  expect(await writeOverflowText(session.id, 'another overflow exceeds capacity')).toBeNull();
  expect(warned.mock.calls.filter(([line]) => String(line).includes('Session asset quota exceeded'))).toHaveLength(1);

  // A genuinely small, new asset can still be stored; that write starts a new quota interval.
  expect(await writeOverflowText(session.id, 'ok')).toMatch(/\.txt$/);
  expect(await writeOverflowText(session.id, 'overflow exceeds capacity after recovery')).toBeNull();
  expect(warned.mock.calls.filter(([line]) => String(line).includes('Session asset quota exceeded'))).toHaveLength(2);
  stat.mockRestore();
});

it('warns again after successful write and fresh inventory when a cleared session refills', async () => {
  const session = await createSession({ title: 'Clear and refill recording quota' });
  const firstImage = await writeAsset(session.id, await sharp({
    create: { width: 3, height: 2, channels: 3, background: '#113355' }
  }).png().toBuffer(), 'image/png');
  resetSessionStoreForTests();
  initSessionStore(directory);
  const realStat = fs.stat.bind(fs);
  let oversizedImage = firstImage.id;
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (String(file) === path.join(directory, 'sessions', session.id, 'assets', oversizedImage)) {
      Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES });
    }
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const quotaWarnings = () => warned.mock.calls.filter(([line]) => String(line).includes('overflow text not stored: Session asset quota exceeded'));

  expect(await writeOverflowText(session.id, 'refused before cleanup')).toBeNull();
  expect(await writeOverflowText(session.id, 'still refused before cleanup')).toBeNull();
  expect(quotaWarnings()).toHaveLength(1);

  stat.mockRestore();
  const cleared = await clearImageStorage('all');
  expect(cleared.removedFiles).toBe(1);
  expect(cleared.freedBytes).toBeGreaterThan(0);
  expect(await readAsset(session.id, firstImage.id)).toBeNull();
  // Cleanup frees space; the successful write, not cleanup alone, clears the latch.
  expect(await writeOverflowText(session.id, 'stored after actual cleanup')).toMatch(/\.txt$/);

  const secondImage = await writeAsset(session.id, await sharp({
    create: { width: 4, height: 3, channels: 3, background: '#775533' }
  }).png().toBuffer(), 'image/png');
  oversizedImage = secondImage.id;
  // A cold quota inventory must observe the refilled disk before testing
  // repeated refusals. Reinitialization independently resets the warning
  // latch; this test does not attribute re-arming to the cleanup itself.
  // The separate same-process test above proves successful-write re-arming.
  resetSessionStoreForTests();
  initSessionStore(directory);
  const refilled = vi.spyOn(fs, 'stat').mockImplementation(async (file, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(file, ...rest);
    if (String(file) === path.join(directory, 'sessions', session.id, 'assets', oversizedImage)) {
      Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES });
    }
    return found;
  });
  expect(await writeOverflowText(session.id, 'refused after refill')).toBeNull();
  expect(await writeOverflowText(session.id, 'still refused after refill')).toBeNull();
  expect(quotaWarnings()).toHaveLength(2);
  refilled.mockRestore();
});

it('re-arms a latched quota warning on store initialization without any successful write', async () => {
  const session = await createSession({ title: 'Restarted full recording' });
  const filler = await writeAsset(session.id, Buffer.from('existing quota filler'), 'text/plain');
  const file = path.join(directory, 'sessions', session.id, 'assets', filler.id);
  resetSessionStoreForTests(); initSessionStore(directory);
  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(candidate, ...rest);
    if (String(candidate) === file) Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES });
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const count = () => warned.mock.calls.filter(([line]) => String(line).includes('overflow text not stored: Session asset quota exceeded')).length;
  expect(await writeOverflowText(session.id, 'first denied')).toBeNull();
  expect(await writeOverflowText(session.id, 'second denied')).toBeNull();
  expect(count()).toBe(1);
  initSessionStore(directory); // No successful asset write, but startup clears the latch.
  expect(await writeOverflowText(session.id, 'denied after restart')).toBeNull();
  expect(await writeOverflowText(session.id, 'again after restart')).toBeNull();
  expect(count()).toBe(2);
  stat.mockRestore();
});

it('clears the warning latch on session deletion and usage invalidation', async () => {
  const session = await createSession({ title: 'Removed full recording' });
  const filler = await writeAsset(session.id, Buffer.from('old file'), 'text/plain');
  const file = path.join(directory, 'sessions', session.id, 'assets', filler.id);
  resetSessionStoreForTests(); initSessionStore(directory);
  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(candidate, ...rest);
    if (String(candidate) === file) Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES });
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const count = () => warned.mock.calls.filter(([line]) => String(line).includes('overflow text not stored: Session asset quota exceeded')).length;
  expect(await writeOverflowText(session.id, 'before deletion')).toBeNull();
  expect(count()).toBe(1);
  await deleteSession(session.id); // Calls invalidateAssetUsage(session.id).
  // Recreate a pre-existing full asset on disk without writeAsset: that API itself
  // clears the latch and would conceal whether deletion invalidated the old one.
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'old file');
  expect(await writeOverflowText(session.id, 'after deletion and disk restoration')).toBeNull();
  expect(await writeOverflowText(session.id, 'still full again')).toBeNull();
  expect(count()).toBe(2);
  stat.mockRestore();
});

it('does not log a per-session refusal when overflow text hits the global quota', async () => {
  const filler = await createSession({ title: 'Globally full old session' });
  const current = await createSession({ title: 'New session under global quota' });
  const asset = await writeAsset(filler.id, Buffer.from('old global filler'), 'text/plain');
  resetSessionStoreForTests(); initSessionStore(directory);
  const realStat = fs.stat.bind(fs);
  const file = path.join(directory, 'sessions', filler.id, 'assets', asset.id);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(candidate, ...rest);
    if (String(candidate) === file) Object.defineProperty(found, 'size', { value: MAX_GLOBAL_ASSET_BYTES });
    return found;
  });
  const fullChanges: boolean[] = [];
  const stop = onRecordingStorageFullChange(() => fullChanges.push(recordingStorageFull()));
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  expect(await writeOverflowText(current.id, 'first global quota refusal')).toBeNull();
  expect(await writeOverflowText(current.id, 'second global quota refusal')).toBeNull();
  expect(recordingStorageFull()).toBe(true);
  expect(fullChanges).toEqual([true]);
  expect(warned.mock.calls.filter(([line]) => /recording storage is full/i.test(String(line)))).toHaveLength(1);
  expect(warned.mock.calls.filter(([line]) => /overflow text not stored/i.test(String(line)))).toHaveLength(0);
  stop();
  stat.mockRestore();
});

it('serializes concurrent refusals for two full sessions into one warning each', async () => {
  const first = await createSession({ title: 'Parallel full session A' });
  const second = await createSession({ title: 'Parallel full session B' });
  const a = await writeAsset(first.id, Buffer.from('parallel A'), 'text/plain');
  const b = await writeAsset(second.id, Buffer.from('parallel B'), 'text/plain');
  resetSessionStoreForTests(); initSessionStore(directory);
  const files = new Set([a.id && path.join(directory, 'sessions', first.id, 'assets', a.id),
    b.id && path.join(directory, 'sessions', second.id, 'assets', b.id)]);
  const realStat = fs.stat.bind(fs);
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...rest) => {
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(candidate, ...rest);
    if (files.has(String(candidate))) Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES });
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  expect(await Promise.all([
    writeOverflowText(first.id, 'parallel a1'), writeOverflowText(second.id, 'parallel b1'),
    writeOverflowText(first.id, 'parallel a2'), writeOverflowText(second.id, 'parallel b2')
  ])).toEqual([null, null, null, null]);
  const warnings = warned.mock.calls.filter(([line]) => String(line).includes('overflow text not stored: Session asset quota exceeded'));
  expect(warnings.filter(([line]) => String(line).includes(first.id))).toHaveLength(1);
  expect(warnings.filter(([line]) => String(line).includes(second.id))).toHaveLength(1);
  stat.mockRestore();
});

it('orders a successful write between queued full-session refusals', async () => {
  const session = await createSession({ title: 'Queued quota intervals' });
  const filler = await writeAsset(session.id, Buffer.from('queued seed'), 'text/plain');
  resetSessionStoreForTests(); initSessionStore(directory);
  const file = path.join(directory, 'sessions', session.id, 'assets', filler.id);
  const realStat = fs.stat.bind(fs);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  let blocked = false;
  const stat = vi.spyOn(fs, 'stat').mockImplementation(async (candidate, ...rest) => {
    if (!blocked && String(candidate).includes(path.join('sessions', session.id, 'assets')) && String(candidate) !== file) {
      blocked = true;
      firstEntered();
      await held;
    }
    const found = await (realStat as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof fs.stat>>>)(candidate, ...rest);
    if (String(candidate) === file) Object.defineProperty(found, 'size', { value: MAX_SESSION_ASSET_BYTES - 20 });
    return found;
  });
  const warned = vi.spyOn(logger, 'logWarn').mockImplementation(() => undefined);
  const first = writeOverflowText(session.id, 'first queued refusal exceeds capacity');
  await entered; // The first queued operation is held inside I/O, not by a timer.
  const middle = writeOverflowText(session.id, 'ok');
  const last = writeOverflowText(session.id, 'second queued refusal exceeds capacity');
  releaseFirst();
  const [refused, stored, again] = await Promise.all([first, middle, last]);
  expect(refused).toBeNull();
  expect(stored).toMatch(/\.txt$/);
  expect(again).toBeNull();
  expect(warned.mock.calls.filter(([line]) => String(line).includes('overflow text not stored: Session asset quota exceeded'))).toHaveLength(2);
  stat.mockRestore();
});
