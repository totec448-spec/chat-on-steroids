import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wake = vi.hoisted(() => vi.fn());
vi.mock('../src/main/browser-wake.js', () => ({ wakeBrowserWork: wake }));

const { ROUTE_SETTLE_MS, noteTunnelClientConnected, resetRouteSettleForTests, tunnelRouteSettling, tunnelRouteSettlingUntil } =
  await import('../src/main/tunnel/route-settle.js');

beforeEach(() => {
  vi.useFakeTimers();
  wake.mockClear();
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
