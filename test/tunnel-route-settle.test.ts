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
