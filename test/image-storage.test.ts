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
  resetSessionStoreForTests,
  upsertMessageEvent,
  upsertNativeImageEvent,
  writeAsset
} from '../src/main/session/store.js';

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
