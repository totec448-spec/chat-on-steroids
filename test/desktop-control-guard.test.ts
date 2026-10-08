import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  config: { ui: { desktopControlGuard: false } },
  call: {
    agent: null as string | null,
    caller: { sessionId: 'session-1', conversationId: 'conversation-1', requestId: 'request-1', transportKey: 'transport-1' },
    activity: { title: 'Clicked in a window', kind: 'tool' }
  },
  warnings: [] as string[],
  sessionTitle: 'Fixture chat'
}));

vi.mock('../src/main/config.js', () => ({ getConfig: () => fixture.config }));
vi.mock('../src/main/logger.js', () => ({
  logWarn: (message: string) => { fixture.warnings.push(message); }
}));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => fixture.call }));
vi.mock('../src/main/session/store.js', () => ({
  getSession: vi.fn(async () => ({ title: fixture.sessionTitle }))
}));

import {
  DESKTOP_CONTROL_GUARD_TIMEOUT_MS,
  admitDesktopControl,
  clearDesktopControlGuardBlocks,
  desktopControlGuardEnabled,
  finishDesktopControlGuard,
  setDesktopControlGuardPresenter,
  type DesktopControlGuardPresenter,
  type DesktopControlGuardRequest
} from '../src/main/desktop-control-guard.js';

beforeEach(() => {
  fixture.config.ui.desktopControlGuard = false;
  fixture.call.agent = null;
  fixture.call.caller = { sessionId: 'session-1', conversationId: 'conversation-1', requestId: 'request-1', transportKey: 'transport-1' };
  fixture.sessionTitle = 'Fixture chat';
  fixture.warnings.length = 0;
  clearDesktopControlGuardBlocks();
  setDesktopControlGuardPresenter(null);
});

afterEach(() => {
  vi.useRealTimers();
  clearDesktopControlGuardBlocks();
  setDesktopControlGuardPresenter(null);
});

describe('Desktop control guard', () => {
  it('is off unless the user explicitly enables it', () => {
    expect(desktopControlGuardEnabled()).toBe(false);
    fixture.config.ui.desktopControlGuard = true;
    expect(desktopControlGuardEnabled()).toBe(true);
  });

  it('fails closed when the notice host never completes', async () => {
    vi.useFakeTimers();
    setDesktopControlGuardPresenter({
      prompt: () => new Promise(() => undefined)
    });

    const pending = admitDesktopControl('click');
    await vi.advanceTimersByTimeAsync(DESKTOP_CONTROL_GUARD_TIMEOUT_MS);
    const result = await pending;

    expect(result).toEqual({
      allowed: false,
      reason: 'DESKTOP_GUARD_FAILED: The desktop control guard did not complete safely. No input ran.'
    });
    expect(fixture.warnings.some(message => message.includes('timed out'))).toBe(true);
  });

  it('blocks the exact worker after Stop and exposes an immediate allow-again action', async () => {
    fixture.call.agent = 'worker-2';
    const blocked = vi.fn();
    let allowAgain: (() => void) | null = null;
    const prompt = vi.fn<DesktopControlGuardPresenter['prompt']>().mockResolvedValueOnce('stop').mockResolvedValue('allow');
    setDesktopControlGuardPresenter({
      prompt,
      blocked: (request, allow) => { blocked(request); allowAgain = allow; }
    });

    const first = await admitDesktopControl('type_text');
    expect(first.allowed).toBe(false);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(blocked.mock.calls[0]![0]).toMatchObject({ ownerKey: 'agent:worker-2', label: 'Worker 2' });

    const second = await admitDesktopControl('click');
    expect(second.allowed).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(blocked).toHaveBeenCalledTimes(2);

    expect(allowAgain).not.toBeNull();
    allowAgain!();
    const third = await admitDesktopControl('click');
    expect(third.allowed).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('uses the bounded activity summary and chat title without exposing tool arguments', async () => {
    let request: DesktopControlGuardRequest | null = null;
    setDesktopControlGuardPresenter({
      prompt: async value => { request = value; return 'allow'; }
    });

    const result = await admitDesktopControl('type_text');

    expect(result.allowed).toBe(true);
    expect(request).toMatchObject({
      ownerKey: 'session:session-1',
      label: 'Chat “Fixture chat”',
      operation: 'type_text',
      description: 'Clicked in a window'
    });
  });

  it('never lets a post-operation hook failure rewrite a completed native result', async () => {
    const request: DesktopControlGuardRequest = {
      ownerKey: 'session:session-1', label: 'This chat', operation: 'click',
      description: 'Clicked in a window', countdownMs: 10_000
    };
    setDesktopControlGuardPresenter({
      prompt: async () => 'allow',
      settled: () => { throw new Error('post-hook exploded'); }
    });

    expect(() => finishDesktopControlGuard({ allowed: true, request }, 'success')).not.toThrow();
    expect(fixture.warnings.some(message => message.includes('post-hook exploded'))).toBe(true);

    fixture.warnings.length = 0;
    setDesktopControlGuardPresenter({
      prompt: async () => 'allow',
      settled: async () => { throw new Error('post-hook rejected'); }
    });
    finishDesktopControlGuard({ allowed: true, request }, 'success');
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.warnings.some(message => message.includes('post-hook rejected'))).toBe(true);
  });
});
