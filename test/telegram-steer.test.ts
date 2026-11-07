import { describe, expect, it, vi } from 'vitest';
import { steerFromTelegram, type SteerDeps } from '../src/main/telegram-steer.js';

// Telegram phase 2 (2026-10-31): a reply as the person's message, only behind its own switch.
describe('a reply from Telegram as a message for a chat', () => {
  const deps = (over: Partial<SteerDeps> = {}) => {
    const send = vi.fn(async (input: any) => ({ ...input, state: 'queued' }) as any);
    const log = vi.fn();
    return { send, log, deps: { allowed: () => true, session: async () => ({ conversationId: 'c1', activeTurnId: null, origin: null }),
      followUpQueues: () => false, send, log, ...over } as SteerDeps };
  };

  it('sends nothing with the switch off', async () => {
    const { deps: d, send } = deps({ allowed: () => false });
    expect(await steerFromTelegram(d, 's1', 'hello')).toBe('off');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([['a worker', { conversationId: 'c1', origin: { kind: 'worker' } }], ['a helper', { conversationId: 'c1', origin: { kind: 'helper' } }],
    ['a chat with no ChatGPT chat', { conversationId: null }], ['a missing chat', null]] as const)('refuses %s', async (_name, session) => {
    const { deps: d, send } = deps({ session: async () => session as never });
    expect(await steerFromTelegram(d, 's1', 'hello')).toBe('refused');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends through the composer path as the person\'s words, trimmed', async () => {
    const { deps: d, send, log } = deps();
    expect(await steerFromTelegram(d, 's1', '  run the tests  ')).toBe('sent');
    // Marked as from Telegram, so the chat shows where it came from (Haz on #1990).
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', text: 'run the tests', mode: 'auto', authoredSource: 'text', model: null, via: 'telegram' }));
    expect(log.mock.calls.join('\n')).not.toContain('run the tests');
  });

  it('follows the app\'s follow-up choice while the chat works', async () => {
    const queueing = deps({ session: async () => ({ conversationId: 'c1', activeTurnId: 't1' }), followUpQueues: () => true });
    expect(await steerFromTelegram(queueing.deps, 's1', 'next')).toBe('queued');
    expect(queueing.send).toHaveBeenCalledWith(expect.objectContaining({ mode: 'after-turn' }));
    const steering = deps({ session: async () => ({ conversationId: 'c1', activeTurnId: 't1' }), followUpQueues: () => false });
    expect(await steerFromTelegram(steering.deps, 's1', 'next')).toBe('sent');
    expect(steering.send).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }));
  });

  it('says when the outbox refused or failed it', async () => {
    expect(await steerFromTelegram(deps({ send: async () => { throw new Error('busy'); } }).deps, 's1', 'x')).toBe('failed');
    expect(await steerFromTelegram(deps({ send: async (input: any) => ({ ...input, state: 'failed' }) as any }).deps, 's1', 'x')).toBe('failed');
    expect(await steerFromTelegram(deps().deps, 's1', '   ')).toBe('refused');
  });
});
