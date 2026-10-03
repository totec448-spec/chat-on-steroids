import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  isChatTrusted,
  resetTrustedChatsForTests,
  restoreTrustedChats,
  setChatTrusted,
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

  it('is bounded without silently evicting older trusted chats', async () => {
    for (let index = 0; index < 200; index++) {
      await setChatTrusted(`conv-trusted-${String(index).padStart(4, '0')}`, true);
    }
    expect(trustedChatIds()).toHaveLength(200);
    await expect(setChatTrusted(TRUSTED, true)).rejects.toThrow(/too many trusted chats/i);
    expect(isChatTrusted('conv-trusted-0000')).toBe(true);
  });
});
