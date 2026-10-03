import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
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
  it('trusts and untrusts only the exact conversation', () => {
    setChatTrusted(TRUSTED, true);
    expect(isChatTrusted(TRUSTED)).toBe(true);
    expect(isChatTrusted(OTHER)).toBe(false);
    expect(isChatTrusted(null)).toBe(false);
    setChatTrusted(TRUSTED, false);
    expect(trustedChatIds()).toEqual([]);
  });

  it('survives restart without inventing trust for invalid durable entries', async () => {
    setChatTrusted(TRUSTED, true);
    await flushDurable();
    resetTrustedChatsForTests();
    await restoreTrustedChats();
    expect(trustedChatIds()).toEqual([TRUSTED]);

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

  it('is bounded without silently evicting older trusted chats', () => {
    for (let index = 0; index < 200; index++) {
      setChatTrusted(`conv-trusted-${String(index).padStart(4, '0')}`, true);
    }
    expect(trustedChatIds()).toHaveLength(200);
    expect(() => setChatTrusted(TRUSTED, true)).toThrow(/too many trusted chats/i);
    expect(isChatTrusted('conv-trusted-0000')).toBe(true);
  });
});
