import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initDurableStore, readDurable, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { acknowledgeChatgptPermissionNotice, getChatgptPermissionNotice, requestChatgptPermissionNotice,
  resetChatgptPermissionNoticeForTests } from '../src/main/chatgpt-permission-notice.js';
import { rawPromises as rawfs } from '../src/main/rawfs.js';

let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('permission-notice');
  initDurableStore(directory);
  resetChatgptPermissionNoticeForTests();
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetChatgptPermissionNoticeForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('retains a requested notice across restart and permanently dismisses it only after acknowledgement', async () => {
  const initial = await getChatgptPermissionNotice();
  expect(initial.pending).toBe(false);
  const first = await requestChatgptPermissionNotice();
  expect(first.pending).toBe(true);
  expect(first.revision).toBeGreaterThan(initial.revision);
  expect(await requestChatgptPermissionNotice()).toEqual(first);
  resetChatgptPermissionNoticeForTests();
  expect((await getChatgptPermissionNotice()).pending).toBe(true);
  expect((await acknowledgeChatgptPermissionNotice()).pending).toBe(false);
  expect(await readDurable('chatgpt-permission-notice')).toEqual({ requested: true, acknowledged: true });
  resetChatgptPermissionNoticeForTests();
  expect((await requestChatgptPermissionNotice()).pending).toBe(false);
});

it('serializes concurrent opening and dismissal so a delayed request cannot resurrect an acknowledged notice', async () => {
  const [requested, acknowledged, late] = await Promise.all([
    requestChatgptPermissionNotice(), acknowledgeChatgptPermissionNotice(), requestChatgptPermissionNotice()
  ]);
  expect(requested.pending).toBe(true);
  expect(acknowledged.pending).toBe(false);
  expect(late).toEqual(acknowledged);
});

it('keeps the notice pending when acknowledgement cannot be committed', async () => {
  await requestChatgptPermissionNotice();
  const write = vi.spyOn(rawfs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(acknowledgeChatgptPermissionNotice()).rejects.toThrow('disk unavailable');
  expect((await getChatgptPermissionNotice()).pending).toBe(true);
  write.mockRestore();
  expect((await acknowledgeChatgptPermissionNotice()).pending).toBe(false);
});

it('still presents guidance when saving the initial optional reminder fails', async () => {
  vi.spyOn(rawfs, 'writeFile').mockRejectedValueOnce(new Error('disk unavailable'));
  expect((await requestChatgptPermissionNotice()).pending).toBe(true);
  expect((await getChatgptPermissionNotice()).pending).toBe(true);
});
