import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wake = vi.hoisted(() => vi.fn());
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));
const log = vi.hoisted(() => vi.fn());
vi.mock('../src/main/logger.js', async (original) => ({ ...await original<typeof import('../src/main/logger.js')>(), logInfo: log }));
const durable = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock('../src/main/durable.js', () => ({
  readDurable: async (name: string) => durable.store.get(name) ?? null,
  writeDurableSoon: (name: string, value: unknown) => { durable.store.set(name, structuredClone(value)); }
}));

const { ROUTE_SETTLE_MS, noteTunnelClientConnected, resetRouteSettleForTests, tunnelRouteSettling, tunnelRouteSettlingUntil,
  routeHoldMs, noteRouteExistingChatSend, noteRouteRequestSighted, noteRouteRequestArrived, restoreRouteHold } =
  await import('../src/main/tunnel/route-settle.js');

beforeEach(() => {
  vi.useFakeTimers();
  wake.mockClear();
  log.mockClear();
  durable.store.clear();
  resetRouteSettleForTests();
});
afterEach(() => {
  resetRouteSettleForTests();
  vi.useRealTimers();
});

describe('a new tunnel-client takes over existing chats (#1220)', () => {
  it('holds existing chats until the new client has been connected long enough, then wakes the browser once', async () => {
    expect(tunnelRouteSettling()).toBe(false);
    expect(tunnelRouteSettlingUntil()).toBeNull();
    noteTunnelClientConnected();
    expect(tunnelRouteSettling()).toBe(true);
    expect(tunnelRouteSettlingUntil(), 'the chat shows why the message waits, and until when').toBe(Date.now() + ROUTE_SETTLE_MS);
    await vi.advanceTimersByTimeAsync(ROUTE_SETTLE_MS - 1);
    expect(tunnelRouteSettling()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tunnelRouteSettling()).toBe(false);
    expect(tunnelRouteSettlingUntil()).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  // #1788, measured on the Mac on 2026-10-22: sent 12 s after the new client connected, about half
  // the calls from an existing chat still waited ~128 s; at 22 s, 2 of 3; at 32 s and 47 s, 0 of 6.
  it('holds existing chats for longer than the 32 s the Mac measurably needs', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(tunnelRouteSettling()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
  });

  it('runs to the later of two clients, since core and desktop each start one', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(5_000);
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(ROUTE_SETTLE_MS - 1);
    expect(tunnelRouteSettling()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tunnelRouteSettling()).toBe(false);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

/**
 * #1788: how long OpenAI keeps an existing chat on the previous tunnel-client differs by computer
 * and over time (Windows 9–10 s in October, the Mac 22–32 s on 2026-10-22). The page sees the call's
 * request id within seconds even when the call itself arrives ~124 s later, so the gap between the
 * two measures the route, not the model's thinking.
 */
describe('the hold learns from what happened after each new tunnel-client', () => {
  /** One restart: connect, hold, send to an existing chat, ChatGPT shows the call, the call arrives after `gapMs`. */
  const restart = async (gapMs: number, conversationId = 'existing-chat', requestId = `req-${Math.random()}`): Promise<void> => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(routeHoldMs());
    noteRouteExistingChatSend(conversationId);
    await vi.advanceTimersByTimeAsync(2_000);
    noteRouteRequestSighted(requestId, conversationId);
    await vi.advanceTimersByTimeAsync(gapMs);
    noteRouteRequestArrived(requestId);
  };

  it('starts at 35 s', () => {
    expect(routeHoldMs()).toBe(ROUTE_SETTLE_MS);
    expect(ROUTE_SETTLE_MS).toBe(35_000);
  });

  it('holds longer after a call that still took the old route, up to 90 s, and saves it', async () => {
    await restart(124_000);
    expect(routeHoldMs()).toBeGreaterThanOrEqual(50_000);
    expect(durable.store.get('route-hold')).toMatchObject({ version: 1, holdMs: routeHoldMs() });
    for (let i = 0; i < 6; i++) await restart(124_000);
    expect(routeHoldMs()).toBe(90_000);
  });

  it('shortens only after three fast restarts in a row, by 5 s, never below 12 s', async () => {
    await restart(3_000); await restart(4_000);
    expect(routeHoldMs(), 'two fast samples are not yet a pattern').toBe(35_000);
    await restart(5_000);
    expect(routeHoldMs()).toBe(30_000);
    for (let i = 0; i < 30; i++) await restart(3_000);
    expect(routeHoldMs()).toBe(12_000);
  });

  it('a late call resets the fast streak', async () => {
    await restart(3_000); await restart(3_000);
    await restart(124_000);
    const after = routeHoldMs();
    await restart(3_000); await restart(3_000);
    expect(routeHoldMs(), 'the streak started over after the late call').toBe(after);
  });

  it('counts a call that arrived before the page showed it as fast', async () => {
    for (let i = 0; i < 3; i++) {
      noteTunnelClientConnected();
      await vi.advanceTimersByTimeAsync(routeHoldMs());
      noteRouteExistingChatSend('existing-chat');
      noteRouteRequestArrived(`early-${i}`);
      await vi.advanceTimersByTimeAsync(500);
      noteRouteRequestSighted(`early-${i}`, 'existing-chat');
    }
    expect(routeHoldMs()).toBe(30_000);
  });

  it('ignores new chats, other chats and an in-between gap', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(routeHoldMs());
    // A new chat is routed to the new client at once; its quick call says nothing about the hold.
    noteRouteRequestSighted('new-chat-req', 'brand-new-chat');
    noteRouteRequestArrived('new-chat-req');
    noteRouteExistingChatSend('existing-chat');
    noteRouteRequestSighted('other-req', 'another-chat');
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('other-req');
    expect(routeHoldMs()).toBe(35_000);
    await restart(45_000);
    expect(routeHoldMs(), 'between fast and late: no change').toBe(35_000);
  });

  it('measures a send made inside the window even when its late call arrives after it', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 50_000);
    noteRouteExistingChatSend('existing-chat');
    noteRouteRequestSighted('edge-of-window', 'existing-chat');
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('edge-of-window');
    expect(routeHoldMs()).toBeGreaterThan(35_000);
  });

  it('measures only the first message after a restart, even if a later one calls first', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(routeHoldMs());
    noteRouteExistingChatSend('first-chat');
    await vi.advanceTimersByTimeAsync(20_000);
    noteRouteExistingChatSend('later-chat');
    // The later chat's call comes fast; it had more time and says nothing about the hold.
    noteRouteRequestSighted('later-req', 'later-chat');
    noteRouteRequestArrived('later-req');
    expect(routeHoldMs()).toBe(35_000);
    noteRouteRequestSighted('first-req', 'first-chat');
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('first-req');
    expect(routeHoldMs(), 'the first message decides').toBeGreaterThan(35_000);
  });

  it('starts the fast streak over after a gap between fast and late', async () => {
    await restart(3_000); await restart(3_000);
    await restart(45_000);
    await restart(3_000); await restart(3_000);
    expect(routeHoldMs(), 'only consecutive fast restarts count').toBe(35_000);
    expect(durable.store.get('route-hold')).toMatchObject({ fastStreak: 2 });
  });

  it('ignores a call of a request ChatGPT created before the measured message was sent', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(routeHoldMs());
    noteRouteExistingChatSend('existing-chat');
    // A turn that was already running when the message went in: its request is older than the send.
    noteRouteRequestSighted('older-req', 'existing-chat', Date.now(), Date.now() - 60_000);
    noteRouteRequestSighted('older-req-2', 'existing-chat', Date.now(), Date.now() - 50_000);
    // Said once per measurement, however many calls that running turn makes.
    expect(log.mock.calls.filter(([line]) => String(line).includes('started before'))).toEqual([[
      'route hold: not measuring calls ChatGPT started before this chat\'s message went out (a turn that was already running); waiting for the message\'s own call'
    ]]);
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('older-req');
    expect(routeHoldMs(), 'an older request says nothing about this restart').toBe(35_000);
    // The message's own request, created after it was sent (within ChatGPT's clock skew), still counts.
    noteRouteRequestSighted('own-req', 'existing-chat', Date.now(), Date.now() - 5_000);
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('own-req');
    expect(routeHoldMs()).toBeGreaterThan(35_000);
  });

  it('measures once per new tunnel-client', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(routeHoldMs());
    for (const chat of ['a', 'b']) {
      noteRouteExistingChatSend(chat);
      noteRouteRequestSighted(`req-${chat}`, chat);
    }
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('req-a');
    const once = routeHoldMs();
    noteRouteRequestArrived('req-b');
    expect(routeHoldMs()).toBe(once);
  });

  it('does not measure sends long after the client connected', async () => {
    noteTunnelClientConnected();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    noteRouteExistingChatSend('existing-chat');
    noteRouteRequestSighted('late-send', 'existing-chat');
    await vi.advanceTimersByTimeAsync(124_000);
    noteRouteRequestArrived('late-send');
    expect(routeHoldMs()).toBe(35_000);
  });

  it('restores a saved hold, and refuses damaged or out-of-range values', async () => {
    durable.store.set('route-hold', { version: 1, holdMs: 53_000, fastStreak: 2 });
    await restoreRouteHold();
    expect(routeHoldMs()).toBe(53_000);
    noteTunnelClientConnected();
    expect(tunnelRouteSettlingUntil()).toBe(Date.now() + 53_000);
    for (const bad of [{ version: 1, holdMs: 5_000 }, { version: 1, holdMs: 900_000 }, { version: 2, holdMs: 40_000 }, { holdMs: 'x' }, 'junk']) {
      resetRouteSettleForTests();
      durable.store.set('route-hold', bad);
      await restoreRouteHold();
      expect(routeHoldMs(), JSON.stringify(bad)).toBe(35_000);
    }
  });
});
