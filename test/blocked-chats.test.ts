/**
 * The block registry on its own: what survives a restart, and what a second press does.
 *
 * The fence itself — that a blocked conversation's tool calls are actually refused over real
 * HTTP, and that nobody else's are — is proved end to end in `mcp.test.ts`. What is left here
 * is the part a rogue turn outlives: the block has to still be there after the app is
 * restarted, because the turn can be.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  BLOCKED_CHAT_REFUSAL,
  blockedChatIds,
  isChatBlocked,
  resetBlockedChatsForTests,
  restoreBlockedChats,
  setChatBlocked
} from '../src/main/session/blocked-chats.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const ROGUE = 'conv-rogue-turn-01';
const OTHER = 'conv-other-chat-01';

let dir: string;

beforeEach(async () => {
  resetBlockedChatsForTests();
  resetDurableForTests();
  dir = await makeTempDir('clf-blocked-');
  initDurableStore(dir);
});

afterAll(async () => {
  resetBlockedChatsForTests();
  resetDurableForTests();
  if (dir) await removeTempDir(dir);
});

describe('blocked chats', () => {
  it('blocks and releases exactly the conversation it was told about', () => {
    setChatBlocked(ROGUE, true);
    expect(isChatBlocked(ROGUE)).toBe(true);
    expect(isChatBlocked(OTHER)).toBe(false);
    // Unattributed work has no conversation, so it can never be the blocked one.
    expect(isChatBlocked(null)).toBe(false);
    expect(isChatBlocked(undefined)).toBe(false);

    setChatBlocked(ROGUE, false);
    expect(isChatBlocked(ROGUE)).toBe(false);
    expect(blockedChatIds()).toEqual([]);
  });

  it('is idempotent in both directions, so a double press cannot resurrect a release', () => {
    setChatBlocked(ROGUE, true);
    setChatBlocked(ROGUE, true);
    expect(blockedChatIds()).toEqual([ROGUE]);

    setChatBlocked(ROGUE, false);
    setChatBlocked(ROGUE, false);
    expect(blockedChatIds()).toEqual([]);
  });

  it('survives a restart, because the turn it stopped can survive one too', async () => {
    setChatBlocked(ROGUE, true);
    await flushDurable();

    // A fresh process: same state directory, empty registry.
    resetBlockedChatsForTests();
    expect(isChatBlocked(ROGUE)).toBe(false);
    await restoreBlockedChats();
    expect(isChatBlocked(ROGUE)).toBe(true);
    expect(isChatBlocked(OTHER)).toBe(false);
  });

  it('does not restore a release, and does not restore a junk id', async () => {
    setChatBlocked(ROGUE, true);
    setChatBlocked(OTHER, true);
    setChatBlocked(ROGUE, false);
    await flushDurable();

    resetBlockedChatsForTests();
    await restoreBlockedChats();
    expect(blockedChatIds()).toEqual([OTHER]);

    expect(() => setChatBlocked('nope', true)).toThrow(/conversation id/i);
    expect(() => setChatBlocked('has spaces and !', true)).toThrow(/conversation id/i);
    expect(blockedChatIds()).toEqual([OTHER]);
  });

  it('tells the model to stop rather than merely that it failed', () => {
    // A bare failure is an invitation to retry, and a rogue turn retrying is the problem.
    expect(BLOCKED_CHAT_REFUSAL).toContain('CHAT_BLOCKED');
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/no tool was run/i);
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/no further tool calls/i);
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/final answer/i);
    expect(BLOCKED_CHAT_REFUSAL).toMatch(/the user explicitly asked for this/i);
  });

  it('refuses to grow without bound rather than silently unblocking the oldest chat', () => {
    for (let index = 0; index < 200; index++) setChatBlocked(`conv-bulk-${String(index).padStart(4, '0')}`, true);
    expect(blockedChatIds()).toHaveLength(200);
    expect(() => setChatBlocked(ROGUE, true)).toThrow(/too many blocked chats/i);
    // The chat that was already stopped is still stopped.
    expect(isChatBlocked('conv-bulk-0000')).toBe(true);
  });
});
