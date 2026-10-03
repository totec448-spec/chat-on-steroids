import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  isChatTrusted,
  resetTrustedChatsForTests,
  restoreTrustedChats,
  setChatTrusted,
  setChatsTrusted,
  trustedChatIds
} from '../src/main/session/trusted-chats.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const TRUSTED = 'conv-trusted-chat-01';
const OTHER = 'conv-other-chat-01';
let dir: string;

beforeEach(async () => {
  resetTrustedChatsForTests();
  resetDurableForTests();
  dir = await makeTempDir('clf-trusted-');
  initDurableStore(dir);
});

afterAll(async () => {
  resetTrustedChatsForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

describe('trusted chats', () => {
  it('trusts and untrusts only the exact conversation', async () => {
    await setChatTrusted(TRUSTED, true);
    expect(isChatTrusted(TRUSTED)).toBe(true);
    expect(isChatTrusted(OTHER)).toBe(false);
    expect(isChatTrusted(null)).toBe(false);
    await setChatTrusted(TRUSTED, false);
    expect(trustedChatIds()).toEqual([]);
  });

  it('is durable before trust or revoke resolves, without a later flush', async () => {
    await setChatTrusted(TRUSTED, true);
    resetTrustedChatsForTests();
    await restoreTrustedChats();
    expect(trustedChatIds()).toEqual([TRUSTED]);

    await setChatTrusted(TRUSTED, false);
    resetTrustedChatsForTests();
    await restoreTrustedChats();
    expect(trustedChatIds()).toEqual([]);
  });

  it('revokes a committed trust lineage atomically in one durable mutation', async () => {
    await setChatTrusted(TRUSTED, true);
    await setChatTrusted(OTHER, true);
    await setChatsTrusted([TRUSTED, OTHER, TRUSTED], false);
    expect(trustedChatIds()).toEqual([]);

    resetTrustedChatsForTests();
    await restoreTrustedChats();
    expect(trustedChatIds()).toEqual([]);
  });

  it('does not invent trust for invalid durable entries', async () => {
    resetTrustedChatsForTests();

    await writeDurableNow('trusted-chats', { version: 1, entries: [OTHER, 'bad ! id'] });
    await restoreTrustedChats();
    expect(trustedChatIds()).toEqual([OTHER]);
  });

  it('fails closed on an unknown durable version', async () => {
    await writeDurableNow('trusted-chats', { version: 999, entries: [TRUSTED] });
    await restoreTrustedChats();
    expect(trustedChatIds()).toEqual([]);
  });

  it('supersedes a failed Trust generation so a later retry cannot grant rejected permission', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('simulated durable failure'), { code: 'EIO' }));
    try {
      await expect(setChatTrusted(TRUSTED, true)).rejects.toThrow(/simulated durable failure/i);
      expect(isChatTrusted(TRUSTED)).toBe(false);

      // writeDurableNow retains failed state for retry. The trust registry must already have
      // superseded that proposal with the still-authoritative empty set before retry/quit flush.
      await flushDurable();
      resetTrustedChatsForTests();
      await restoreTrustedChats();
      expect(isChatTrusted(TRUSTED)).toBe(false);
      expect(trustedChatIds()).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  it('is bounded without silently evicting older trusted chats', async () => {
    for (let index = 0; index < 200; index++) {
      await setChatTrusted(`conv-trusted-${String(index).padStart(4, '0')}`, true);
    }
    expect(trustedChatIds()).toHaveLength(200);
    await expect(setChatTrusted(TRUSTED, true)).rejects.toThrow(/too many trusted chats/i);
    expect(isChatTrusted('conv-trusted-0000')).toBe(true);
  });
});
